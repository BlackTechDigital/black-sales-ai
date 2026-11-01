import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/index";
import homolog from "../server/homolog";
import {
  withHomologAccess,
  type HomologBindings,
} from "../server/homolog-access";

// Synthetic credentials only. No account, provider or remote database is used.
const fixtureCredential =
  "fixture-user:" + "synthetic-password-for-tests-only-12345";
const env: HomologBindings = {
  HOMOLOG_BASIC_AUTH: fixtureCredential,
  APP_ORIGIN: "https://hml.example.test",
  SUPABASE_URL: "https://auth.example.test",
  SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-test-key",
};
const authorization = (value = fixtureCredential) => `Basic ${btoa(value)}`;
const request = (path = "/", init: RequestInit = {}) =>
  new Request(`https://hml.example.test${path}`, init);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("homologation gate before all application responses", () => {
  it.each([
    "/",
    "/index.html",
    "/assets/app.js",
    "/assets/app.css",
    "/favicon.ico",
    "/studio",
    "/reset-password?code=synthetic-private-query",
    "/api/session",
    "/api/login",
    "/api/studio/projects/fixture/site-preview/versions/fixture/frame",
    "/api/studio/projects/fixture/site-preview/versions/fixture/export",
    "/missing-route",
    "/%61pi/session",
  ])("blocks %s before the application or assets are called", async (path) => {
    const next = vi.fn(async () => new Response("must remain private"));
    const gate = withHomologAccess({ fetch: next });
    const response = await gate.fetch(request(path), env);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic realm=");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(await response.text()).not.toContain("synthetic-private-query");
    expect(next).not.toHaveBeenCalled();
  });
  it.each(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
    "has no %s method exemption",
    async (method) => {
      const next = vi.fn(async () => new Response("must remain private"));
      const response = await withHomologAccess({ fetch: next }).fetch(
        request("/api/login", { method }),
        env,
      );
      expect(response.status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    "",
    "fixture-user:short",
    "missing-colon-and-username",
    "user name:" + "a".repeat(32),
    "user:" + " ".repeat(32),
    "user:" + "a".repeat(129),
    "user:" + "á".repeat(32),
    "x".repeat(65) + ":" + "a".repeat(32),
    fixtureCredential + "\n",
  ])("fails closed with absent/invalid server secret %#", async (secret) => {
    const next = vi.fn(async () => new Response("must remain private"));
    const response = await withHomologAccess({ fetch: next }).fetch(
      request("/", { headers: { Authorization: authorization() } }),
      { ...env, HOMOLOG_BASIC_AUTH: secret },
    );
    expect(response.status).toBe(503);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(next).not.toHaveBeenCalled();
  });
  it.each([
    "Bearer synthetic-token",
    "Basic !!!=",
    "Basic YQ==",
    "Basic " + btoa("other-user:" + "a".repeat(32)),
    "Basic " + btoa("fixture-user:" + "a".repeat(32)),
    "Basic " + btoa(fixtureCredential.toUpperCase()),
    "Basic " + btoa(fixtureCredential) + ", Basic " + btoa(fixtureCredential),
    "Basic\t" + btoa(fixtureCredential),
    "Basic  " + btoa(fixtureCredential),
    "Basic " + btoa("user:" + "a".repeat(129)),
    "Basic " + "a".repeat(513),
    "Basic " + btoa("user:" + "\u0000".repeat(32)),
  ])(
    "rejects malformed, oversized or incorrect credentials %#",
    async (header) => {
      const next = vi.fn(async () => new Response("must remain private"));
      const response = await withHomologAccess({ fetch: next }).fetch(
        request("/", { headers: { Authorization: header } }),
        env,
      );
      expect(response.status).toBe(401);
      expect(next).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(header);
    },
  );
  it.each([
    "http://hml.example.test/",
    "http://localhost/",
    "http://192.168.18.7/",
  ])("never challenges or forwards credentials over HTTP: %s", async (url) => {
    const next = vi.fn(async () => new Response("private"));
    const response = await withHomologAccess({ fetch: next }).fetch(
      new Request(url, { headers: { Authorization: authorization() } }),
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
  it("forwards body, session, Origin, context and response without forwarding the Basic secret", async () => {
    const body = JSON.stringify({ synthetic: true });
    const response = new Response("application response", {
      status: 202,
      headers: {
        "Set-Cookie": "__Host-fixture=value; Secure; HttpOnly; Path=/",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
    const next = vi.fn(
      async (
        req: Request,
        bindings: HomologBindings,
        ctx?: ExecutionContext,
      ) => {
        expect(req.headers.has("Authorization")).toBe(false);
        expect(req.headers.has("Proxy-Authorization")).toBe(false);
        expect(req.headers.get("Cookie")).toBe(
          "__Host-bs-access=synthetic-session",
        );
        expect(req.headers.get("Origin")).toBe(env.APP_ORIGIN);
        expect(req.headers.get("Sec-Fetch-Site")).toBe("same-origin");
        expect(req.method).toBe("POST");
        expect(await req.text()).toBe(body);
        expect(bindings.HOMOLOG_BASIC_AUTH).toBeUndefined();
        expect(bindings.SUPABASE_PUBLISHABLE_KEY).toBe(
          env.SUPABASE_PUBLISHABLE_KEY,
        );
        expect(ctx).toBe(context);
        return response;
      },
    );
    const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const result = await withHomologAccess({ fetch: next }).fetch(
      request("/api/fixture", {
        method: "POST",
        headers: {
          Authorization: authorization().replace("Basic", "bAsIc"),
          "Proxy-Authorization": "Basic synthetic-proxy-credential",
          Origin: env.APP_ORIGIN!,
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          Cookie: "__Host-bs-access=synthetic-session",
        },
        body,
      }),
      env,
      context,
    );
    expect(result.status).toBe(202);
    expect(await result.text()).toBe("application response");
    expect(result.headers.get("Set-Cookie")).toBe(
      response.headers.get("Set-Cookie"),
    );
    expect(result.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'",
    );
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Vary")).toBe("Authorization, Cookie");
    expect(next).toHaveBeenCalledOnce();
  });
  it("fails closed on cryptographic errors without exposing or logging private data", async () => {
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
    ];
    const next = vi.fn(async () => new Response("private"));
    const subtle = crypto.subtle;
    vi.stubGlobal("crypto", {
      subtle,
      getRandomValues: () => {
        throw new Error(fixtureCredential);
      },
    });
    const response = await withHomologAccess({ fetch: next }).fetch(
      request("/?code=synthetic-query", {
        headers: { Authorization: authorization() },
      }),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(
      /synthetic|fixture-user|password/,
    );
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe("real application remains behind the homologation entry", () => {
  it("does not consult assets or any network before Basic authentication", async () => {
    const assets = vi.fn(async () => new Response("private asset"));
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    for (const path of [
      "/",
      "/assets/app.js",
      "/api/session",
      "/api/login",
      "/reset-password",
    ]) {
      expect(
        (
          await homolog.fetch(request(path), {
            ...env,
            ASSETS: { fetch: assets },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await homolog.fetch(request(path), {
            ...env,
            HOMOLOG_BASIC_AUTH: undefined,
            ASSETS: { fetch: assets },
          })
        ).status,
      ).toBe(503);
    }
    expect(assets).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("serves real application assets only after removing Basic authorization", async () => {
    const assets = vi.fn(async (req: Request) => {
      expect(req.headers.has("Authorization")).toBe(false);
      return new Response("<html>synthetic asset</html>", {
        headers: { "Content-Type": "text/html" },
      });
    });
    const response = await homolog.fetch(
      request("/studio", { headers: { Authorization: authorization() } }),
      { ...env, ASSETS: { fetch: assets } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self'",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(assets).toHaveBeenCalledOnce();
  });
  it("preserves Supabase login, secure cookies, CSRF and membership checks", async () => {
    let active = true;
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "test@example.test",
    };
    const signIn = vi.fn(async () => ({
      data: {
        user,
        session: {
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
        },
      },
      error: null,
    }));
    const factory = vi.fn(
      () =>
        ({
          auth: { signInWithPassword: signIn },
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { active }, error: null }),
              }),
            }),
          }),
        }) as unknown as SupabaseClient,
    );
    const app = createApp(factory);
    const gated = withHomologAccess({
      fetch: async (req, bindings) => app.fetch(req, bindings),
    });
    const login = (origin = env.APP_ORIGIN!, fetchSite = "same-origin") =>
      request("/api/login", {
        method: "POST",
        headers: {
          Authorization: authorization(),
          Origin: origin,
          "Sec-Fetch-Site": fetchSite,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: user.email,
          password: "synthetic-login-password",
        }),
      });
    const response = await gated.fetch(login(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toMatch(
      /__Host-bs-access=.*HttpOnly/,
    );
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect(await response.text()).not.toContain("synthetic-access");
    expect(
      (await gated.fetch(login("https://untrusted.example.test"), env)).status,
    ).toBe(403);
    expect(
      (await gated.fetch(login(env.APP_ORIGIN!, "cross-site"), env)).status,
    ).toBe(403);
    expect(signIn).toHaveBeenCalledOnce();
    expect(
      (
        await gated.fetch(
          request("/api/leads", {
            headers: { Authorization: authorization() },
          }),
          env,
        )
      ).status,
    ).toBe(401);
    active = false;
    expect((await gated.fetch(login(), env)).status).toBe(403);
  });
});

describe("isolated Cloudflare configuration", () => {
  it("has no public route, secret, AI activation or static asset bypass", async () => {
    const config = JSON.parse(
      await readFile(
        new URL("../wrangler.homolog.json", import.meta.url),
        "utf8",
      ),
    );
    expect(config).toMatchObject({
      name: "black-sales-ai-hml",
      main: "server/homolog.ts",
      workers_dev: false,
      preview_urls: false,
      keep_vars: true,
      assets: {
        binding: "ASSETS",
        directory: "./dist",
        run_worker_first: true,
        not_found_handling: "single-page-application",
      },
      vars: {
        STUDIO_AI_PROVIDER: "disabled",
        STUDIO_SITE_EXPORT_ENABLED: "false",
      },
      observability: { enabled: false },
    });
    for (const field of [
      "routes",
      "route",
      "migrations",
      "durable_objects",
      "account_id",
    ])
      expect(config).not.toHaveProperty(field);
    expect(config.vars).not.toHaveProperty("HOMOLOG_BASIC_AUTH");
    expect(config.vars).not.toHaveProperty("SUPABASE_PUBLISHABLE_KEY");
    expect(config.vars).not.toHaveProperty("APP_LOCAL_ORIGINS");
    const production = JSON.parse(
      await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    );
    expect(production.name).toBe("black-sales-ai");
    expect(production.main).toBe("server/index.ts");
    expect(production).not.toHaveProperty("vars.HOMOLOG_BASIC_AUTH");
  });
});
