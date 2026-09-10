// Daily housekeeping: sweep expired sessions and stale sign-in codes.
// Queries must not read the wall clock, so session expiry is enforced here
// (a session can outlive its expiresAt by at most a day) rather than in sessionOf.
import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    // Missing fields sort before numbers in an index, so bound the range from
    // below too: a row without expiresAt must never count as expired.
    const expiredSessions = await ctx.db
      .query("sessions")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", 0).lt("expiresAt", now))
      .take(500);
    for (const s of expiredSessions) await ctx.db.delete(s._id);
    // Codes are pruned per address on each request; this catches addresses that never came back.
    const otps = await ctx.db.query("otps").take(500);
    for (const o of otps) if (o.expiresAt < now - 24 * 60 * 60 * 1000) await ctx.db.delete(o._id);
    if (expiredSessions.length === 500 || otps.length === 500) {
      await ctx.scheduler.runAfter(0, internal.crons.cleanup, {});
    }
    return null;
  },
});

const crons = cronJobs();
crons.interval("sweep expired sessions and codes", { hours: 24 }, internal.crons.cleanup, {});
export default crons;
