import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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
        "**/server/**",
        "**/supabase/**",
        "**/work/**",
        "**/*.{crt,pem,key}",
      ],
    },
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
