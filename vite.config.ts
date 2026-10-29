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
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
