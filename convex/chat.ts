import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { sessionOf } from "./lib";

const MAX_TEXT = 8000;

export const list = query({
  args: { token: v.string(), sketchId: v.id("sketches") },
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
    }));
  },
});

// Stores the user's message and an empty assistant reply, then starts the
// assistant in the background. The UI watches `list` for the streamed reply.
export const send = mutation({
  args: { token: v.string(), sketchId: v.id("sketches"), text: v.string() },
  handler: async (ctx, { token, sketchId, text }) => {
    const s = await sessionOf(ctx, token);
    if (!s) throw new ConvexError("Not signed in.");
    const sketch = await ctx.db.get(sketchId);
    if (!sketch || sketch.ownerEmail !== s.email) throw new ConvexError("Sketch not found.");
    const body = text.trim().slice(0, MAX_TEXT);
    if (!body) throw new ConvexError("Empty message.");
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .order("desc")
      .take(3);
    if (recent.some((m) => m.status === "streaming")) throw new ConvexError("The assistant is still replying.");
    const now = Date.now();
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
    return assistantId;
  },
});

export const stop = mutation({
  args: { token: v.string(), sketchId: v.id("sketches") },
  handler: async (ctx, { token, sketchId }) => {
    const s = await sessionOf(ctx, token);
    if (!s) throw new ConvexError("Not signed in.");
    const sketch = await ctx.db.get(sketchId);
    if (!sketch || sketch.ownerEmail !== s.email) throw new ConvexError("Sketch not found.");
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .order("desc")
      .take(3);
    for (const m of recent) if (m.status === "streaming") await ctx.db.patch(m._id, { cancelRequested: true });
  },
});

export const reset = mutation({
  args: { token: v.string(), sketchId: v.id("sketches") },
  handler: async (ctx, { token, sketchId }) => {
    const s = await sessionOf(ctx, token);
    if (!s) throw new ConvexError("Not signed in.");
    const sketch = await ctx.db.get(sketchId);
    if (!sketch || sketch.ownerEmail !== s.email) throw new ConvexError("Sketch not found.");
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .take(500);
    for (const m of rows) await ctx.db.delete(m._id);
    if (rows.length === 500) await ctx.scheduler.runAfter(0, internal.chat.resetMore, { sketchId });
  },
});

export const resetMore = internalMutation({
  args: { sketchId: v.id("sketches") },
  handler: async (ctx, { sketchId }) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", sketchId))
      .take(500);
    for (const m of rows) await ctx.db.delete(m._id);
    if (rows.length === 500) await ctx.scheduler.runAfter(0, internal.chat.resetMore, { sketchId });
  },
});

/* ===== internal: used by chatAction ===== */

// Conversation so far (oldest first), excluding the assistant row being
// generated and any earlier failed replies. The last entry is the user's
// newest message.
export const history = internalQuery({
  args: { sketchId: v.id("sketches"), assistantId: v.id("messages") },
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

// Progress snapshot from the streaming action. Returns whether the user asked
// to stop so the action can abort the model call.
export const setProgress = internalMutation({
  args: {
    assistantId: v.id("messages"),
    text: v.string(),
    parts: v.string(),
    status: v.optional(v.union(v.literal("streaming"), v.literal("done"), v.literal("error"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { assistantId, text, parts, status, error }) => {
    const m = await ctx.db.get(assistantId);
    if (!m) return { cancelRequested: true };
    await ctx.db.patch(assistantId, {
      text,
      parts,
      ...(status ? { status } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return { cancelRequested: !!m.cancelRequested };
  },
});
