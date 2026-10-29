import { describe, expect, it, vi } from "vitest";
import { readRecoveryEntry, recoveryPasswordSchema } from "../shared/recovery";
function read(path: string) {
  const replace = vi.fn();
  const entry = readRecoveryEntry(
    { href: `http://localhost:5173${path}` },
    replace,
  );
  return { entry, replace };
}
describe("recovery URL boundaries", () => {
  it("leaves normal login and dashboard locations unchanged", () => {
    expect(read("/").entry).toBeNull();
    expect(read("/?search=test").replace).not.toHaveBeenCalled();
  });
  it("extracts fragment tokens and removes all sensitive URL parameters", () => {
    const { entry, replace } = read(
      "/#access_token=private-access&refresh_token=private-refresh&type=recovery",
    );
    expect(entry?.proof).toEqual({
      kind: "session",
      accessToken: "private-access",
      refreshToken: "private-refresh",
    });
    expect(replace).toHaveBeenCalledWith("/reset-password");
  });
  it("supports hash links and PKCE including the SDK flow ID", () => {
    expect(
      read("/reset-password#token_hash=private-hash-fixture&type=recovery")
        .entry?.proof,
    ).toEqual({ kind: "tokenHash", tokenHash: "private-hash-fixture" });
    expect(
      read(`/auth/callback?code=private-code&sb_flow_id=${"a".repeat(32)}`)
        .entry?.proof,
    ).toEqual({ kind: "code", code: "private-code", flowId: "a".repeat(32) });
  });
  it("supports server-cleaned query callbacks and never follows redirect_to", () => {
    const { entry, replace } = read(
      "/auth/confirm?token_hash=private-hash-fixture&type=recovery&redirect_to=https://attacker.example.test",
    );
    expect(entry?.proof?.kind).toBe("tokenHash");
    expect(replace).toHaveBeenCalledWith("/reset-password");
  });
  it("resumes a clean recovery page without tokens", () => {
    expect(read("/reset-password").entry).toEqual({});
  });
  it.each([
    "/reset-password#access_token=one&type=recovery",
    "/reset-password#access_token=one&refresh_token=two&type=signup",
    "/reset-password?code=one&code=two",
    "/reset-password?code=one#code=two",
    "/reset-password?code=one#token_hash=private-hash-fixture&type=recovery",
    "/reset-password?error=access_denied&error_description=attacker-controlled-text",
    "/reset-password?code=one&sb_flow_id=invalid",
    "/reset-password#token_hash=private-hash-fixture&type=invite",
  ])(
    "fails closed on ambiguous, expired, or unrelated callbacks %s",
    (path) => {
      const { entry, replace } = read(path);
      expect(entry).toEqual({ invalid: true });
      expect(replace).toHaveBeenCalledWith("/reset-password");
    },
  );
  it("validates password confirmation and minimum length on shared boundaries", () => {
    expect(
      recoveryPasswordSchema.safeParse({
        password: "short",
        confirmation: "short",
      }).success,
    ).toBe(false);
    expect(
      recoveryPasswordSchema.safeParse({
        password: "long password fixture",
        confirmation: "other password",
      }).success,
    ).toBe(false);
    expect(
      recoveryPasswordSchema.safeParse({
        password: "long password fixture",
        confirmation: "long password fixture",
      }).success,
    ).toBe(true);
  });
});
