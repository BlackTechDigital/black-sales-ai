import { readdir, readFile } from "node:fs/promises";
const files = await readdir(new URL("../dist/assets/", import.meta.url));
const forbidden = [
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "service_role",
  "refresh_token",
  "access_token",
  "@supabase/supabase-js",
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
  "Client bundle: no server credential identifiers or Supabase session implementation.",
);
