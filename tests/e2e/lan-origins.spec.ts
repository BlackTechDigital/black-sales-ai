import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp, type Bindings } from "../../server/index";

// Browser origins/hosts are emulated locally: no route to either physical PC,
// real Supabase, credentials or external network is required. API calls cross
// the actual Vite proxy and the actual auth/CSRF/cookie handlers.
const primary = "http://localhost:5173",
  lan = "http://192.168.18.7:5173";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "lan-browser@example.test",
};
const env: Bindings = {
  APP_ORIGIN: primary,
  APP_LOCAL_ORIGINS: JSON.stringify([lan]),
  SUPABASE_URL: "https://provider.example.test",
  SUPABASE_PUBLISHABLE_KEY: "only-a-browser-test-fixture",
};
let backend: Server,
  vite: ViteDevServer,
  target: string,
  logins = 0;
const observations: {
  origin: string | undefined;
  site: string | undefined;
  host: string | undefined;
}[] = [];
const sessions = new Set<string>();
const factory = (_env: Bindings, token?: string) =>
  ({
    auth: {
      signInWithPassword: async (input: {
        email: string;
        password: string;
      }) => {
        logins++;
        if (
          input.email !== user.email ||
          input.password !== "only-browser-test-password"
        )
          return {
            data: { user: null, session: null },
            error: { status: 401 },
          };
        const access = "synthetic-" + crypto.randomUUID();
        sessions.add(access);
        return {
          data: {
            user,
            session: {
              access_token: access,
              refresh_token: "synthetic-refresh",
              user,
            },
          },
          error: null,
        };
      },
      getUser: async (access: string) => ({
        data: { user: sessions.has(access) ? user : null },
        error: sessions.has(access) ? null : { status: 401 },
      }),
    },
    from: (table: string) => {
      const builder = {
        select: (_value: string) => builder,
        eq: (_key: string, _value: unknown) => builder,
        order: (_key: string, _options?: unknown) => builder,
        maybeSingle: async () => ({
          data:
            table === "app_members"
              ? { active: token !== undefined && sessions.has(token) }
              : null,
          error: null,
        }),
        range: async () => ({ data: [], error: null }),
      };
      return builder;
    },
  }) as unknown as SupabaseClient;
test.beforeAll(async () => {
  const api = createApp(factory);
  backend = createServer(async (req, res) => {
    if (req.url === "/api/login")
      observations.push({
        origin: req.headers.origin,
        site: req.headers["sec-fetch-site"] as string | undefined,
        host: req.headers.host,
      });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks),
      headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const response = await api.fetch(
      new Request("http://" + req.headers.host + req.url, {
        method: req.method,
        headers,
        ...(body.length ? { body } : {}),
      }),
      env,
    );
    const out: Record<string, string | string[]> = Object.fromEntries(
      response.headers,
    );
    if (response.headers.getSetCookie().length)
      out["set-cookie"] = response.headers.getSetCookie();
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const port = (backend.address() as { port: number }).port;
  vite = await createViteServer({
    configFile: new URL("../../vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: false },
      },
    },
  });
  await vite.listen();
  target = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await vite?.close();
  if (backend) {
    backend.close();
    await once(backend, "close");
  }
});

async function bridge(context: BrowserContext) {
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (
      !["localhost", "192.168.18.7", "192.168.18.8"].includes(u.hostname) ||
      u.port !== "5173"
    ) {
      await route.abort();
      return;
    }
    if (u.pathname.startsWith("/api/")) {
      const headers = await req.allHeaders();
      headers.host = u.host;
      // node:http has no cookie jar: only the browser's host-scoped Cookie is
      // forwarded. The transport must not hide a missing session/cookie bug.
      const result = await new Promise<{
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      }>((resolve, reject) => {
        const proxied = httpRequest(
          target + u.pathname + u.search,
          { method: req.method(), headers },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () => {
              const h: Record<string, string> = {};
              for (const [k, v] of Object.entries(response.headers))
                if (v !== undefined) h[k] = Array.isArray(v) ? v.join("\n") : v;
              resolve({
                status: response.statusCode!,
                headers: h,
                body: Buffer.concat(chunks),
              });
            });
          },
        );
        proxied.on("error", reject);
        proxied.end(req.postDataBuffer() ?? undefined);
      });
      await route.fulfill(result);
      return;
    }
    if (u.pathname === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
          "Referrer-Policy": "no-referrer",
        },
        body: await readFile(new URL("../../dist/index.html", import.meta.url)),
      });
      return;
    }
    if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(u.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: u.pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript",
        body: await readFile(
          new URL("../../dist" + u.pathname, import.meta.url),
        ),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      body: "Not part of the LAN browser test",
    });
  });
}
test("PC 1 localhost and PC 2 LAN retain Origin through Vite and keep independent host-only sessions", async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    for (const origin of [primary, lan]) {
      const context = await browser.newContext();
      contexts.push(context);
      await bridge(context);
      const page = await context.newPage();
      await page.goto(origin);
      await expect(
        page.getByRole("button", { name: "Entrar no workspace" }),
      ).toBeVisible();
      await page.getByLabel("E-mail", { exact: true }).fill(user.email);
      await page
        .getByLabel("Senha", { exact: true })
        .fill("only-browser-test-password");
      const observed = observations.length;
      await page.getByRole("button", { name: "Entrar no workspace" }).click();
      await expect(
        page
          .getByRole("link", { name: "Creative Studio", exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
      expect(observations[observed].origin).toBe(origin);
      expect(observations[observed].host).toBe(new URL(origin).host);
      expect(observations[observed].site).not.toBe("cross-site");
      const cookies = (await context.cookies(origin)).filter((c) =>
        c.name.startsWith("bs-"),
      );
      expect(cookies).toHaveLength(2);
      for (const c of cookies) {
        expect(c.domain).toBe(new URL(origin).hostname);
        expect(c.httpOnly).toBe(true);
        expect(c.sameSite).toBe("Strict");
        expect(c.secure).toBe(false);
      }
      expect(
        await context.cookies(origin === lan ? primary : lan),
      ).toHaveLength(0);
      expect(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
      ).toBe(0);
      await page.reload();
      await expect(
        page
          .getByRole("link", { name: "Creative Studio", exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
test("an unlisted LAN host cannot log in through the same proxy", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await bridge(context);
  try {
    const page = await context.newPage();
    await page.goto("http://192.168.18.8:5173");
    await page.getByLabel("E-mail", { exact: true }).fill(user.email);
    await page
      .getByLabel("Senha", { exact: true })
      .fill("only-browser-test-password");
    const before = logins;
    await page.getByRole("button", { name: "Entrar no workspace" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Origem da requisição não autorizada.",
    );
    expect(logins).toBe(before);
    expect(await context.cookies()).toHaveLength(0);
  } finally {
    await context.close();
  }
});
