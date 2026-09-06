// Pure helpers for editing an Excalidraw element list (no Convex endpoints).
// Shared by the chat assistant's update_sketch tool and the admin CLI.

export type Edit = {
  add?: Record<string, unknown>[];
  update?: { id: string; patch: Record<string, unknown> }[];
  remove?: string[];
};

export const MAX_SCENE_BYTES = 900_000; // Convex document limit is 1 MB

export function randomId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// Applies an edit and returns the new element list plus a short summary.
// Throws with a readable message on invalid input.
export function applyEdit(elementsJson: string, edit: Edit): { elements: unknown[]; summary: string; newIds: string[] } {
  let elements: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(elementsJson || "[]");
    elements = Array.isArray(parsed) ? parsed.filter(isObj) : [];
  } catch {
    elements = [];
  }
  const byId = new Map(elements.map((e) => [String(e.id), e]));
  let removed = 0;
  let updated = 0;
  const newIds: string[] = [];

  // Remove (plus text bound inside removed containers).
  const removeIds = new Set((edit.remove ?? []).map(String));
  if (removeIds.size) {
    for (const e of elements) {
      if (e.containerId && removeIds.has(String(e.containerId))) removeIds.add(String(e.id));
    }
    const before = elements.length;
    elements = elements.filter((e) => !removeIds.has(String(e.id)));
    removed = before - elements.length;
    for (const e of elements) {
      // Drop dangling references so the browser does not choke on them.
      if (Array.isArray(e.boundElements)) {
        e.boundElements = (e.boundElements as { id: string }[]).filter((b) => !removeIds.has(String(b.id)));
      }
      for (const key of ["startBinding", "endBinding"] as const) {
        const b = e[key] as { elementId?: string } | null | undefined;
        if (b && b.elementId && removeIds.has(String(b.elementId))) e[key] = null;
      }
    }
  }

  // Update: shallow patch; `label: {text}` patches the bound text element;
  // moving a container moves its bound text with it.
  for (const u of edit.update ?? []) {
    if (!u || typeof u.id !== "string" || !isObj(u.patch)) throw new Error("Each update needs {id, patch}.");
    const idx = elements.findIndex((e) => e.id === u.id);
    if (idx < 0) throw new Error(`No element with id "${u.id}".`);
    const el = elements[idx];
    const patch = { ...u.patch };
    delete patch.id;
    const label = patch.label;
    delete patch.label;
    const boundText = (Array.isArray(el.boundElements) ? (el.boundElements as { id: string; type: string }[]) : []).find(
      (b) => b.type === "text",
    );
    if (isObj(label) && typeof label.text === "string") {
      const t = boundText && byId.get(boundText.id);
      if (t) {
        t.text = label.text;
        t.originalText = label.text;
        if (typeof label.fontSize === "number") t.fontSize = label.fontSize;
      } else if (el.type === "text") {
        patch.text = label.text;
        patch.originalText = label.text;
      } else {
        // No bound text yet: recreate as a shorthand label on the shape so the
        // browser expands it (it will bind the text on load).
        patch.label = label;
      }
    }
    if (typeof patch.text === "string" && el.type === "text") patch.originalText = patch.text;
    const dx = typeof patch.x === "number" ? patch.x - Number(el.x || 0) : 0;
    const dy = typeof patch.y === "number" ? patch.y - Number(el.y || 0) : 0;
    Object.assign(el, patch);
    if ((dx || dy) && boundText) {
      const t = byId.get(boundText.id);
      if (t) {
        t.x = Number(t.x || 0) + dx;
        t.y = Number(t.y || 0) + dy;
      }
    }
    updated++;
  }

  // Add: shorthand or full elements; assign ids when missing.
  for (const raw of edit.add ?? []) {
    if (!isObj(raw) || typeof raw.type !== "string") throw new Error("Each added element needs a string `type`.");
    const el = { ...raw };
    if (typeof el.id !== "string" || !el.id || byId.has(el.id)) el.id = randomId();
    if (typeof el.x !== "number") el.x = 0;
    if (typeof el.y !== "number") el.y = 0;
    elements.push(el);
    byId.set(String(el.id), el);
    newIds.push(String(el.id));
  }

  const out = JSON.stringify(elements);
  if (out.length > MAX_SCENE_BYTES) throw new Error("The sketch is too large to store (over ~900 KB). Remove some elements first.");

  const bits: string[] = [];
  if (newIds.length) bits.push(`added ${newIds.length}`);
  if (updated) bits.push(`updated ${updated}`);
  if (removed) bits.push(`removed ${removed}`);
  return { elements, summary: bits.join(", ") || "no changes", newIds };
}

// Compact, model-friendly description of the scene.
export function summarizeElements(elementsJson: string): unknown[] {
  let elements: Record<string, unknown>[] = [];
  try {
    elements = (JSON.parse(elementsJson || "[]") as unknown[]).filter(isObj);
  } catch {
    return [];
  }
  const r = (n: unknown) => (typeof n === "number" ? Math.round(n) : n);
  return elements
    .filter((e) => !e.isDeleted)
    .map((e) => {
      const o: Record<string, unknown> = { id: e.id, type: e.type, x: r(e.x), y: r(e.y), w: r(e.width), h: r(e.height) };
      if (typeof e.text === "string") o.text = e.text;
      if (e.containerId) o.containerId = e.containerId;
      if (e.strokeColor && e.strokeColor !== "#1e1e1e") o.strokeColor = e.strokeColor;
      if (e.backgroundColor && e.backgroundColor !== "transparent") o.backgroundColor = e.backgroundColor;
      if (e.strokeStyle && e.strokeStyle !== "solid") o.strokeStyle = e.strokeStyle;
      const sb = e.startBinding as { elementId?: string } | null;
      const eb = e.endBinding as { elementId?: string } | null;
      if (sb?.elementId) o.startBoundTo = sb.elementId;
      if (eb?.elementId) o.endBoundTo = eb.elementId;
      if (isObj(e.label) && typeof (e.label as { text?: unknown }).text === "string") o.label = (e.label as { text: string }).text;
      if (isObj(e.start) && (e.start as { id?: string }).id) o.startBoundTo = (e.start as { id: string }).id;
      if (isObj(e.end) && (e.end as { id?: string }).id) o.endBoundTo = (e.end as { id: string }).id;
      if (Array.isArray(e.points) && (e.type === "arrow" || e.type === "line")) {
        o.points = (e.points as number[][]).map((p) => [r(p[0]), r(p[1])]);
      }
      if (e.type === "freedraw") o.note = "hand-drawn stroke";
      return o;
    });
}
