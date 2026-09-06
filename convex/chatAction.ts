"use node";
// The chat assistant: streams a Claude reply into the assistant message row,
// with tools to inspect and edit the sketch. Runs in the Node runtime.
import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { summarizeElements } from "./sceneEdit";

const MODEL = process.env.SKETCH_CHAT_MODEL || "claude-opus-5";
const MAX_TOOL_ROUNDS = 12;
const FLUSH_MS = 250;

const SYSTEM = `You are the assistant inside Sketchboard, a shared Excalidraw canvas. The user draws in the browser and talks to you in a narrow chat panel beside the canvas, so keep replies short and conversational: a sentence or two unless they ask for more. No markdown headers.

You see the current drawing as an image attached to the user's latest message, and you can inspect exact ids and positions with get_sketch. Use update_sketch to add, change, move or remove things. After editing, say briefly what you changed. The canvas updates live in the user's browser.

Drawing conventions:
- Scene coordinates: x grows right, y grows down. Use existing elements' positions and sizes to place new ones sensibly (leave ~40px gaps; align edges; keep the hand-drawn style unless told otherwise).
- Shapes: {"type":"rectangle"|"ellipse"|"diamond","x","y","width","height","label":{"text":"..."}} plus optional strokeColor, backgroundColor (e.g. "#a5d8ff" blue, "#b2f2bb" green, "#ffec99" yellow, "#ffc9c9" red, "#d0bfff" purple), fillStyle "solid"|"hachure", strokeStyle "solid"|"dashed"|"dotted", strokeWidth 1|2|4, roughness 0|1|2.
- Arrows: {"type":"arrow","x","y","width","height","start":{"id":"<element id>"},"end":{"id":"<element id>"},"label":{"text":"..."}} — bind to elements by id and the browser routes the arrow between them. Or give explicit "points":[[0,0],[dx,dy]] relative to x,y for a free arrow. "line" works the same without arrowheads.
- Text: {"type":"text","x","y","text":"...","fontSize":20}. fontFamily 5 is the hand-drawn font (default), 6 is normal, 8 is comic, 3 is code.
- To change a shape's label, update it with {"label":{"text":"new"}}. To move a shape, update x/y (its label follows; arrows bound to it re-route when the user next touches it).
- Removing a shape also removes its label. Hand-drawn strokes (freedraw) can only be removed, not authored.
- Never delete or move the user's own elements unless asked. Prefer adding.`;

const tools: Anthropic.Tool[] = [
  {
    name: "get_sketch",
    description:
      "Returns every element on the canvas with its id, type, position (x,y), size (w,h), text, colors and bindings. Call this before editing when you need exact ids or coordinates.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_sketch",
    description:
      "Edits the canvas. `add`: new elements (shorthand or full Excalidraw elements; you may set your own `id` and reference it from arrows in the same call). `update`: [{id, patch}] shallow-patches existing elements (patch.label.text renames a shape's label). `remove`: ids to delete. Returns a summary and the ids of added elements.",
    input_schema: {
      type: "object",
      properties: {
        add: { type: "array", items: { type: "object", additionalProperties: true } },
        update: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, patch: { type: "object", additionalProperties: true } },
            required: ["id", "patch"],
            additionalProperties: false,
          },
        },
        remove: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
];

type Part = { kind: "text"; text: string } | { kind: "tool"; label: string };

function toolLabel(name: string, summary?: string) {
  if (name === "get_sketch") return "Looking at the sketch";
  if (name === "update_sketch") return summary ? `Updated the sketch (${summary})` : "Updating the sketch";
  return `Using ${name}`;
}

async function runTool(ctx: ActionCtx, sketchId: Id<"sketches">, name: string, input: unknown): Promise<{ result: string; label: string; isError?: boolean }> {
  if (name === "get_sketch") {
    const scene = await ctx.runQuery(internal.sketches.internalGet, { id: sketchId });
    const elements = summarizeElements(scene?.elements ?? "[]");
    return { result: JSON.stringify({ count: elements.length, elements }), label: toolLabel(name) };
  }
  if (name === "update_sketch") {
    try {
      const r = await ctx.runMutation(internal.sketches.applyEditInternal, { id: sketchId, edit: input ?? {}, by: "claude" });
      return { result: JSON.stringify({ ok: true, summary: r.summary, newIds: r.newIds }), label: toolLabel(name, r.summary) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: JSON.stringify({ ok: false, error: msg }), label: "Edit failed: " + msg, isError: true };
    }
  }
  return { result: `Unknown tool ${name}`, label: toolLabel(name), isError: true };
}

function friendlyError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Claude API key on the Convex deployment was rejected. Set a valid ANTHROPIC_API_KEY with: npx convex env set ANTHROPIC_API_KEY sk-ant-...";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Try again in a moment.";
  if (e instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export const run = internalAction({
  args: { assistantId: v.id("messages"), sketchId: v.id("sketches") },
  handler: async (ctx, { assistantId, sketchId }) => {
    const parts: Part[] = [];
    let text = "";
    let cancelled = false;
    let lastFlush = 0;
    let flushing: Promise<void> | null = null;

    const flush = async (status?: "streaming" | "done" | "error", error?: string) => {
      const r = await ctx.runMutation(internal.chat.setProgress, {
        assistantId,
        text,
        parts: JSON.stringify(parts),
        ...(status ? { status } : {}),
        ...(error !== undefined ? { error } : {}),
      });
      if (r.cancelRequested) cancelled = true;
    };
    const flushSoon = () => {
      if (flushing || Date.now() - lastFlush < FLUSH_MS) return;
      lastFlush = Date.now();
      flushing = flush().catch(() => {}).finally(() => (flushing = null));
    };
    const appendText = (delta: string) => {
      text += delta;
      const last = parts[parts.length - 1];
      if (last && last.kind === "text") last.text += delta;
      else parts.push({ kind: "text", text: delta });
    };

    try {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          "No Claude API key is set on the Convex deployment. Run: npx convex env set ANTHROPIC_API_KEY sk-ant-... (and again with --prod for the live site).",
        );
      }
      const client = new Anthropic();
      const hist = await ctx.runQuery(internal.chat.history, { sketchId, assistantId });
      if (!hist.length || hist[hist.length - 1].role !== "user") throw new Error("Nothing to reply to.");
      const scene = await ctx.runQuery(internal.sketches.internalGet, { id: sketchId });

      let image: Anthropic.ImageBlockParam | null = null;
      if (scene?.pngId) {
        const blob = await ctx.storage.get(scene.pngId);
        if (blob && blob.size > 0 && blob.size < 4_500_000) {
          const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
          image = { type: "image", source: { type: "base64", media_type: "image/png", data } };
        }
      }

      const messages: Anthropic.MessageParam[] = hist
        .slice(0, -1)
        .map((m) => ({ role: m.role, content: m.text }));
      const last = hist[hist.length - 1].text;
      const sceneNote = image
        ? "The current sketch is attached as an image."
        : "No rendered image of the sketch is available yet (the browser renders one after the first drawing). Use get_sketch to inspect it.";
      messages.push({
        role: "user",
        content: [
          ...(image ? [image] : []),
          { type: "text", text: `[${sceneNote} Sketch title: "${scene?.title ?? ""}". Element count: ${JSON.parse(scene?.elements || "[]").length}.]\n\n${last}` },
        ],
      });

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        });
        stream.on("text", (delta) => {
          appendText(delta);
          flushSoon();
          if (cancelled) stream.abort();
        });
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") {
          throw new Error("The assistant declined that request" + (message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : "."));
        }
        messages.push({ role: "assistant", content: message.content });
        const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (message.stop_reason !== "tool_use" || !toolUses.length) break;
        if (cancelled) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const placeholder: Part = { kind: "tool", label: toolLabel(tu.name) };
          parts.push(placeholder);
          await flush();
          const r = await runTool(ctx, sketchId, tu.name, tu.input);
          placeholder.label = r.label;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: r.result, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        await flush();
      }
      if (flushing) await flushing;
      await flush("done", cancelled ? "Stopped." : undefined);
    } catch (e) {
      if (flushing) await flushing.catch(() => {});
      const msg = friendlyError(e);
      console.error("chat error", msg);
      await flush(cancelled ? "done" : "error", msg).catch(() => {});
    }
    return null;
  },
});
