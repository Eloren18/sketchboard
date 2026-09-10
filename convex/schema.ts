import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per drawing. Elements/appState are stored as JSON strings because
  // Excalidraw element shapes vary by type (and can hold arbitrary keys).
  sketches: defineTable({
    ownerEmail: v.string(), // lowercased
    title: v.string(),
    elements: v.string(), // JSON array of Excalidraw elements (non-deleted only)
    appState: v.string(), // JSON: export-relevant appState keys (viewBackgroundColor, ...)
    version: v.number(), // bumped on every write; clients send their base version
    updatedAt: v.number(),
    updatedBy: v.string(), // "browser" | "claude" | "cli"
    pngId: v.optional(v.id("_storage")), // latest rendering uploaded by a browser
    pngUpdatedAt: v.optional(v.number()),
  })
    .index("by_ownerEmail", ["ownerEmail"])
    .index("by_ownerEmail_and_updatedAt", ["ownerEmail", "updatedAt"]),

  // Chat transcript per sketch. Assistant rows are patched while streaming.
  messages: defineTable({
    sketchId: v.id("sketches"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(), // plain text (assistant: full text so far)
    parts: v.string(), // JSON array: [{kind:"text",text}|{kind:"tool",label}]
    status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
    error: v.optional(v.string()),
    cancelRequested: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_sketchId", ["sketchId"]),

  // Invite list: one row per approved email (admin is always allowed, no row needed).
  access: defineTable({
    email: v.string(),
    addedAt: v.number(),
  }).index("by_email", ["email"]),

  // Pending sign-in codes (newest wins; hashed, expiring, attempt-capped).
  otps: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    sentAt: v.number(),
  }).index("by_email", ["email"]),

  // Signed-in devices. The browser keeps the raw token; only its SHA-256 is
  // stored here. `token` is the pre-hashing legacy field (migrated by
  // admin.migrateSessions) and is no longer written.
  sessions: defineTable({
    tokenHash: v.optional(v.string()),
    token: v.optional(v.string()),
    email: v.string(),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()), // enforced by the daily cron in crons.ts
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_email", ["email"])
    .index("by_expiresAt", ["expiresAt"]),
});
