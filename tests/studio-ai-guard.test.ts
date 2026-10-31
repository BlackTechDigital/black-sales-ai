import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durableUsageGate,
  StudioAIUsageGuard,
} from "../server/studio-ai/usage-guard";
import { aiEnv, guardFixture, MemoryGuardStorage } from "./fixtures/studio-ai";

const reservation = (key = "a", subject = "b", tokens = 100) => ({
  key: key.repeat(64),
  subject: subject.repeat(64),
  tokens,
});
afterEach(() => {
  vi.useRealTimers();
});
describe("durable usage guard logic (transactional storage double)", () => {
  it("reserves atomically under contention and rejects duplicate jobs", async () => {
    const { env, storage } = guardFixture();
    const gate = durableUsageGate(env);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => gate.reserve(reservation())),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes.filter((r) => r.status === "rejected"))
      expect(outcome.reason).toMatchObject({ code: "duplicate_request" });
    expect(storage.values.size).toBe(4);
  });
  it("retains idempotency after a new guard instance and day rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:59:59Z"));
    const env = aiEnv(),
      storage = new MemoryGuardStorage();
    let fixture = guardFixture(env, storage);
    await durableUsageGate(fixture.env).reserve(reservation());
    vi.setSystemTime(new Date("2026-11-01T00:00:01Z"));
    fixture = guardFixture(env, storage);
    await expect(
      durableUsageGate(fixture.env).reserve(reservation()),
    ).rejects.toMatchObject({ code: "duplicate_request" });
    await durableUsageGate(fixture.env).reserve(reservation("c"));
  });
  it("enforces daily user count across different jobs without blocking another user", async () => {
    const { env } = guardFixture({
      ...aiEnv(),
      STUDIO_AI_USER_REQUESTS_DAY: "1",
    });
    const gate = durableUsageGate(env);
    await gate.reserve(reservation());
    await expect(gate.reserve(reservation("c"))).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    await gate.reserve(reservation("d", "e"));
  });
  it("enforces a shared global quota across users, including concurrent reservations", async () => {
    const { env } = guardFixture({
      ...aiEnv(),
      STUDIO_AI_GLOBAL_REQUESTS_DAY: "1",
    });
    const gate = durableUsageGate(env);
    const results = await Promise.allSettled([
      gate.reserve(reservation()),
      gate.reserve(reservation("c", "d")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "quota_exceeded" },
    });
  });
  it.each(["STUDIO_AI_USER_TOKENS_DAY", "STUDIO_AI_GLOBAL_TOKENS_DAY"])(
    "reserves the full budget against %s",
    async (key) => {
      const { env, storage } = guardFixture({ ...aiEnv(), [key]: "150" });
      const gate = durableUsageGate(env);
      await gate.reserve(reservation());
      const before = structuredClone(storage.values);
      await expect(gate.reserve(reservation("c"))).rejects.toMatchObject({
        code: "quota_exceeded",
      });
      expect(storage.values).toEqual(before);
    },
  );
  it("resets minute counters independently from daily limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:01Z"));
    const { env } = guardFixture({
      ...aiEnv(),
      STUDIO_AI_USER_REQUESTS_MINUTE: "1",
    });
    const gate = durableUsageGate(env);
    await gate.reserve(reservation());
    await expect(gate.reserve(reservation("c"))).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    vi.setSystemTime(new Date("2026-10-31T12:01:01Z"));
    await gate.reserve(reservation("c"));
  });
  it("fails closed with zero default quotas or missing durable binding", async () => {
    expect(() => durableUsageGate({})).toThrow();
    const { env, storage } = guardFixture({});
    await expect(
      durableUsageGate(env).reserve(reservation()),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(storage.values.size).toBe(0);
  });
  it("denies storage failures without leaking errors or falling back to memory", async () => {
    const fixture = guardFixture();
    vi.spyOn(fixture.storage, "transaction").mockRejectedValue(
      new Error("CONFIDENTIAL storage details"),
    );
    const gate = durableUsageGate(fixture.env);
    await expect(gate.reserve(reservation())).rejects.toMatchObject({
      code: "guard_unavailable",
    });
    expect(fixture.storage.values.size).toBe(0);
  });
  it("stores hashed identifiers and counters, never briefing or credentials", async () => {
    const { env, storage, transport, namespace } = guardFixture();
    await durableUsageGate(env).reserve(reservation());
    expect(namespace.idFromName).toHaveBeenCalledWith(
      "black-sales-studio-ai-usage-v1",
    );
    expect(transport).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify([...storage.values]);
    expect(stored).not.toContain(env.STUDIO_AI_API_KEY);
    expect(stored).not.toContain("public_information");
    expect(stored).not.toContain("messages");
  });
  it("validates the internal request body and does not accept caller-supplied quota policy", async () => {
    const { guard } = guardFixture();
    for (const value of [
      { ...reservation(), tokens: 0 },
      { ...reservation(), tokens: 72193 },
      { ...reservation(), subject: "bad" },
      { ...reservation(), globalRequestsDay: 1000000 },
    ]) {
      const response = await guard.fetch(
        new Request("https://internal/reserve", {
          method: "POST",
          body: JSON.stringify(value),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await guard.fetch(
          new Request("https://internal/reserve", {
            method: "POST",
            body: "x".repeat(1025),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await guard.fetch(
          new Request("https://internal/other", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await guard.fetch(new Request("https://internal/reserve"))).status,
    ).toBe(404);
  });
  it("does not allow an invalid server policy to relax the gate", async () => {
    const guard = new StudioAIUsageGuard(new MemoryGuardStorage().state(), {
      STUDIO_AI_USER_REQUESTS_DAY: "Infinity",
    });
    expect(
      (
        await guard.fetch(
          new Request("https://internal/reserve", {
            method: "POST",
            body: JSON.stringify(reservation()),
          }),
        )
      ).status,
    ).toBe(503);
  });
  it("rejects an unexpected internal binding response even with HTTP 200", async () => {
    const { env, transport } = guardFixture();
    transport.mockResolvedValue(Response.json({ ok: true }));
    await expect(
      durableUsageGate(env).reserve(reservation()),
    ).rejects.toMatchObject({ code: "guard_unavailable" });
  });
});
