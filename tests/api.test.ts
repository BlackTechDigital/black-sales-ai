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

describe("discovery API boundaries", () => {
  const records = [
    {
      company: "Empresa sintética",
      city: "Passos",
      state: "MG",
      sector: "Serviços",
    },
  ];
  const source = {
    name: "Fonte de teste",
    url: "",
    collected_at: "2026-01-01T00:00:00Z",
  };
  it.each([
    "/discovery",
    "/discovery/sources",
    "/discovery/import",
    `/discovery/${user.id}/promote`,
  ])("requires a verified active session for %s", async (path) => {
    const method =
      path.endsWith("import") || path.endsWith("promote") ? "POST" : "GET";
    expect(
      (
        await request(path, method, method === "POST" ? {} : undefined, {
          Cookie: "",
        })
      ).status,
    ).toBe(401);
    active = false;
    expect(
      (await request(path, method, method === "POST" ? {} : undefined)).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("reports absent providers honestly without outbound search", async () => {
    const res = await request("/discovery/sources");
    expect(await res.json()).toEqual({ providers: [], manual: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("validates filters and import fields before database access", async () => {
    expect((await request("/discovery?state=XX")).status).toBe(400);
    expect((await request("/discovery?offset=-1")).status).toBe(400);
    expect(
      (
        await request("/discovery/import", "POST", {
          source,
          records: [{ ...records[0], owner_id: user.id }],
          commit: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/discovery/import", "POST", {
          source: { ...source, collected_at: "2999-01-01T00:00:00Z" },
          records,
          commit: true,
        })
      ).status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("separates preview, commit and human promotion with strict payloads", async () => {
    await request("/discovery/import", "POST", {
      source,
      records,
      commit: false,
    });
    expect(rpc).toHaveBeenLastCalledWith("import_discovery_results", {
      p_source: source,
      p_records: [{ ...records[0], contact: "", website: "" }],
      p_commit: false,
    });
    await request("/discovery/import", "POST", {
      source,
      records,
      commit: true,
    });
    expect(rpc.mock.lastCall?.[1].p_commit).toBe(true);
    expect(
      (
        await request(`/discovery/${user.id}/promote`, "POST", {
          owner_id: user.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/discovery/${user.id}/promote`, "POST", {})).status,
    ).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith("promote_discovery_result", {
      p_id: user.id,
    });
  });
  it("rejects cross-origin promotion and does not reveal database/provider details", async () => {
    expect(
      (
        await request(
          `/discovery/${user.id}/promote`,
          "POST",
          {},
          { Origin: "https://attacker.example.test" },
        )
      ).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "sensitive database detail" },
    });
    const response = await request(`/discovery/${user.id}/promote`, "POST", {});
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("sensitive");
  });
});
