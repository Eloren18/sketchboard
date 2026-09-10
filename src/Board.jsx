import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Excalidraw,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { api } from "../convex/_generated/api";

const SAVE_DEBOUNCE_MS = 500;
const PNG_DEBOUNCE_MS = 2000;

// Elements without a versionNonce were written by hand (Claude/CLI) as
// Excalidraw "skeleton" elements: expand them (labels, arrow bindings) and
// repair bindings. Full shapes/arrows are passed so new arrows can bind to
// existing shapes by id; already-stored texts must NOT go through the
// converter (it treats x/y as the alignment anchor and would shift them).
function normalizeElements(raw) {
  const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
  const isSkeleton = (el) => el.versionNonce === undefined;
  const hasSkeleton = list.some(isSkeleton);
  let elements = list;
  if (hasSkeleton) {
    const fullTexts = list.filter((el) => !isSkeleton(el) && el.type === "text");
    const input = list.filter((el) => isSkeleton(el) || el.type !== "text");
    try {
      elements = [...convertToExcalidrawElements(input, { regenerateIds: false }), ...fullTexts];
    } catch (e) {
      console.error("convertToExcalidrawElements failed", e);
    }
  }
  const restored = restoreElements(elements, null, { refreshDimensions: false, repairBindings: true });
  return { elements: restored, expanded: hasSkeleton };
}

const changedSince = (el, snap) => !snap || el.version !== snap.version || el.versionNonce !== snap.versionNonce;

// Three-way merge of the local canvas with a newer cloud scene, using the last
// synced scene as the common base:
//  - an element the user changed since the base wins over the cloud copy;
//  - an element the user did not touch takes the cloud copy (including cloud
//    deletions: present in the base but missing from the cloud → dropped);
//  - elements new on either side are kept.
function mergeElements(local, remote, base) {
  const localById = new Map(local.map((e) => [e.id, e]));
  const remoteIds = new Set(remote.map((e) => e.id));
  const out = [];
  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) out.push(r);
    else if (changedSince(l, base.get(r.id))) out.push(l);
    else out.push(r);
  }
  for (const l of local) {
    if (remoteIds.has(l.id)) continue;
    const b = base.get(l.id);
    if (!b || changedSince(l, b)) out.push(l); // new locally, or edited after the cloud removed it
  }
  return out;
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

export default function Board({ token, id }) {
  const scene = useQuery(api.sketches.get, { token, id });
  const save = useMutation(api.sketches.save);
  const generateUploadUrl = useMutation(api.sketches.generateUploadUrl);
  const setPng = useMutation(api.sketches.setPng);

  const [excal, setExcal] = useState(null);
  const [status, setStatus] = useState({ text: "loading…", err: false });

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const appliedVersion = useRef(0); // cloud version this browser is in sync with
  const lastJson = useRef(""); // serialized scene last synced (what `base` was built from)
  const base = useRef(new Map()); // id → element as last synced, for merging
  const saveTimer = useRef(null);
  const pngTimer = useRef(null);
  const saving = useRef(false); // a save is in flight
  const dirty = useRef(false); // changes arrived while a save was in flight

  const schedulePng = useCallback(
    (elements, appState, files) => {
      clearTimeout(pngTimer.current);
      pngTimer.current = setTimeout(async () => {
        try {
          const live = elements.filter((e) => !e.isDeleted);
          if (!live.length) return;
          const blob = await exportToBlob({
            elements: live,
            appState: { ...appState, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false },
            files,
            mimeType: "image/png",
            exportPadding: 24,
            maxWidthOrHeight: 1800,
          });
          const url = await generateUploadUrl({ token });
          const r = await fetch(url, { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
          if (!r.ok) throw new Error(`upload ${r.status}`);
          const { storageId } = await r.json();
          await setPng({ token, id, storageId });
        } catch (e) {
          console.warn("png export failed", e);
        }
      }, PNG_DEBOUNCE_MS);
    },
    [generateUploadUrl, setPng, token, id],
  );

  const setSynced = useCallback((elements, appState, files) => {
    const json = serializeAsJSON(elements, appState, files, "local");
    lastJson.current = json;
    base.current = new Map(elements.map((e) => [e.id, e]));
    return json;
  }, []);

  // Bring a cloud scene onto the canvas, keeping any unsaved local edits.
  // Returns true when local edits survived and therefore need saving.
  const applyRemote = useCallback(
    (s) => {
      let rawElements = [];
      let rawAppState = {};
      try {
        rawElements = JSON.parse(s.elements || "[]");
        rawAppState = JSON.parse(s.appState || "{}");
      } catch {
        setStatus({ text: "stored sketch is unreadable", err: true });
        return false;
      }
      const { elements: remote, expanded } = normalizeElements(rawElements);
      const local = appliedVersion.current ? excal.getSceneElementsIncludingDeleted() : [];
      const merged = appliedVersion.current ? mergeElements(local, remote, base.current) : remote;
      const localKept = merged.some((e) => !remote.includes(e));
      const restored = restoreAppState(rawAppState, null);
      const patch = { viewBackgroundColor: restored.viewBackgroundColor };
      excal.updateScene({ elements: merged, appState: patch, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      appliedVersion.current = s.version;
      // The cloud copy is what we are in sync with; anything kept locally (or
      // any expanded shorthand) differs from it and is saved right after.
      setSynced(remote, { ...excal.getAppState(), ...patch }, excal.getFiles());
      const who = s.updatedBy === "browser" ? "loaded" : `updated by ${s.updatedBy}`;
      setStatus({ text: `${who} ${timeNow()}${localKept ? " (merged with your edits)" : ""}`, err: false });
      setTimeout(() => schedulePng(excal.getSceneElementsIncludingDeleted(), excal.getAppState(), excal.getFiles()), 50);
      return localKept || expanded;
    },
    [excal, schedulePng, setSynced],
  );

  // Saves are serialized: one in flight at a time; anything that changes
  // meanwhile is picked up by one more save afterwards. On a version conflict
  // the newer cloud scene is merged in and the result is saved on top of it.
  const runSave = useCallback(async () => {
    if (!excal || !appliedVersion.current) return;
    if (saving.current) {
      dirty.current = true;
      return;
    }
    const elements = excal.getSceneElementsIncludingDeleted();
    const appState = excal.getAppState();
    const files = excal.getFiles();
    const json = serializeAsJSON(elements, appState, files, "local");
    if (json === lastJson.current) return;
    saving.current = true;
    let needsRetry = false;
    try {
      const parsed = JSON.parse(json);
      const r = await save({
        token,
        id,
        elements: JSON.stringify(parsed.elements),
        appState: JSON.stringify(parsed.appState),
        baseVersion: appliedVersion.current,
      });
      if (r.ok) {
        appliedVersion.current = r.version;
        lastJson.current = json;
        base.current = new Map(elements.map((e) => [e.id, e]));
        setStatus({ text: `saved ${timeNow()}`, err: false });
        schedulePng(elements, appState, files);
      } else {
        // Someone else (Claude, another tab) saved first: wait for that version
        // to arrive on the subscription, merge, then save again.
        setStatus({ text: "merging with a newer version…", err: false });
        for (let i = 0; i < 30 && (!sceneRef.current || sceneRef.current.version < r.version); i++) {
          await new Promise((res) => setTimeout(res, 100));
        }
        const latest = sceneRef.current;
        if (latest && latest.version !== appliedVersion.current) applyRemote(latest);
        needsRetry = true;
      }
    } catch (e) {
      setStatus({ text: `save failed: ${e?.data || e?.message || e}`, err: true });
    } finally {
      saving.current = false;
    }
    if (needsRetry || dirty.current) {
      dirty.current = false;
      runSave();
    } else {
      const latest = sceneRef.current;
      if (latest && latest.version !== appliedVersion.current && applyRemote(latest)) runSave();
    }
  }, [excal, save, token, id, applyRemote, schedulePng]);

  // Apply cloud changes (from Claude, the CLI, or another browser).
  useEffect(() => {
    if (!excal || !scene) return;
    if (saving.current) return; // reconciled after the save settles
    if (scene.version === appliedVersion.current) return;
    clearTimeout(saveTimer.current);
    if (applyRemote(scene)) runSave();
  }, [excal, scene, applyRemote, runSave]);

  const onChange = useCallback(() => {
    if (!excal || !appliedVersion.current) return; // not loaded yet
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(runSave, SAVE_DEBOUNCE_MS);
  }, [excal, runSave]);

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(pngTimer.current);
  }, []);

  return (
    <div className="sb-board-inner">
      <Excalidraw excalidrawAPI={setExcal} onChange={onChange} />
      <div className={`sb-status${status.err ? " err" : ""}`}>{scene === null ? "sketch not found" : status.text}</div>
    </div>
  );
}
