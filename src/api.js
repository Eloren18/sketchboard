import { ConvexReactClient } from "convex/react";

// Production deployment (see SETUP-Convex.txt). `npx convex dev` writes
// VITE_CONVEX_URL into .env.local for local development against the dev deployment.
export const PROD_CONVEX_URL = "https://dynamic-dotterel-890.convex.cloud";
export const CONVEX_URL = import.meta.env.VITE_CONVEX_URL || PROD_CONVEX_URL;

export const ADMIN_EMAIL = "keremladkeholland@gmail.com";
export const SESSION_KEY = "sketchboard.session";
export const LAST_SKETCH_KEY = "sketchboard.lastSketch";

export const convex = new ConvexReactClient(CONVEX_URL, { unsavedChangesWarning: false });

export function getToken() {
  try {
    return localStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(SESSION_KEY, t);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}
export function getLastSketch() {
  try {
    return localStorage.getItem(LAST_SKETCH_KEY) || "";
  } catch {
    return "";
  }
}
export function setLastSketch(id) {
  try {
    if (id) localStorage.setItem(LAST_SKETCH_KEY, id);
    else localStorage.removeItem(LAST_SKETCH_KEY);
  } catch {}
}

// Readable text for errors thrown by Convex functions (ConvexError carries `data`).
export function errText(e, fallback = "Something went wrong.") {
  if (e && typeof e.data === "string" && e.data) return e.data;
  if (e && e.data && typeof e.data.message === "string") return e.data.message;
  if (e && typeof e.message === "string" && e.message && !/Server Error|Uncaught/i.test(e.message)) return e.message;
  return fallback;
}
