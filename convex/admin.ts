// Internal functions for the command line (Claude Code / tools/sketch.mjs).
// They are NOT reachable from the browser: `npx convex run` invokes them with
// the deployment's admin credentials from `npx convex dev` / `npx convex login`.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { ADMIN_EMAIL, MAX_SCENE_BYTES, SESSION_MAX_AGE_MS, norm, randomToken, sha256Hex, utf8Bytes } from "./lib";
import { applyEdit, type Edit } from "./sceneEdit";

function decodeB64Json(b64: string): unknown {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const listSketches = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("sketches"),
      owner: v.string(),
      title: v.string(),
      version: v.number(),
      updatedAt: v.string(),
      updatedBy: v.string(),
      hasPng: v.boolean(),
      pngUpdatedAt: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("sketches").order("desc").take(200);
    return rows.map((r) => ({
      id: r._id,
      owner: r.ownerEmail,
      title: r.title,
      version: r.version,
      updatedAt: new Date(r.updatedAt).toISOString(),
      updatedBy: r.updatedBy,
      hasPng: !!r.pngId,
      pngUpdatedAt: r.pngUpdatedAt ? new Date(r.pngUpdatedAt).toISOString() : null,
    }));
  },
});

export const getScene = internalQuery({
  args: { id: v.id("sketches") },
  returns: v.object({
    title: v.string(),
    version: v.number(),
    updatedAt: v.string(),
    updatedBy: v.string(),
    appState: v.any(),
    elements: v.array(v.any()),
  }),
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    return {
      title: doc.title,
      version: doc.version,
      updatedAt: new Date(doc.updatedAt).toISOString(),
      updatedBy: doc.updatedBy,
      appState: JSON.parse(doc.appState),
      elements: JSON.parse(doc.elements),
    };
  },
});

export const pngUrl = internalQuery({
  args: { id: v.id("sketches") },
  returns: v.object({ url: v.union(v.string(), v.null()), updatedAt: v.union(v.string(), v.null()) }),
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    if (!doc.pngId) return { url: null, updatedAt: null };
    return {
      url: await ctx.storage.getUrl(doc.pngId),
      updatedAt: doc.pngUpdatedAt ? new Date(doc.pngUpdatedAt).toISOString() : null,
    };
  },
});

// b64: base64 of a JSON object {add?, update?, remove?} (see sceneEdit.ts).
export const edit = internalMutation({
  args: { id: v.id("sketches"), b64: v.string() },
  returns: v.object({ summary: v.string(), newIds: v.array(v.string()), version: v.number() }),
  handler: async (ctx, { id, b64 }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    let result;
    try {
      result = applyEdit(doc.elements, decodeB64Json(b64) as Edit);
    } catch (e) {
      throw new ConvexError(e instanceof Error ? e.message : String(e));
    }
    const version = doc.version + 1;
    await ctx.db.patch(id, { elements: JSON.stringify(result.elements), version, updatedAt: Date.now(), updatedBy: "cli" });
    return { summary: result.summary, newIds: result.newIds, version };
  },
});

// b64: base64 of a JSON object {elements: [...], appState?: {...}}.
export const setScene = internalMutation({
  args: { id: v.id("sketches"), b64: v.string() },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, { id, b64 }) => {
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Sketch not found.");
    const data = decodeB64Json(b64) as { elements?: unknown[]; appState?: unknown };
    if (!Array.isArray(data.elements)) throw new ConvexError("Expected {elements: [...]}.");
    const elements = JSON.stringify(data.elements);
    if (utf8Bytes(elements) > MAX_SCENE_BYTES) throw new ConvexError("The sketch is too large to store.");
    const version = doc.version + 1;
    await ctx.db.patch(id, {
      elements,
      ...(data.appState && typeof data.appState === "object" ? { appState: JSON.stringify(data.appState) } : {}),
      version,
      updatedAt: Date.now(),
      updatedBy: "cli",
    });
    return { version };
  },
});

export const createSketch = internalMutation({
  args: { title: v.string(), owner: v.optional(v.string()) },
  returns: v.id("sketches"),
  handler: async (ctx, { title, owner }) => {
    const now = Date.now();
    return await ctx.db.insert("sketches", {
      ownerEmail: norm(owner || ADMIN_EMAIL),
      title: title.trim() || "Untitled",
      elements: "[]",
      appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
      version: 1,
      updatedAt: now,
      updatedBy: "cli",
    });
  },
});

// Mints a sign-in session without the email code (local testing only; the
// caller already holds admin rights on the deployment to reach this).
export const devSession = internalMutation({
  args: { email: v.optional(v.string()) },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, { email }) => {
    const token = randomToken();
    const now = Date.now();
    await ctx.db.insert("sessions", {
      tokenHash: await sha256Hex(token),
      email: norm(email || ADMIN_EMAIL),
      createdAt: now,
      expiresAt: now + SESSION_MAX_AGE_MS,
    });
    return { token };
  },
});

// One-off migration: hash legacy plaintext session tokens and set expiresAt.
// Safe to run repeatedly; rows already migrated are skipped.
export const migrateSessions = internalMutation({
  args: {},
  returns: v.object({ migrated: v.number(), remaining: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("sessions").take(500);
    let migrated = 0;
    for (const s of rows) {
      const patch: { tokenHash?: string; token?: undefined; expiresAt?: number } = {};
      if (!s.tokenHash && s.token) {
        patch.tokenHash = await sha256Hex(s.token);
        patch.token = undefined; // removes the plaintext field
      } else if (s.token) {
        patch.token = undefined;
      }
      if (!s.expiresAt) patch.expiresAt = s.createdAt + SESSION_MAX_AGE_MS;
      if (Object.keys(patch).length) {
        await ctx.db.patch(s._id, patch);
        migrated++;
      }
    }
    return { migrated, remaining: rows.length === 500 ? -1 : 0 };
  },
});
