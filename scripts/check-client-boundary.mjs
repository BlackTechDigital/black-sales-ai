import { readdir, readFile } from "node:fs/promises";
const files = await readdir(new URL("../dist/assets/", import.meta.url));
const forbidden = [
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "APP_LOCAL_ORIGINS",
  "service_role",
  "@supabase/supabase-js",
  "GoTrueClient",
  "STUDIO_AI_API_KEY",
  "STUDIO_AI_ENDPOINT",
  "STUDIO_AI_ALLOWED_MODELS",
  "STUDIO_AI_USAGE_GUARD",
  "BLACK_SALES_STUDIO_SYSTEM_V1",
  "STUDIO_SITE_EXPORT_ENABLED",
  "export-review-v1:",
];
for (const file of files.filter((file) => file.endsWith(".js"))) {
  const source = await readFile(
    new URL(`../dist/assets/${file}`, import.meta.url),
    "utf8",
  );
  for (const marker of forbidden) {
    if (source.includes(marker))
      throw new Error(`Server credential boundary crossed: ${marker}`);
  }
}
console.log(
  "Client bundle: no server credential identifiers, internal AI prompts or Supabase SDK implementation.",
);
