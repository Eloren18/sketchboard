import { ConvexError, v } from "convex/values";
import { action, env, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ADMIN_EMAIL,
  OTP_DAILY_CAP,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  SESSION_MAX_AGE_MS,
  isAllowed,
  norm,
  randomToken,
  sessionOf,
  sha256Hex,
} from "./lib";

/* ===== sign-in: email a 6-digit code (invite-only, throttled) ===== */

export const requestCode = action({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = norm(args.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConvexError("Enter a valid email address.");

    // 6-digit code from a CSPRNG.
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const code = String(100000 + (a[0] % 900000));
    const codeHash = await sha256Hex(email + ":" + code);
    // One round trip: checks the invite list and the throttle, then stores the code.
    await ctx.runMutation(internal.auth.storeCode, { email, codeHash });

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        from: "Sketchboard <onboarding@resend.dev>",
        to: [email],
        subject: `${code} is your Sketchboard sign-in code`,
        text: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
      }),
    });
    if (!r.ok) {
      console.error("Resend error", r.status, await r.text());
      throw new ConvexError("Couldn't send the email — try again in a minute.");
    }
    return null;
  },
});

export const storeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, codeHash }) => {
    if (!(await isAllowed(ctx, email))) throw new ConvexError("This app is invite-only — that email isn't on the access list.");
    const now = Date.now();
    // Bounded: at most OTP_DAILY_CAP live rows per address plus a few stale ones.
    const existing = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(50);
    const recent = existing.filter((o) => now - o.sentAt < 24 * 60 * 60 * 1000);
    if (recent.some((o) => now - o.sentAt < OTP_RESEND_COOLDOWN_MS))
      throw new ConvexError("A code was just sent — check your inbox (and spam) first.");
    if (recent.length >= OTP_DAILY_CAP)
      throw new ConvexError("Too many codes requested today — try again tomorrow.");
    // Prune rows older than the 24h counting window.
    for (const o of existing) if (now - o.sentAt >= 24 * 60 * 60 * 1000) await ctx.db.delete(o._id);
    await ctx.db.insert("otps", { email, codeHash, expiresAt: now + OTP_TTL_MS, attempts: 0, sentAt: now });
    return null;
  },
});

/* ===== verify the code → session token ===== */

export const verifyCode = action({
  args: { email: v.string(), code: v.string() },
  returns: v.object({ token: v.string(), email: v.string() }),
  handler: async (ctx, args): Promise<{ token: string; email: string }> => {
    const email = norm(args.email);
    const codeHash = await sha256Hex(email + ":" + args.code.trim());
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    await ctx.runMutation(internal.auth.consumeCode, { email, codeHash, tokenHash }); // throws on mismatch
    return { token, email };
  },
});

export const consumeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string(), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, codeHash, tokenHash }) => {
    // Re-check the invite list: access may have been revoked after the code was sent.
    if (!(await isAllowed(ctx, email))) throw new ConvexError("This app is invite-only — that email isn't on the access list.");
    const otp = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .first(); // newest code wins
    if (!otp) throw new ConvexError("No pending code — request a new one.");
    const now = Date.now();
    if (now > otp.expiresAt) {
      await ctx.db.delete(otp._id);
      throw new ConvexError("That code expired — request a new one.");
    }
    if (otp.attempts >= 5) {
      await ctx.db.delete(otp._id);
      throw new ConvexError("Too many wrong tries — request a new code.");
    }
    if (otp.codeHash !== codeHash) {
      await ctx.db.patch(otp._id, { attempts: otp.attempts + 1 });
      throw new ConvexError("That code didn't work — check it and try again.");
    }
    await ctx.db.delete(otp._id);
    await ctx.db.insert("sessions", { tokenHash, email, createdAt: now, expiresAt: now + SESSION_MAX_AGE_MS });
    // Keep at most 10 sessions per user (drop the oldest). Bounded by this cap.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(50);
    if (sessions.length > 10) {
      sessions.sort((x, y) => x.createdAt - y.createdAt);
      for (const s of sessions.slice(0, sessions.length - 10)) await ctx.db.delete(s._id);
    }
    return null;
  },
});

/* ===== session state ===== */

// Who am I? Null when the token is missing, revoked or expired (cron-swept).
export const me = query({
  args: { token: v.string() },
  returns: v.union(v.object({ email: v.string(), isAdmin: v.boolean() }), v.null()),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    return s ? { email: s.email, isAdmin: s.email === ADMIN_EMAIL } : null;
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    if (s) await ctx.db.delete(s._id);
    return null;
  },
});
