import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp, type Bindings } from "../server/index";
const primary = "http://localhost:5173",
  lan = "http://192.168.18.7:5173";
const env: Bindings = {
  APP_ORIGIN: primary,
  APP_LOCAL_ORIGINS: JSON.stringify([lan]),
  SUPABASE_URL: "https://provider.example.test",
  SUPABASE_PUBLISHABLE_KEY: "server-only-test-fixture",
};
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "lan@example.test",
};
const session = {
  access_token: "synthetic-lan-access",
  refresh_token: "synthetic-lan-refresh",
  user,
};
const auth = {
  signInWithPassword: vi.fn(),
  getUser: vi.fn(),
  resetPasswordForEmail: vi.fn(),
};
let active = true;
const factory = vi.fn(
  () =>
    ({
      auth,
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
const credentials = { email: user.email, password: "synthetic-test-password" };
function call(
  origin: string | undefined,
  settings = env,
  headers: Record<string, string> = {},
  path = "/login",
  body: unknown = credentials,
) {
  return app.request(
    `${lan}/api${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin === undefined ? {} : { Origin: origin }),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    settings,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  active = true;
  auth.signInWithPassword.mockResolvedValue({
    data: { user, session },
    error: null,
  });
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});
describe("LAN auth and CSRF without a real provider or database", () => {
  it.each([primary, lan])(
    "accepts explicit origin %s and issues host-only Strict/HttpOnly HTTP cookies",
    async (origin) => {
      const r = await call(origin, env, { "Sec-Fetch-Site": "same-origin" });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ user });
      for (const cookie of r.headers.getSetCookie()) {
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Path=/");
        expect(cookie).not.toMatch(/;\s*(Domain|Secure)(?:=|;|$)/i);
      }
      expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(auth.signInWithPassword).toHaveBeenCalledOnce();
    },
  );
  it.each([
    undefined,
    "",
    "null",
    "*",
    "https://evil.example",
    "http://192.168.18.8:5173",
    "http://192.168.18.7:5174",
    "http://192.168.18.7:5173/",
  ])("denies unapproved Origin %s before authentication", async (origin) => {
    expect((await call(origin)).status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
  it("does not allow LAN access unless configured", async () => {
    const settings = { ...env };
    delete settings.APP_LOCAL_ORIGINS;
    expect((await call(lan, settings)).status).toBe(403);
    expect((await call(primary, settings)).status).toBe(200);
  });
  it("retains the cross-site Fetch Metadata block even for an allowed origin", async () => {
    expect(
      (await call(lan, env, { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
  it("never derives permissions from forwarded or Host headers", async () => {
    expect(
      (
        await call("https://evil.example", env, {
          Host: "192.168.18.7:5173",
          "X-Forwarded-Host": "localhost:5173",
          "X-Forwarded-Proto": "http",
        })
      ).status,
    ).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
  it("fails closed for malformed configuration and refuses production HTTP exceptions", async () => {
    for (const settings of [
      { ...env, APP_LOCAL_ORIGINS: "*" },
      { ...env, APP_ORIGIN: "https://sales.example.test" },
    ])
      expect((await call(lan, settings)).status).toBe(503);
    expect(factory).not.toHaveBeenCalled();
  });
  it("keeps HTTPS cookies Secure and __Host- prefixed", async () => {
    const settings = { ...env, APP_ORIGIN: "https://sales.example.test" };
    delete settings.APP_LOCAL_ORIGINS;
    const r = await call(settings.APP_ORIGIN, settings);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("__Host-bs-access");
    expect(r.headers.get("set-cookie")).toContain("; Secure");
  });
  it("keeps membership authorization mandatory", async () => {
    active = false;
    const r = await call(lan);
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  it("still refuses unauthenticated data reads on the LAN", async () => {
    const r = await app.request(lan + "/api/leads", {}, env);
    expect(r.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([primary, lan])(
    "uses the validated request origin for recovery on %s",
    async (origin) => {
      const r = await call(origin, env, {}, "/recovery/request", {
        email: user.email,
      });
      expect(r.status).toBe(200);
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(user.email, {
        redirectTo: origin + "/reset-password",
      });
    },
  );
});
