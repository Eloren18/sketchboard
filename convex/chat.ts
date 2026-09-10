import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sessionOf } from "./lib";

const MAX_TEXT = 8000;
const STALE_MS = 10 * 60 * 1000; // a reply still "streaming" after this is considered dead
const WATCHDOG_MS = 15 * 60 * 1000; // scheduled check that marks a dead reply as failed
const STOP_FORCE_MS = 2 * 60 * 1000; // Stop on a reply older than this ends it outright

const statusValidator = v.union(v.literal("streaming"), v.literal("done"), v.literal("error"));
const messageValidator = v.object({
  id: v.id("messages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  text: v.string(),
  parts: v.string(),
  status: statusValidator,
  error: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

async function requireOwnedSketch(ctx: MutationCtx, token: string, sketchId: Id<"sketches">) {
  const s = await sessionOf(ctx, token);
  if (!s) throw new ConvexError("Not signed in.");
  const sketch = await ctx.db.get(sketchId);
  if (!sketch || sketch.ownerEmail !== s.email) throw new ConvexError("Sketch not found.");
  return sketch;
}

async function recentMessages(ctx: MutationCtx, sketchId: Id<"sketches">, n: number): Promise<Doc<"messages">[]> {
  return await ctx.db
    .query("messages")
    .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
    .order("desc")
    .take(n);
}

export const list = query({
  args: { token: v.string(), sketchId: v.id("sketches") },
  returns: v.array(messageValidator),
  handler: async (ctx, { token, sketchId }) => {
    const s = await sessionOf(ctx, token);
    if (!s) return [];
    const sketch = await ctx.db.get(sketchId);
    if (!sketch || sketch.ownerEmail !== s.email) return [];
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .order("desc")
      .take(100);
    return rows.reverse().map((m) => ({
      id: m._id,
      role: m.role,
      text: m.text,
      parts: m.parts,
      status: m.status,
      error: m.error ?? null,
      createdAt: m.createdAt,
    }));
  },
});

// Stores the user's message and an empty assistant reply, then starts the
// assistant in the background. The UI watches `list` for the streamed reply.
export const send = mutation({
  args: { token: v.string(), sketchId: v.id("sketches"), text: v.string() },
  returns: v.id("messages"),
  handler: async (ctx, { token, sketchId, text }) => {
    await requireOwnedSketch(ctx, token, sketchId);
    const body = text.trim().slice(0, MAX_TEXT);
    if (!body) throw new ConvexError("Empty message.");
    const now = Date.now();
    for (const m of await recentMessages(ctx, sketchId, 3)) {
      if (m.status !== "streaming") continue;
      if (now - m.createdAt < STALE_MS) throw new ConvexError("The assistant is still replying.");
      // The action that owned this reply died without finishing: unblock the chat.
      await ctx.db.patch(m._id, { status: "error", error: "The previous reply timed out." });
    }
    await ctx.db.insert("messages", {
      sketchId,
      role: "user",
      text: body,
      parts: JSON.stringify([{ kind: "text", text: body }]),
      status: "done",
      createdAt: now,
    });
    const assistantId = await ctx.db.insert("messages", {
      sketchId,
      role: "assistant",
      text: "",
      parts: "[]",
      status: "streaming",
      createdAt: now + 1,
    });
    await ctx.scheduler.runAfter(0, internal.chatAction.run, { assistantId, sketchId });
    await ctx.scheduler.runAfter(WATCHDOG_MS, internal.chat.markStale, { assistantId });
    return assistantId;
  },
});

// Watchdog: if the reply is still marked streaming long after it started, the
// action died (deploy, time limit, crash). Mark it failed so the chat unblocks.
export const markStale = internalMutation({
  args: { assistantId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, { assistantId }) => {
    const m = await ctx.db.get(assistantId);
    if (m && m.status === "streaming") {
      await ctx.db.patch(assistantId, { status: "error", error: "The reply timed out. Please send your message again." });
    }
    return null;
  },
});

export const stop = mutation({
  args: { token: v.string(), sketchId: v.id("sketches") },
  returns: v.null(),
  handler: async (ctx, { token, sketchId }) => {
    await requireOwnedSketch(ctx, token, sketchId);
    const now = Date.now();
    for (const m of await recentMessages(ctx, sketchId, 3)) {
      if (m.status !== "streaming") continue;
      if (now - m.createdAt > STOP_FORCE_MS) {
        // Old enough that the action may be gone: end it here rather than wait.
        await ctx.db.patch(m._id, { cancelRequested: true, status: "error", error: "Stopped." });
      } else {
        await ctx.db.patch(m._id, { cancelRequested: true });
      }
    }
    return null;
  },
});

export const reset = mutation({
  args: { token: v.string(), sketchId: v.id("sketches") },
  returns: v.null(),
  handler: async (ctx, { token, sketchId }) => {
    await requireOwnedSketch(ctx, token, sketchId);
    await deleteMessagesBatch(ctx, sketchId);
    return null;
  },
});

// Deletes up to 500 messages and schedules itself again while more remain.
// Also used when a sketch is deleted (sketches.remove).
export async function deleteMessagesBatch(ctx: MutationCtx, sketchId: Id<"sketches">) {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
    .take(500);
  for (const m of rows) await ctx.db.delete(m._id);
  if (rows.length === 500) await ctx.scheduler.runAfter(0, internal.chat.resetMore, { sketchId });
}

export const resetMore = internalMutation({
  args: { sketchId: v.id("sketches") },
  returns: v.null(),
  handler: async (ctx, { sketchId }) => {
    await deleteMessagesBatch(ctx, sketchId);
    return null;
  },
});

/* ===== internal: used by chatAction ===== */

// Conversation so far (oldest first), excluding the assistant row being
// generated and any earlier failed replies. The last entry is the user's
// newest message.
export const history = internalQuery({
  args: { sketchId: v.id("sketches"), assistantId: v.id("messages") },
  returns: v.array(v.object({ role: v.union(v.literal("user"), v.literal("assistant")), text: v.string() })),
  handler: async (ctx, { sketchId, assistantId }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .order("desc")
      .take(40);
    return rows
      .reverse()
      .filter((m) => m._id !== assistantId && m.status === "done" && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text }));
  },
});

// Has the user pressed Stop (or reset the chat) for this reply?
export const isCancelled = internalQuery({
  args: { assistantId: v.id("messages") },
  returns: v.boolean(),
  handler: async (ctx, { assistantId }) => {
    const m = await ctx.db.get(assistantId);
    return !m || !!m.cancelRequested || m.status !== "streaming";
  },
});

// Progress snapshot from the streaming action. Returns whether the user asked
// to stop so the action can abort the model call.
export const setProgress = internalMutation({
  args: {
    assistantId: v.id("messages"),
    text: v.string(),
    parts: v.string(),
    status: v.optional(statusValidator),
    error: v.optional(v.string()),
  },
  returns: v.object({ cancelRequested: v.boolean() }),
  handler: async (ctx, { assistantId, text, parts, status, error }) => {
    const m = await ctx.db.get(assistantId);
    if (!m) return { cancelRequested: true };
    if (m.status !== "streaming" && !status) return { cancelRequested: true }; // ended elsewhere (stop/watchdog)
    await ctx.db.patch(assistantId, {
      text,
      parts,
      ...(status ? { status } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return { cancelRequested: !!m.cancelRequested };
  },
});
