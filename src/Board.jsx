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
// repair bindings. Everything is passed through so new arrows can bind to
// existing shapes by id.
function normalizeElements(raw) {
  const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
  const isSkeleton = (el) => el.versionNonce === undefined;
  const hasSkeleton = list.some(isSkeleton);
  let elements = list;
  if (hasSkeleton) {
    // Full (already stored) text elements must NOT go through the converter:
    // it treats x/y as the text's alignment anchor and would shift centred
    // labels up-left by half their size. Full shapes/arrows are passed so
    // skeleton arrows can bind to them by id; stored texts are appended after.
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
  const lastJson = useRef(""); // serialized scene last synced
  const saveTimer = useRef(null);
  const pngTimer = useRef(null);
  const saving = useRef(false);

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

  const applyScene = useCallback(
    (s) => {
      let rawElements = [];
      let rawAppState = {};
      try {
        rawElements = JSON.parse(s.elements || "[]");
        rawAppState = JSON.parse(s.appState || "{}");
      } catch (e) {
        setStatus({ text: "stored sketch is unreadable", err: true });
        return;
      }
      const { elements, expanded } = normalizeElements(rawElements);
      const restored = restoreAppState(rawAppState, null);
      const patch = { viewBackgroundColor: restored.viewBackgroundColor };
      excal.updateScene({ elements, appState: patch, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      appliedVersion.current = s.version;
      // When shorthand elements were expanded, leave lastJson empty so the next
      // onChange writes the fully expanded scene back to the cloud.
      lastJson.current = expanded ? "" : serializeAsJSON(elements, { ...excal.getAppState(), ...patch }, excal.getFiles(), "local");
      const who = s.updatedBy === "browser" ? "loaded" : `updated by ${s.updatedBy}`;
      setStatus({ text: `${who} ${timeNow()}`, err: false });
      setTimeout(() => schedulePng(excal.getSceneElementsIncludingDeleted(), excal.getAppState(), excal.getFiles()), 50);
    },
    [excal, schedulePng],
  );

  // Apply cloud changes (from Claude, the CLI, or another browser).
  useEffect(() => {
    if (!excal || !scene) return;
    if (saving.current) return; // reconciled after the save settles
    if (scene.version === appliedVersion.current) return;
    clearTimeout(saveTimer.current);
    applyScene(scene);
  }, [excal, scene, applyScene]);

  const onChange = useCallback(
    (elements, appState, files) => {
      if (!excal || !appliedVersion.current) return; // not loaded yet
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const json = serializeAsJSON(elements, appState, files, "local");
        if (json === lastJson.current) return;
        const parsed = JSON.parse(json);
        saving.current = true;
        try {
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
            setStatus({ text: `saved ${timeNow()}`, err: false });
            schedulePng(elements, appState, files);
          } else {
            setStatus({ text: "newer version in the cloud, reloading…", err: false });
          }
        } catch (e) {
          setStatus({ text: `save failed: ${e?.data || e?.message || e}`, err: true });
        } finally {
          saving.current = false;
          const latest = sceneRef.current;
          if (latest && latest.version !== appliedVersion.current) applyScene(latest);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [excal, save, token, id, applyScene, schedulePng],
  );

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
