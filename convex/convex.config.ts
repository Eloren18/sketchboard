import { defineApp } from "convex/server";
import { v } from "convex/values";

// Typed environment variables, read via `env` from ./_generated/server.
// Set them with: npx convex env set NAME value   (add --prod for the live site)
const app = defineApp({
  env: {
    ANTHROPIC_API_KEY: v.optional(v.string()), // in-app chat assistant
    SKETCH_CHAT_MODEL: v.optional(v.string()), // defaults to claude-opus-5
    RESEND_API_KEY: v.optional(v.string()), // sign-in code emails
  },
});

export default app;
