// Shared helpers (not Convex endpoints).

export const ADMIN_EMAIL = "keremladkeholland@gmail.com";
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // sign in again after ~6 months
export const OTP_TTL_MS = 1000 * 60 * 10; // codes valid 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 30_000; // min gap between two code emails
export const OTP_DAILY_CAP = 15; // max code emails per address per 24h

export const norm = (e: string) => (e || "").trim().toLowerCase();

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns the session row for a valid, unexpired token — else null.
export async function sessionOf(ctx: { db: any }, token: string) {
  if (!token) return null;
  const s = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .first();
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) return null;
  return s;
}
