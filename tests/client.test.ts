import { afterEach, describe, expect, it, vi } from "vitest";
import { getLeads, ApiError, api } from "../src/api";
afterEach(() => vi.unstubAllGlobals());
describe("frontend transport", () => {
  it("loads every page beyond 1,000 records rather than truncating", async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }));
    const fetcher = vi.fn(async (url: string) => {
      const offset = Number(
        new URL(url, "http://localhost").searchParams.get("offset"),
      );
      return Response.json({ leads: records.slice(offset, offset + 200) });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await getLeads()).toHaveLength(1001);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("does not return partial data after a failed page", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? Response.json({ leads: Array(200).fill({ id: "test" }) })
          : Response.json({ message: "Banco indisponível" }, { status: 503 }),
      ),
    );
    await expect(getLeads()).rejects.toBeInstanceOf(ApiError);
  });
  it("passes no provider credentials and refuses false success on failures", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ message: "Edição em conflito" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      api("/leads", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 409, message: "Edição em conflito" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/leads",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});
