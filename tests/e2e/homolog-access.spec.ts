import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import application from "../../server/index";
import {
  withHomologAccess,
  type HomologBindings,
} from "../../server/homolog-access";
import {
  previewHeaders,
  renderSitePreview,
} from "../../server/studio-preview-renderer";
import { previewFixture } from "../fixtures/studio-preview";

// Disposable TLS + synthetic Basic credentials. The only non-app route below
// is inside this test server, never exported or registered by either Worker.
const username = "browser-fixture";
const password = "synthetic-browser-password-only-1234567";
let server: Server, directory: string, origin: string;
let secret: string | undefined;
let downstream: string[] = [],
  assetAuthHeaders: (string | null)[] = [];
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "black-sales-hml-tls-"));
  const certificate = join(directory, "certificate.pem"),
    key = join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const gate = withHomologAccess({
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      downstream.push(path);
      expect(request.headers.has("Authorization")).toBe(false);
      expect((env as HomologBindings).HOMOLOG_BASIC_AUTH).toBeUndefined();
      if (path === "/__test/sandbox-frame") {
        const rendered = renderSitePreview(previewFixture());
        return new Response(rendered.html, {
          headers: previewHeaders(rendered.csp),
        });
      }
      return application.fetch(request, env);
    },
  });
  server = createServer(
    { cert: await readFile(certificate), key: await readFile(key) },
    async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = new Request(origin + incoming.url, {
          method: incoming.method,
          headers,
          ...(chunks.length
            ? { body: Uint8Array.from(Buffer.concat(chunks)) }
            : {}),
        });
        const response = await gate.fetch(request, {
          HOMOLOG_BASIC_AUTH: secret,
          APP_ORIGIN: origin,
          SUPABASE_URL: "https://auth.example.test",
          SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
          ASSETS: {
            async fetch(req) {
              assetAuthHeaders.push(req.headers.get("Authorization"));
              const path = new URL(req.url).pathname;
              if (path.startsWith("/assets/")) {
                const name = path.slice("/assets/".length);
                if (!/^[A-Za-z0-9_-]+\.(js|css)$/.test(name))
                  return new Response(null, { status: 404 });
                return new Response(
                  await readFile(
                    new URL(`../../dist/assets/${name}`, import.meta.url),
                  ),
                  {
                    headers: {
                      "Content-Type": name.endsWith(".css")
                        ? "text/css"
                        : "text/javascript",
                      "Cache-Control": "public, max-age=31536000",
                    },
                  },
                );
              }
              return new Response(
                await readFile(
                  new URL("../../dist/index.html", import.meta.url),
                ),
                { headers: { "Content-Type": "text/html" } },
              );
            },
          },
        });
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) =>
          outgoing.setHeader(name, value),
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.statusCode = 500;
        outgoing.end("Test fixture failure");
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected ephemeral TLS port");
  origin = `https://127.0.0.1:${address.port}`;
});
test.beforeEach(() => {
  secret = `${username}:${password}`;
  downstream = [];
  assetAuthHeaders = [];
});
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});
test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("native Basic authentication loads the built app while Supabase authorization stays required", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    // Trust only this disposable self-signed fixture; not an application flag.
    ignoreHTTPSErrors: true,
    httpCredentials: { username, password, origin },
    viewport: testInfo.project.use.viewport,
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "Entre no seu workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Entrar no workspace" }),
  ).toBeVisible();
  expect(downstream).toContain("/api/session");
  expect(assetAuthHeaders.length).toBeGreaterThan(1);
  expect(assetAuthHeaders.every((value) => value === null)).toBe(true);
  const denied = await page.evaluate(async () => {
    const response = await fetch("/api/leads");
    return { status: response.status, text: await response.text() };
  });
  expect(denied.status).toBe(401);
  expect(denied.text).toContain("Entre para acessar seus dados");

  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.src = "/__test/sandbox-frame";
    document.querySelector("main")!.appendChild(frame);
  });
  await expect(
    page.frameLocator("iframe").getByRole("heading", {
      name: "Uma presença digital com personalidade.",
    }),
  ).toBeVisible();
  expect(downstream).toContain("/__test/sandbox-frame");
  expect(
    await page.evaluate(() => {
      try {
        return !!document.querySelector("iframe")?.contentWindow?.document.body;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
});

test("anonymous requests cannot reuse authenticated asset responses or session cookies", async ({
  playwright,
}) => {
  const authorized = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: { username, password, origin },
  });
  const anonymous = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await authorized.get(origin);
    const html = await page.text();
    const asset = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    const response = await authorized.get(origin + asset);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["vary"]).toContain("Authorization");
    const count = downstream.length;
    for (const path of [
      "/",
      asset!,
      "/api/session",
      "/__test/sandbox-frame",
      "/reset-password",
    ]) {
      const blocked = await anonymous.get(origin + path, {
        headers: { Cookie: "__Host-bs-access=synthetic-session" },
      });
      expect(blocked.status()).toBe(401);
      expect(blocked.headers()["cache-control"]).toBe("no-store");
    }
    expect(downstream).toHaveLength(count);
  } finally {
    await authorized.dispose();
    await anonymous.dispose();
  }
});

test("missing secret returns 503 even to a browser supplying valid Basic credentials", async ({
  browser,
}, testInfo) => {
  secret = undefined;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
    },
    viewport: testInfo.project.use.viewport,
  });
  contexts.push(context);
  const page = await context.newPage();
  const response = await page.goto(origin + "/studio");
  expect(response?.status()).toBe(503);
  await expect(page.getByText(/Homologação indisponível/)).toBeVisible();
  expect(downstream).toEqual([]);
  expect(assetAuthHeaders).toEqual([]);
});

test("incorrect Basic credentials never reach the application", async ({
  playwright,
}) => {
  const context = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: {
      username,
      password: "incorrect-synthetic-password-12345678",
      origin,
    },
  });
  try {
    const response = await context.get(origin + "/api/session");
    expect(response.status()).toBe(401);
    expect(downstream).toEqual([]);
  } finally {
    await context.dispose();
  }
});
