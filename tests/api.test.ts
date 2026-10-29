import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp, type Bindings } from "../server/index";
const env: Bindings = {
  APP_ORIGIN: "https://sales.example.test",
  SUPABASE_URL: "https://provider.example.test",
  SUPABASE_PUBLISHABLE_KEY: "server-only-test-key",
};
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "test@example.test",
};
const session = {
  access_token: "private-test-access",
  refresh_token: "private-test-refresh",
  user,
};
const auth = {
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  refreshSession: vi.fn(),
};
let active = true;
const rpc = vi.fn();
const inserted = vi.fn();
const from = vi.fn((table: string) => {
  if (table === "app_members")
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { active }, error: null }),
        }),
      }),
    };
  return {
    select: () => ({
      order: () => ({
        order: () => ({ range: async () => ({ data: [], error: null }) }),
      }),
    }),
    insert: (values: unknown) => {
      inserted(values);
      return {
        select: () => ({
          single: async () => ({ data: { id: "test-id" }, error: null }),
        }),
      };
    },
  };
});
const factory = vi.fn(() => ({ auth, from, rpc }) as unknown as SupabaseClient);
const app = createApp(factory);
const lead = {
  company: "Empresa de teste",
  city: "Cidade de teste",
  sector: "Serviços",
  contact: "",
  notes: "",
  site: "unknown",
  status: "Novo",
};
function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return app.request(
    `https://sales.example.test/api${path}`,
    {
      method,
      headers: {
        Origin: env.APP_ORIGIN!,
        "Content-Type": "application/json",
        Cookie:
          "__Host-bs-access=private-test-access; __Host-bs-refresh=private-test-refresh",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  active = true;
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  auth.signInWithPassword.mockResolvedValue({
    data: { session, user },
    error: null,
  });
  auth.refreshSession.mockResolvedValue({ data: { session }, error: null });
  rpc.mockResolvedValue({
    data: {
      total: 1,
      created: 1,
      duplicates: 0,
      conflicts: 0,
      conflict_rows: [],
      committed: false,
    },
    error: null,
  });
});
describe("API authentication and request security", () => {
  it("fails closed with an unconfigured provider, without fake data", async () => {
    const response = await app.request("/api/session", {}, {});
    expect(await response.json()).toEqual({ configured: false, user: null });
    expect(factory).not.toHaveBeenCalled();
    expect((await app.request("/api/leads", {}, {})).status).toBe(503);
  });
  it("denies unauthenticated requests before database access", async () => {
    const response = await request("/leads", "GET", undefined, { Cookie: "" });
    expect(response.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(["https://attacker.example.test", "null", ""])(
    "rejects mutation origin %s",
    async (origin) => {
      expect(
        (await request("/leads", "POST", lead, { Origin: origin })).status,
      ).toBe(403);
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it("requires JSON and rejects malformed bodies", async () => {
    expect(
      (await request("/login", "POST", {}, { "Content-Type": "text/plain" }))
        .status,
    ).toBe(415);
    const response = await app.request(
      "https://sales.example.test/api/login",
      {
        method: "POST",
        headers: {
          Origin: env.APP_ORIGIN!,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      env,
    );
    expect(response.status).toBe(400);
  });
  it("bounds the actual body even with no Content-Length", async () => {
    const response = await request("/login", "POST", {
      payload: "x".repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it("keeps tokens in secure HttpOnly cookies, out of login JSON", async () => {
    const response = await request("/login", "POST", {
      email: user.email,
      password: "test-password",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user });
    const cookies = response.headers.get("set-cookie")!;
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=Strict");
    expect(cookies).toContain("__Host-bs-access");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("prevents users from bypassing administrator membership", async () => {
    active = false;
    const response = await request("/login", "POST", {
      email: user.email,
      password: "test-password",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await request("/leads")).status).toBe(403);
  });
  it("refreshes an expired token only on the server", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401 },
    });
    const response = await request("/session");
    expect(response.status).toBe(200);
    expect(auth.refreshSession).toHaveBeenCalledWith({
      refresh_token: "private-test-refresh",
    });
    expect(JSON.stringify(await response.json())).not.toContain("private-test");
  });
  it("does not discard session cookies during a provider outage", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 503, message: "secret-upstream-error" },
    });
    const response = await request("/session");
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain("secret-upstream");
  });
});
describe("API data boundaries", () => {
  it("rejects ownership injection and invalid statuses", async () => {
    expect(
      (await request("/leads", "POST", { ...lead, owner_id: "another-user" }))
        .status,
    ).toBe(400);
    expect(
      (await request("/leads", "POST", { ...lead, status: "invented" })).status,
    ).toBe(400);
    expect(inserted).not.toHaveBeenCalled();
  });
  it("saves validated fields and delegates ownership to the verified database session", async () => {
    const response = await request("/leads", "POST", lead);
    expect(response.status).toBe(201);
    expect(inserted).toHaveBeenCalledWith(lead);
  });
  it("requires a revision and forwards concurrency control to PostgreSQL", async () => {
    const id = user.id;
    expect(
      (await request(`/leads/${id}`, "PATCH", { values: lead })).status,
    ).toBe(400);
    expect(
      (await request(`/leads/${id}`, "PATCH", { values: lead, version: 2 }))
        .status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith("update_lead", {
      p_id: id,
      p_version: 2,
      p_values: lead,
      p_archived: null,
    });
  });
  it("reports stale updates rather than claiming success", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "internal details" },
    });
    const response = await request(`/leads/${user.id}`, "PATCH", {
      values: lead,
      version: 1,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("internal details");
  });
  it("validates every import record before calling the atomic function", async () => {
    const response = await request("/leads/import", "POST", {
      records: [
        { ...lead, id: "test" },
        { ...lead, id: "bad", company: 22 },
      ],
      commit: true,
    });
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("separates import preview and explicit commit", async () => {
    const records = [{ ...lead, id: "test" }];
    expect(
      (await request("/leads/import", "POST", { records, commit: false }))
        .status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith("import_leads_v1", {
      p_records: records,
      p_commit: false,
    });
    await request("/leads/import", "POST", { records, commit: true });
    expect(rpc).toHaveBeenLastCalledWith("import_leads_v1", {
      p_records: records,
      p_commit: true,
    });
  });
  it("does not expose delete or message sending endpoints", async () => {
    expect((await request(`/leads/${user.id}`, "DELETE", {})).status).toBe(404);
    expect((await request("/messages/send", "POST", {})).status).toBe(404);
  });
});

it("preserves cookies when refresh cannot reach the provider", async () => {
  auth.getUser.mockResolvedValue({
    data: { user: null },
    error: { status: 401 },
  });
  auth.refreshSession.mockResolvedValue({
    data: { session: null },
    error: { status: 0 },
  });
  const response = await request("/session");
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
});
