// Excalidraw loads its fonts from this path (public/fonts). Must be set before
// the editor renders; BASE_URL is "/" locally and "/sketchboard/" on GitHub Pages.
window.EXCALIDRAW_ASSET_PATH = import.meta.env.BASE_URL;

import React from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { convex } from "./api.js";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <ConvexProvider client={convex}>
    <App />
  </ConvexProvider>,
);
