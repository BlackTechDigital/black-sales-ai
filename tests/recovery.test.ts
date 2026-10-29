import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp, type Bindings } from "../server/index";
const env: Bindings = {
  APP_ORIGIN: "https://sales.example.test",
  SUPABASE_URL: "https://auth.example.test",
  SUPABASE_PUBLISHABLE_KEY: "server-only-fixture",
};
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "recovery@example.test",
};
function jwt({
  method = "recovery",
  age = 0,
  expires = 3600,
  id = user.id,
  sessionId = "test-session",
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, exp: now + expires, session_id: sessionId, amr: [{ method, timestamp: now - age }] })}.test-signature`;
}
const auth = {
  getUser: vi.fn(),
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  setSession: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  refreshSession: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
};
const factory = vi.fn(() => ({ auth }) as unknown as SupabaseClient);
const app = createApp(factory);
let token: string;
const session = () => ({
  access_token: token,
  refresh_token: "private-refresh-fixture",
  user,
});
function request(
  path: string,
  body?: unknown,
  cookie = "",
  method = body === undefined ? "GET" : "POST",
  origin = env.APP_ORIGIN!,
) {
  return app.request(
    `https://sales.example.test/api/recovery/${path}`,
    {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
function cookies(response: Response): string {
  const jar = new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at),
      value = pair.slice(at + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
const proof = { kind: "tokenHash", tokenHash: "recovery-token-hash-fixture" };
const input = {
  password: "A new password fixture 123!",
  confirmation: "A new password fixture 123!",
};
beforeEach(() => {
  vi.clearAllMocks();
  token = jwt();
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  for (const action of [
    "verifyOtp",
    "exchangeCodeForSession",
    "setSession",
    "refreshSession",
  ] as const)
    auth[action].mockImplementation(async () => ({
      data: { session: session(), user },
      error: null,
    }));
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  auth.updateUser.mockResolvedValue({ data: { user }, error: null });
  auth.signOut.mockResolvedValue({ error: null });
});
afterEach(() => vi.restoreAllMocks());
describe("recovery authorization", () => {
  it("verifies token hashes strictly for recovery and keeps short-lived grants separate from login", async () => {
    const result = await request("verify", proof);
    expect(result.status).toBe(200);
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: proof.tokenHash,
      type: "recovery",
    });
    const output = await result.text();
    expect(output).not.toContain(token);
    expect(output).not.toContain("private-refresh");
    const header = result.headers.get("set-cookie")!;
    expect(header).toContain("__Host-bs-recovery-access");
    expect(header).not.toContain("__Host-bs-access=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    const ages = [...header.matchAll(/Max-Age=(\d+)/g)].map((match) =>
      Number(match[1]),
    );
    expect(ages.some((age) => age > 0 && age <= 900)).toBe(true);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("exchanges PKCE codes with the explicit flow identifier", async () => {
    const flowId = "a".repeat(32);
    expect(
      (await request("verify", { kind: "code", code: "code-fixture", flowId }))
        .status,
    ).toBe(200);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("code-fixture", {
      flowId,
    });
  });
  it("rejects password login tokens even if a callback claims to be recovery", async () => {
    const ordinary = jwt({ method: "password" });
    const result = await request("verify", {
      kind: "session",
      accessToken: ordinary,
      refreshToken: "refresh",
    });
    expect(result.status).toBe(400);
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("does not accept unsigned or forged payloads when Auth rejects the token", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 401, message: token },
    });
    const result = await request("verify", {
      kind: "session",
      accessToken: token,
      refreshToken: "refresh",
    });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain(token);
    expect(auth.setSession).not.toHaveBeenCalled();
  });
  it.each([
    { age: 901 },
    { expires: -1 },
    { id: "other-user" },
    { sessionId: "" },
  ])("rejects expired or mismatched recovery claims %j", async (claims) => {
    token = jwt(claims);
    expect((await request("verify", proof)).status).toBe(400);
  });
  it("rejects replayed, invalid, or expired provider tokens with a generic message", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: {
        status: 403,
        code: "otp_expired",
        message: `secret ${proof.tokenHash}`,
      },
    });
    const result = await request("verify", proof);
    expect(result.status).toBe(400);
    const output = (await result.json()) as { code: string; message: string };
    expect(output.code).toBe("recovery_invalid");
    expect(output.message).toContain("expirou");
    expect(JSON.stringify(output)).not.toContain(proof.tokenHash);
  });
  it("never uses the existing login cookie as recovery authorization", async () => {
    expect(
      (
        await request(
          "password",
          input,
          "__Host-bs-access=normal-login; __Host-bs-refresh=normal-refresh",
        )
      ).status,
    ).toBe(400);
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("refuses cross-origin verification and password changes", async () => {
    expect(
      (
        await request(
          "verify",
          proof,
          "",
          "POST",
          "https://attacker.example.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "password",
          input,
          "",
          "POST",
          "https://attacker.example.test",
        )
      ).status,
    ).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
});
describe("password changes", () => {
  it("validates confirmation before contacting Auth", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.updateUser.mockClear();
    auth.refreshSession.mockClear();
    expect(
      (
        await request(
          "password",
          { ...input, confirmation: "different" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "password",
          { password: "short", confirmation: "short" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("updates only the recovered account and revokes refresh sessions after success", async () => {
    const cookie = cookies(await request("verify", proof));
    const result = await request("password", input, cookie);
    expect(result.status).toBe(200);
    expect(auth.refreshSession).toHaveBeenCalledWith({
      refresh_token: "private-refresh-fixture",
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: input.password });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(await result.json()).toMatchObject({ updated: true });
    expect(result.headers.get("set-cookie")).toContain(
      "__Host-bs-recovery-access=;",
    );
    expect(result.headers.get("set-cookie")).toContain("__Host-bs-access=;");
  });
  it("rejects a refresh token belonging to a different recovery session", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.refreshSession.mockResolvedValue({
      data: {
        session: {
          ...session(),
          access_token: jwt({ sessionId: "other-session" }),
        },
      },
      error: null,
    });
    expect((await request("password", input, cookie)).status).toBe(400);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("rejects completion after refresh revocation or link expiry", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, code: "refresh_token_not_found" },
    });
    expect((await request("password", input, cookie)).status).toBe(400);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("reports policy failures without claiming success or clearing the recovery grant", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { status: 422, code: "weak_password", message: input.password },
    });
    const result = await request("password", input, cookie);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "password_policy" });
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(result.headers.get("set-cookie")).not.toContain(
      "__Host-bs-recovery-access=;",
    );
  });
  it("keeps a successful password change distinct from failed remote logout", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.signOut.mockResolvedValue({ error: { status: 503 } });
    const result = await request("password", input, cookie);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      updated: true,
      message: expect.stringContaining("Não foi possível confirmar"),
    });
  });
  it("does not log credentials, tokens, password fields or provider errors", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const cookie = cookies(await request("verify", proof));
    auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { status: 503, message: `${input.password} ${token}` },
    });
    const response = await request("password", input, cookie);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain(input.password);
    expect(body).not.toContain(token);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
describe("request and resume", () => {
  it("uses a server-defined redirect and does not enumerate registered addresses", async () => {
    const one = await request("request", { email: user.email });
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { status: 400, code: "user_not_found" },
    });
    const two = await request("request", { email: "missing@example.test" });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(await one.json()).toEqual(await two.json());
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(user.email, {
      redirectTo: "https://sales.example.test/reset-password",
    });
    expect(
      (
        await request("request", {
          email: user.email,
          redirectTo: "https://attacker.example.test",
        })
      ).status,
    ).toBe(400);
  });
  it("resumes with the protected recovery cookies without redeeming the token twice", async () => {
    const cookie = cookies(await request("verify", proof));
    auth.verifyOtp.mockClear();
    const response = await request("session", undefined, cookie);
    expect(response.status).toBe(200);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("reports Auth outages and rate limits without leaking provider details", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { status: 503, message: proof.tokenHash },
    });
    const result = await request("verify", proof);
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain(proof.tokenHash);
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { status: 429 },
    });
    expect((await request("request", { email: user.email })).status).toBe(429);
  });
});
