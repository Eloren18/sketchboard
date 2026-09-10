<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Sketchboard — shared Excalidraw canvas between the user and Claude

Standalone app: Vite + React frontend (published to GitHub Pages) and a Convex backend that stores
sketches, chat transcripts and the invite-only email sign-in (same scheme as the Budget app).
Human-facing notes: `SETUP-Convex.txt`. Deployments: dev `loyal-whale-134`, prod `dynamic-dotterel-890`
(team kerem-ekdal, project sketchboard).

## Run locally
- `preview_start` with launch config `sketchboard` (or `npm run dev`) → http://localhost:5180, talking to the **dev** deployment via `.env.local`.
- Backend changes: `npx convex dev --once` pushes `convex/` to dev; `npx convex deploy -y` pushes to prod.
- Sign-in needs an emailed code. For local testing mint a token instead: `node tools/sketch.mjs session`
  and store it in the browser as `localStorage["sketchboard.session"]`, then reload.

## How the pieces fit
- `convex/sketches.ts` — scene per sketch (`elements` JSON string, `version`). Browser saves with a base
  version; a stale base is rejected and the browser reloads the newer scene (cloud wins).
- `convex/chat.ts` + `convex/chatAction.ts` — chat transcript; `send` schedules the Node action which
  streams a Claude reply (Anthropic SDK, model `claude-opus-5`, override with env `SKETCH_CHAT_MODEL`) into the
  assistant row. Tools: `get_sketch`, `update_sketch` (`convex/sceneEdit.ts`). Needs `ANTHROPIC_API_KEY`
  on the deployment. The chat assistant sees the latest PNG the browser uploaded (`pngId`).
- `convex/admin.ts` — internal functions for the CLI below (not reachable from browsers).
- Sessions store only a SHA-256 `tokenHash` (raw token stays in the browser); expiry is swept by the daily
  cron in `convex/crons.ts` (queries never read the clock). Env vars are typed in `convex/convex.config.ts`
  and read via `env` from `_generated/server`. A stuck chat reply is unblocked by `chat.markStale`
  (watchdog scheduled by `send`) and Stop; the action polls `chat.isCancelled` every second.
- Browser sync (`src/Board.jsx`): saves are serialized; on a version conflict the newer cloud scene is merged
  three-way against the last synced scene (user's unsaved edits win) and re-saved.
- `src/Board.jsx` — Excalidraw + sync. Elements without `versionNonce` are shorthand: the browser expands
  them with `convertToExcalidrawElements` (labels, `start`/`end` bindings) and writes the full form back.
- `src/ChatPanel.jsx`, `src/AuthGate.jsx`, `src/App.jsx` (sketch switcher).

## Working on a sketch from this session (Claude Code)
Use the CLI (dev deployment by default, add `--prod` for the live site):
```
node tools/sketch.mjs list
node tools/sketch.mjs png <id> sketch.png      # then Read sketch.png to SEE the drawing
node tools/sketch.mjs get <id> scene.json      # ids and positions
node tools/sketch.mjs edit <id> edit.json      # {"add":[...],"update":[{"id","patch"}],"remove":[...]}
```
- Always fetch fresh (`get`) right before deciding an edit; the user may have drawn since.
- Coordinates: scene units, y grows down. Place new things relative to existing elements' x/y/width/height.
- Shorthand elements (give them your own `id` so arrows can reference them):
  `{"id":"db","type":"ellipse","x":700,"y":250,"width":200,"height":140,"backgroundColor":"#a5d8ff","label":{"text":"Database"}}`
  `{"id":"a1","type":"arrow","x":570,"y":320,"width":120,"height":0,"start":{"id":"<rect id>"},"end":{"id":"db"},"label":{"text":"writes"}}`
  `{"type":"text","x":100,"y":80,"text":"Title","fontSize":28}` · `{"type":"line","x":100,"y":400,"points":[[0,0],[300,0]]}`
- `update` patch keys: x, y, width, height, strokeColor, backgroundColor, strokeStyle, `label:{text}` (renames a
  shape's bound label), `text` (text elements). Moving a shape moves its label; bound arrows re-route only
  when the user next touches the shape in the browser.
- Do not delete or move the user's own elements unless asked.
- The PNG is rendered by the browser ~2 s after each change; if no browser is open the PNG can be stale
  (`list` shows its timestamp). A Browser-pane screenshot of the preview also works.
- Scratch files (`sketch.png`, `scene.json`, `edit.json`) are gitignored; keep them in the project root or the scratchpad.
