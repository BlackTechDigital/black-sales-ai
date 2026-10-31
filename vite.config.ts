import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Anchor private directories to this repository. A parent named "work" (as on
// GitHub Actions) must not cause the whole application to become inaccessible.
const privateDirectories = ["server", "supabase", "work"].map((directory) =>
  fileURLToPath(new URL(`./${directory}/**`, import.meta.url)).replaceAll(
    "\\",
    "/",
  ),
);
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    fs: {
      strict: true,
      deny: [
        "**/.git/**",
        "**/.env",
        "**/.env.*",
        "**/.dev.vars",
        "**/.dev.vars.*",
        ...privateDirectories,
        "**/*.{crt,pem,key}",
      ],
    },
    // Preserve the browser's Origin and Host; auth/CSRF are checked by the API.
    // The backend remains loopback-only even when Vite listens on the LAN.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
});
