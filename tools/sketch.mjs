#!/usr/bin/env node
// Command-line access to the sketches (used by Claude Code; works for humans too).
// Runs Convex *internal* functions through `npx convex run`, so it needs the
// Convex CLI login on this machine (npx convex dev / npx convex login).
//
//   node tools/sketch.mjs list                      list sketches (id, owner, title, version)
//   node tools/sketch.mjs get <id> [out.json]       print the scene (or save it to a file)
//   node tools/sketch.mjs png <id> [out.png]        download the latest rendering (default: sketch.png)
//   node tools/sketch.mjs edit <id> <edit.json>     apply {add,update,remove} (see CLAUDE.md)
//   node tools/sketch.mjs set <id> <scene.json>     replace all elements ({elements:[...], appState?})
//   node tools/sketch.mjs new "<title>" [owner]     create an empty sketch
//   node tools/sketch.mjs session [email]           mint a sign-in token (local testing)
//
// Add --prod to target the production deployment instead of the dev one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const argv = process.argv.slice(2);
const prod = argv.includes("--prod");
const args = argv.filter((a) => a !== "--prod");
const [cmd, ...rest] = args;

function run(fn, payload) {
  const cliArgs = ["convex", "run", fn, JSON.stringify(payload ?? {})];
  if (prod) cliArgs.push("--prod");
  // shell:true is required to launch npx on Windows; the JSON only contains
  // ids, titles and base64, so quoting stays safe.
  const quoted = cliArgs.map((a) => (/^[\w:.\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`));
  const r = spawnSync(`npx ${quoted.join(" ")}`, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || "");
    process.exit(r.status ?? 1);
  }
  const out = r.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

// Windows limits a command line to ~8 KB, so an edit is sent as several
// calls when needed: removals first, then updates, then additions in chunks.
// Order matters: ids freed by `remove` can be reused by `add`.
const MAX_B64 = 6000;
function applyEditChunked(id, edit) {
  const calls = [];
  const whole = { ...edit };
  if (b64(whole).length <= MAX_B64) calls.push(whole);
  else {
    if (edit.remove?.length) calls.push({ remove: edit.remove });
    if (edit.update?.length) for (const c of chunk(edit.update)) calls.push({ update: c });
    if (edit.add?.length) for (const c of chunk(edit.add)) calls.push({ add: c });
  }
  const summary = [];
  const newIds = [];
  let version = 0;
  for (const call of calls) {
    const r = run("admin:edit", { id, b64: b64(call) });
    summary.push(r.summary);
    newIds.push(...(r.newIds || []));
    version = r.version;
  }
  return { summary: summary.join("; "), newIds, version };
}
function chunk(items) {
  const out = [];
  let cur = [];
  for (const it of items) {
    if (cur.length && b64([...cur, it]).length > MAX_B64) {
      out.push(cur);
      cur = [];
    }
    if (b64([it]).length > MAX_B64) die(`One element is too large to send (${b64([it]).length} bytes encoded).`);
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

async function main() {
  switch (cmd) {
    case "list": {
      const rows = run("admin:listSketches");
      if (!Array.isArray(rows) || !rows.length) return console.log("(no sketches)");
      for (const r of rows) console.log(`${r.id}  v${r.version}  ${r.updatedAt}  by ${r.updatedBy}  png:${r.hasPng ? "yes" : "no"}  ${r.owner}  "${r.title}"`);
      return;
    }
    case "get": {
      const [id, out] = rest;
      if (!id) die("usage: get <id> [out.json]");
      const scene = run("admin:getScene", { id });
      const text = JSON.stringify(scene, null, 2);
      if (out) {
        fs.writeFileSync(out, text);
        console.log(`wrote ${out} (${scene.elements.length} elements, v${scene.version})`);
      } else console.log(text);
      return;
    }
    case "png": {
      const [id, out = "sketch.png"] = rest;
      if (!id) die("usage: png <id> [out.png]");
      const r = run("admin:pngUrl", { id });
      if (!r || !r.url) die("No rendering yet: open the sketch in a browser once so it uploads a PNG.");
      const res = await fetch(r.url);
      if (!res.ok) die(`download failed: ${res.status}`);
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log(`wrote ${out} (rendered ${r.updatedAt})`);
      return;
    }
    case "edit": {
      const [id, file] = rest;
      if (!id || !file) die("usage: edit <id> <edit.json>");
      const r = applyEditChunked(id, readJson(file));
      console.log(`${r.summary}; now v${r.version}${r.newIds.length ? `; new ids: ${r.newIds.join(", ")}` : ""}`);
      return;
    }
    case "set": {
      const [id, file] = rest;
      if (!id || !file) die("usage: set <id> <scene.json>");
      const data = readJson(file);
      // Replace in two steps so big scenes stay under the command-line limit:
      // clear (with appState), then add the elements in chunks.
      run("admin:setScene", { id, b64: b64({ elements: [], appState: data.appState }) });
      const r = applyEditChunked(id, { add: data.elements || [] });
      console.log(`replaced scene (${(data.elements || []).length} elements); now v${r.version}`);
      return;
    }
    case "new": {
      const [title, owner] = rest;
      if (!title) die('usage: new "<title>" [owner-email]');
      const id = run("admin:createSketch", owner ? { title, owner } : { title });
      console.log(id);
      return;
    }
    case "session": {
      const [email] = rest;
      const r = run("admin:devSession", email ? { email } : {});
      console.log(r.token);
      return;
    }
    default:
      die(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n"));
  }
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => die(e.message || String(e)));
