import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type Bindings } from "../server/index";
// The actual installed Supabase SDK is exercised against a simulated Auth HTTP server.
// No hosted Auth, real email, credentials or database are used.
const env: Bindings = {
  APP_ORIGIN: "https://sales.example.test",
  SUPABASE_URL: "https://provider.example.test",
  SUPABASE_PUBLISHABLE_KEY: "server-only-fixture",
};
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "transport@example.test",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: "2026-10-29T00:00:00Z",
};
function session() {
  const now = Math.floor(Date.now() / 1000),
    encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
  const access_token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, iat: now, exp: now + 3600, session_id: "transport-session", amr: [{ method: "recovery", timestamp: now }] })}.test-signature`;
  return {
    access_token,
    refresh_token: "transport-private-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user,
  };
}
function cookieJar() {
  const values = new Map<string, string>();
  return {
    apply(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";")[0],
          i = pair.indexOf("=");
        if (pair.slice(i + 1)) values.set(pair.slice(0, i), pair.slice(i + 1));
        else values.delete(pair.slice(0, i));
      }
    },
    header() {
      return [...values].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Supabase SDK recovery transport", () => {
  it("persists the PKCE verifier only in HttpOnly cookies and redeems the correct flow", async () => {
    const providerCalls: { url: URL; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        providerCalls.push({ url, body });
        if (url.pathname === "/auth/v1/recover") return Response.json({});
        if (url.pathname === "/auth/v1/token") return Response.json(session());
        if (url.pathname === "/auth/v1/user") return Response.json(user);
        if (url.pathname === "/auth/v1/logout")
          return new Response(null, { status: 204 });
        return Response.json(
          { message: "Unexpected test request" },
          { status: 400 },
        );
      }),
    );
    const app = createApp(),
      jar = cookieJar();
    const call = (path: string, body: unknown) =>
      app.request(
        `https://sales.example.test/api/recovery/${path}`,
        {
          method: "POST",
          headers: {
            Origin: env.APP_ORIGIN!,
            "Content-Type": "application/json",
            Cookie: jar.header(),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const requested = await call("request", { email: user.email });
    expect(requested.status).toBe(200);
    jar.apply(requested);
    const sent = providerCalls.find((c) =>
      c.url.pathname.endsWith("/recover"),
    )!;
    expect(sent.body.code_challenge_method).toBe("s256");
    expect(String(sent.body.code_challenge).length).toBeGreaterThan(32);
    const redirect = new URL(sent.url.searchParams.get("redirect_to")!);
    expect(redirect.origin).toBe(env.APP_ORIGIN);
    expect(redirect.pathname).toBe("/reset-password");
    expect(redirect.searchParams.get("sb_flow_id")).toBeNull();
    expect(requested.headers.get("set-cookie")).toContain("HttpOnly");
    expect(jar.header()).toContain("__Host-bs-recovery-pkce=");
    expect(await requested.text()).not.toContain("code_verifier");
    const verified = await call("verify", {
      kind: "code",
      code: "transport-test-code",
    });
    expect(verified.status).toBe(200);
    jar.apply(verified);
    const exchange = providerCalls.find(
      (c) => c.url.searchParams.get("grant_type") === "pkce",
    )!;
    expect(exchange.body.auth_code).toBe("transport-test-code");
    expect(String(exchange.body.code_verifier).length).toBeGreaterThan(32);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(exchange.body.code_verifier)),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(
      sent.body.code_challenge,
    );
    expect(jar.header()).not.toContain("bs-recovery-pkce=");
    expect(jar.header()).not.toContain("__Host-bs-access=");
    const result = await call("password", {
      password: "Transport test password 123!",
      confirmation: "Transport test password 123!",
    });
    expect(result.status).toBe(200);
    expect(
      providerCalls.find(
        (c) => c.url.pathname.endsWith("/user") && c.body.password,
      )?.body.password,
    ).toBe("Transport test password 123!");
    expect(
      providerCalls.some(
        (c) =>
          c.url.pathname.endsWith("/logout") &&
          c.url.searchParams.get("scope") === "global",
      ),
    ).toBe(true);
  });
  it("rejects codes from a browser without its verifier before any provider exchange", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await createApp().request(
      "https://sales.example.test/api/recovery/verify",
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "code",
          code: "private-code",
          flowId: "a".repeat(32),
        }),
      },
      env,
    );
    expect(result.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await result.text()).not.toContain("private-code");
  });
  it("sanitizes thrown transport errors before auth-js can log sensitive details", async () => {
    const logs = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-code private-password transport-secret");
      }),
    );
    const result = await createApp().request(
      "https://sales.example.test/api/recovery/verify",
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "tokenHash",
          tokenHash: "transport-private-hash",
        }),
      },
      env,
    );
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("transport-secret");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

it("does not forward callback secrets to static asset lookup or cache HTML", async () => {
  const { default: worker } = await import("../server/index");
  const assets = vi.fn(
    async (_request: Request) =>
      new Response('<!doctype html><html lang="pt-BR"></html>', {
        headers: { "Content-Type": "text/html", "Cache-Control": "public" },
      }),
  );
  const response = await worker.fetch(
    new Request(
      "https://sales.example.test/?code=private-code&token_hash=private-hash&error_description=private-description",
    ),
    { ASSETS: { fetch: assets } },
  );
  expect(assets).toHaveBeenCalledTimes(1);
  expect(assets.mock.calls[0]).toBeDefined();
  const request = assets.mock.calls[0][0];
  expect(new URL(request.url).search).toBe("");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).not.toContain("private-code");
});
