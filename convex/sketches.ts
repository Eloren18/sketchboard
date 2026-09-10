import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { deleteMessagesBatch } from "./chat";
import { MAX_SCENE_BYTES, sessionOf, utf8Bytes } from "./lib";
import { applyEdit, type Edit } from "./sceneEdit";

const EMPTY_APPSTATE = JSON.stringify({ viewBackgroundColor: "#ffffff" });
const MAX_APPSTATE_BYTES = 50_000;

const editValidator = v.object({
  add: v.optional(v.array(v.any())),
  update: v.optional(v.array(v.object({ id: v.string(), patch: v.any() }))),
  remove: v.optional(v.array(v.string())),
});

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

// Validates scene JSON coming from a client before it is stored.
function checkScene(elements: string, appState: string) {
  if (utf8Bytes(elements) > MAX_SCENE_BYTES) throw new ConvexError("The sketch is too large to store (over ~900 KB). Remove some elements first.");
  if (utf8Bytes(appState) > MAX_APPSTATE_BYTES) throw new ConvexError("The sketch settings are too large to store.");
  let parsedElements: unknown;
  let parsedAppState: unknown;
  try {
    parsedElements = JSON.parse(elements);
    parsedAppState = JSON.parse(appState);
  } catch {
    throw new ConvexError("The sketch data is not valid JSON.");
  }
  if (!Array.isArray(parsedElements)) throw new ConvexError("Elements must be a JSON array.");
  if (!parsedAppState || typeof parsedAppState !== "object" || Array.isArray(parsedAppState)) throw new ConvexError("appState must be a JSON object.");
}

/* ===== listing / lifecycle ===== */

export const list = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.id("sketches"), title: v.string(), updatedAt: v.number(), updatedBy: v.string() })),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    if (!s) return [];
    const rows = await ctx.db
      .query("sketches")
      .withIndex("by_ownerEmail_and_updatedAt", (q) => q.eq("ownerEmail", s.email))
      .order("desc")
      .take(200);
    return rows.map((r) => ({ id: r._id, title: r.title, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
  },
});

export const create = mutation({
  args: { token: v.string(), title: v.optional(v.string()) },
  returns: v.id("sketches"),
  handler: async (ctx, { token, title }) => {
    const s = await requireUser(ctx, token);
    const now = Date.now();
    return await ctx.db.insert("sketches", {
      ownerEmail: s.email,
      title: (title || "").trim().slice(0, 120) || `Sketch ${new Date(now).toLocaleDateString("en-GB")}`,
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
  returns: v.null(),
  handler: async (ctx, { token, id, title }) => {
    await requireOwner(ctx, token, id);
    const t = title.trim();
    if (!t) throw new ConvexError("Title cannot be empty.");
    await ctx.db.patch(id, { title: t.slice(0, 120) });
    return null;
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("sketches") },
  returns: v.null(),
  handler: async (ctx, { token, id }) => {
    const { doc } = await requireOwner(ctx, token, id);
    await deleteMessagesBatch(ctx, id); // continues in the background if there are many
    if (doc.pngId) await ctx.storage.delete(doc.pngId);
    await ctx.db.delete(id);
    return null;
  },
});

/* ===== scene sync ===== */

export const get = query({
  args: { token: v.string(), id: v.id("sketches") },
  returns: v.union(
    v.object({
      id: v.id("sketches"),
      title: v.string(),
      elements: v.string(),
      appState: v.string(),
      version: v.number(),
      updatedAt: v.number(),
      updatedBy: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, { token, id }) => {
    const s = await sessionOf(ctx, token);
    if (!s) return null;
    const doc = await ctx.db.get(id);
    if (!doc || doc.ownerEmail !== s.email) return null;
    // pngId/pngUpdatedAt are deliberately left out: they change on every
    // rendering and would re-push the whole scene to every open tab.
    return {
      id: doc._id,
      title: doc.title,
      elements: doc.elements,
      appState: doc.appState,
      version: doc.version,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
    };
  },
});

// Browser save. Rejects (without writing) when the base version is stale so
// the browser merges with the newer scene instead of overwriting it.
export const save = mutation({
  args: {
    token: v.string(),
    id: v.id("sketches"),
    elements: v.string(),
    appState: v.string(),
    baseVersion: v.number(),
  },
  returns: v.object({ ok: v.boolean(), version: v.number() }),
  handler: async (ctx, { token, id, elements, appState, baseVersion }) => {
    const { doc } = await requireOwner(ctx, token, id);
    if (doc.version !== baseVersion) return { ok: false, version: doc.version };
    checkScene(elements, appState);
    const version = doc.version + 1;
    await ctx.db.patch(id, { elements, appState, version, updatedAt: Date.now(), updatedBy: "browser" });
    return { ok: true, version };
  },
});

export const generateUploadUrl = mutation({
  args: { token: v.string() },
  returns: v.string(),
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setPng = mutation({
  args: { token: v.string(), id: v.id("sketches"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { token, id, storageId }) => {
    const { doc } = await requireOwner(ctx, token, id);
    if (doc.pngId && doc.pngId !== storageId) await ctx.storage.delete(doc.pngId);
    await ctx.db.patch(id, { pngId: storageId, pngUpdatedAt: Date.now() });
    return null;
  },
});

/* ===== internal (chat assistant + admin CLI) ===== */

export const internalGet = internalQuery({
  args: { id: v.id("sketches") },
  returns: v.union(
    v.object({
      title: v.string(),
      elements: v.string(),
      appState: v.string(),
      version: v.number(),
      updatedAt: v.number(),
      updatedBy: v.string(),
      pngId: v.union(v.id("_storage"), v.null()),
      pngUpdatedAt: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
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
  args: { id: v.id("sketches"), edit: editValidator, by: v.string() },
  returns: v.object({ summary: v.string(), newIds: v.array(v.string()), version: v.number() }),
  handler: async (ctx, { id, edit, by }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    let result;
    try {
      result = applyEdit(doc.elements, edit as Edit);
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
  returns: v.object({ version: v.number() }),
  handler: async (ctx, { id, elements, appState, by }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    checkScene(elements, appState ?? doc.appState);
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
