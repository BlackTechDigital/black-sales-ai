import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
// Built application under production-style CSP, with no Vite inline HMR or
// insecure-origin browser flags. Fake LAN/HTTPS hosts never leave this process.
export async function builtBrowserApp(
  page: Page,
  origin = "http://localhost:5173",
) {
  for (const path of ["/", "/studio"])
    await page.route(origin + path, async (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "Referrer-Policy": "no-referrer",
        },
        body: await readFile(
          new URL("../../dist/index.html", import.meta.url),
          "utf8",
        ),
      }),
    );
  await page.route("**/assets/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (!/^[a-zA-Z0-9_-]+\.(js|css)$/.test(name))
      throw new Error("Unexpected built asset");
    await route.fulfill({
      status: 200,
      contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
      body: await readFile(
        new URL(`../../dist/assets/${name}`, import.meta.url),
      ),
    });
  });
}
