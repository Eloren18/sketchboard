import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sessionOf } from "./lib";
import { applyEdit, MAX_SCENE_BYTES, type Edit } from "./sceneEdit";

const EMPTY_APPSTATE = JSON.stringify({ viewBackgroundColor: "#ffffff" });

async function requireUser(ctx: QueryCtx | MutationCtx, token: string) {
  const s = await sessionOf(ctx, token);
  if (!s) throw new ConvexError("Not signed in.");
  return s;
}

async function requireOwner(ctx: QueryCtx | MutationCtx, token: string, id: Id<"sketches">) {
  const s = await requireUser(ctx, token);
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerEmail !== s.email) throw new ConvexError("Sketch not found.");
  return { session: s, doc };
}

/* ===== listing / lifecycle ===== */

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    if (!s) return [];
    const rows = await ctx.db
      .query("sketches")
      .withIndex("by_ownerEmail", (q) => q.eq("ownerEmail", s.email))
      .take(200);
    return rows
      .map((r) => ({ id: r._id, title: r.title, updatedAt: r.updatedAt, updatedBy: r.updatedBy }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: { token: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, { token, title }) => {
    const s = await requireUser(ctx, token);
    const now = Date.now();
    return await ctx.db.insert("sketches", {
      ownerEmail: s.email,
      title: (title || "").trim() || `Sketch ${new Date(now).toLocaleDateString("en-GB")}`,
      elements: "[]",
      appState: EMPTY_APPSTATE,
      version: 1,
      updatedAt: now,
      updatedBy: "browser",
    });
  },
});

export const rename = mutation({
  args: { token: v.string(), id: v.id("sketches"), title: v.string() },
  handler: async (ctx, { token, id, title }) => {
    await requireOwner(ctx, token, id);
    const t = title.trim();
    if (!t) throw new ConvexError("Title cannot be empty.");
    await ctx.db.patch(id, { title: t.slice(0, 120) });
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("sketches") },
  handler: async (ctx, { token, id }) => {
    const { doc } = await requireOwner(ctx, token, id);
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_sketchId", (q) => q.eq("sketchId", id))
      .take(1000);
    for (const m of msgs) await ctx.db.delete(m._id);
    if (doc.pngId) await ctx.storage.delete(doc.pngId);
    await ctx.db.delete(id);
  },
});

/* ===== scene sync ===== */

export const get = query({
  args: { token: v.string(), id: v.id("sketches") },
  handler: async (ctx, { token, id }) => {
    const s = await sessionOf(ctx, token);
    if (!s) return null;
    const doc = await ctx.db.get(id);
    if (!doc || doc.ownerEmail !== s.email) return null;
    return {
      id: doc._id,
      title: doc.title,
      elements: doc.elements,
      appState: doc.appState,
      version: doc.version,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      pngUpdatedAt: doc.pngUpdatedAt ?? null,
    };
  },
});

// Browser save. Rejects (without writing) when the base version is stale so
// the browser reloads the newer scene instead of overwriting it.
export const save = mutation({
  args: {
    token: v.string(),
    id: v.id("sketches"),
    elements: v.string(),
    appState: v.string(),
    baseVersion: v.number(),
  },
  handler: async (ctx, { token, id, elements, appState, baseVersion }) => {
    const { doc } = await requireOwner(ctx, token, id);
    if (doc.version !== baseVersion) return { ok: false as const, version: doc.version };
    if (elements.length > MAX_SCENE_BYTES) throw new ConvexError("The sketch is too large to store (over ~900 KB).");
    const version = doc.version + 1;
    await ctx.db.patch(id, { elements, appState, version, updatedAt: Date.now(), updatedBy: "browser" });
    return { ok: true as const, version };
  },
});

export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setPng = mutation({
  args: { token: v.string(), id: v.id("sketches"), storageId: v.id("_storage") },
  handler: async (ctx, { token, id, storageId }) => {
    const { doc } = await requireOwner(ctx, token, id);
    if (doc.pngId && doc.pngId !== storageId) await ctx.storage.delete(doc.pngId);
    await ctx.db.patch(id, { pngId: storageId, pngUpdatedAt: Date.now() });
  },
});

/* ===== internal (chat assistant + admin CLI) ===== */

export const internalGet = internalQuery({
  args: { id: v.id("sketches") },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) return null;
    return {
      title: doc.title,
      elements: doc.elements,
      appState: doc.appState,
      version: doc.version,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      pngId: doc.pngId ?? null,
      pngUpdatedAt: doc.pngUpdatedAt ?? null,
    };
  },
});

export const applyEditInternal = internalMutation({
  args: { id: v.id("sketches"), edit: v.any(), by: v.string() },
  handler: async (ctx, { id, edit, by }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    let result;
    try {
      result = applyEdit(doc.elements, (edit ?? {}) as Edit);
    } catch (e) {
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
    const version = doc.version + 1;
    await ctx.db.patch(id, {
      elements: JSON.stringify(result.elements),
      version,
      updatedAt: Date.now(),
      updatedBy: by,
    });
    return { summary: result.summary, newIds: result.newIds, version };
  },
});

export const replaceInternal = internalMutation({
  args: { id: v.id("sketches"), elements: v.string(), appState: v.optional(v.string()), by: v.string() },
  handler: async (ctx, { id, elements, appState, by }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    if (elements.length > MAX_SCENE_BYTES) throw new ConvexError("The sketch is too large to store.");
    JSON.parse(elements); // validate
    const version = doc.version + 1;
    await ctx.db.patch(id, {
      elements,
      ...(appState ? { appState } : {}),
      version,
      updatedAt: Date.now(),
      updatedBy: by,
    });
    return { version };
  },
});
