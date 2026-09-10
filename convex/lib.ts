// Shared helpers (not Convex endpoints).
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type DbCtx = QueryCtx | MutationCtx;

export const ADMIN_EMAIL = "keremladkeholland@gmail.com";
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // sign in again after ~6 months
export const OTP_TTL_MS = 1000 * 60 * 10; // codes valid 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 30_000; // min gap between two code emails
export const OTP_DAILY_CAP = 15; // max code emails per address per 24h
export const MAX_SCENE_BYTES = 900_000; // Convex documents are capped at 1 MB (UTF-8)

export const norm = (e: string) => (e || "").trim().toLowerCase();
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Is this email allowed to sign in? (admin always; others via the invite list)
export async function isAllowed(ctx: DbCtx, email: string): Promise<boolean> {
  if (email === ADMIN_EMAIL) return true;
  const row = await ctx.db
    .query("access")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
  return !!row;
}

// Returns the session row for a valid token, else null. Only the SHA-256 of
// the token is stored. Expiry is enforced by the daily cleanup cron (queries
// must not read the wall clock), so a session can outlive its expiresAt by at
// most a day.
export async function sessionOf(ctx: DbCtx, token: string) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}
