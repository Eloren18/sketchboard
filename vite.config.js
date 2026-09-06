import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/sketchboard/").
// Locally the app is served from "/".
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/",
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  server: { port: 5180, strictPort: true, host: "localhost" },
  build: { chunkSizeWarningLimit: 4000 },
});
