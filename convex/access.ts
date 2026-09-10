import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ADMIN_EMAIL, norm, sessionOf, type DbCtx } from "./lib";

async function requireAdmin(ctx: DbCtx, token: string) {
  const s = await sessionOf(ctx, token);
  if (!s || s.email !== ADMIN_EMAIL) throw new ConvexError("Only the admin can manage access.");
  return s;
}

export const list = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.id("access"), email: v.string() })),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    if (!s || s.email !== ADMIN_EMAIL) return []; // non-admins see nothing
    const rows = await ctx.db.query("access").take(500);
    return rows
      .map((r) => ({ id: r._id, email: r.email }))
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});

export const add = mutation({
  args: { token: v.string(), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const email = norm(args.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConvexError("Enter a valid email address.");
    if (email === ADMIN_EMAIL) throw new ConvexError("That's you — you're always allowed.");
    const dup = await ctx.db
      .query("access")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (dup) throw new ConvexError("Already on the list.");
    await ctx.db.insert("access", { email, addedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("access") },
  returns: v.null(),
  handler: async (ctx, { token, id }) => {
    await requireAdmin(ctx, token);
    const row = await ctx.db.get(id);
    if (!row) return null;
    await ctx.db.delete(id);
    // Revoke the removed person's signed-in devices and any pending sign-in codes.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .take(50);
    for (const s of sessions) await ctx.db.delete(s._id);
    const otps = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .take(50);
    for (const o of otps) await ctx.db.delete(o._id);
    return null;
  },
});
