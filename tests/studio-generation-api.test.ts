import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { createApp } from "../server/index";
import type { Bindings } from "../server/types";
import { MockSiteDocumentProvider } from "../server/studio-ai/mock-provider";
import type {
  SiteProviderRequest,
  SiteProviderOutput,
} from "../server/studio-ai/provider";
import { guardFixture } from "./fixtures/studio-ai";
import { GenerationDatabase } from "./fixtures/studio-generation-db";
import {
  alice,
  bob,
  briefFixture,
  documentFixture,
} from "./fixtures/site-persistence";
import {
  generationJobResponseSchema,
  generationHistorySchema,
  generationEligibilitySchema,
} from "../shared/studio-generation";

const db = new GenerationDatabase();
let p: { id: string; brief: string; hash: string },
  tasks: Promise<void>[],
  env: Bindings;
let respond: ReturnType<
  typeof vi.fn<
    (r: SiteProviderRequest, s: AbortSignal) => Promise<SiteProviderOutput>
  >
>;
let app: ReturnType<typeof createApp>;
const path = (suffix: string) =>
  `/api/studio/projects/${p.id}/site-generation${suffix}`;
function req(
  suffix: string,
  method = "GET",
  body?: unknown,
  token = "token-alice",
  extra: Record<string, string> = {},
) {
  return app.request(
    `https://sales.example.com${path(suffix)}`,
    {
      method,
      headers: {
        Origin: "https://sales.example.com",
        "Content-Type": "application/json",
        Cookie: `__Host-bs-access=${token}`,
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}
const input = (request_id = crypto.randomUUID()) => ({
  request_id,
  brief_version_id: p.brief,
  brief_hash: p.hash,
});
const eligibility = () =>
  req(
    `/eligibility?${new URLSearchParams({ brief_version_id: p.brief, brief_hash: p.hash })}`,
  );
const drain = async () => {
  await Promise.all(tasks);
};
beforeAll(async () => {
  await db.initialize();
});
beforeEach(async () => {
  await db.reset();
  p = await db.project();
  tasks = [];
  env = {
    ...guardFixture().env,
    APP_ORIGIN: "https://sales.example.com",
    SUPABASE_URL: "https://provider.example.com",
    SUPABASE_PUBLISHABLE_KEY: "synthetic-server-key",
  };
  respond = vi.fn(async () => ({ text: JSON.stringify(documentFixture()) }));
  app = createApp(db.factory, {
    adapter: { provider: new MockSiteDocumentProvider(respond) },
    schedule: (task) => {
      tasks.push(task);
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden in generation integration tests");
    }),
  );
});
afterEach(async () => {
  await drain();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.db.close();
});
describe("authenticated generation API with real temporary SQL and simulated AI", () => {
  it("returns sanitized eligibility without public/private context, secrets or internal prompts", async () => {
    const r = await eligibility();
    expect(r.status).toBe(200);
    const body = generationEligibilitySchema.parse(await r.json());
    expect(body).toMatchObject({
      eligible: true,
      availability: { available: true, code: "ready" },
    });
    const serialized = JSON.stringify(body);
    for (const value of [
      "public_information",
      "Contato privado",
      "Nota privada",
      env.STUDIO_AI_API_KEY,
      "BLACK_SALES_STUDIO_SYSTEM_V1",
    ])
      expect(serialized).not.toContain(value);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(respond).not.toHaveBeenCalled();
  });
  it("accepts a job asynchronously and persists a validated immutable version", async () => {
    const r = await req("/jobs", "POST", input());
    expect(r.status).toBe(202);
    const started = generationJobResponseSchema.parse(await r.json());
    expect(started.job.status).toBe("processing");
    await drain();
    expect(respond).toHaveBeenCalledTimes(1);
    const status = await req(`/jobs/${started.job.id}`);
    expect(status.status).toBe(200);
    const done = generationJobResponseSchema.parse(await status.json());
    expect(done.job.status).toBe("completed");
    expect(done.version).toMatchObject({
      number: 1,
      job_id: done.job.id,
      brief_version_id: p.brief,
      brief_hash: p.hash,
    });
    const history = generationHistorySchema.parse(
      await (await req("/history")).json(),
    );
    expect(history.jobs).toHaveLength(1);
    expect(history.versions).toHaveLength(1);
    const text = JSON.stringify(history);
    for (const key of [
      'document"',
      "attempt_id",
      "public_information",
      "owner_id",
      "source",
      "BLACK_SALES_STUDIO_SYSTEM_V1",
      env.STUDIO_AI_API_KEY,
    ])
      expect(text).not.toContain(key);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent identical requests and preserves historical results", async () => {
    const data = input();
    const responses = await Promise.all([
      req("/jobs", "POST", data),
      req("/jobs", "POST", data),
    ]);
    expect(responses.every((r) => [200, 202].includes(r.status))).toBe(true);
    const bodies = await Promise.all(
      responses.map(async (r) =>
        generationJobResponseSchema.parse(await r.json()),
      ),
    );
    expect(bodies[0].job.id).toBe(bodies[1].job.id);
    await drain();
    expect(respond).toHaveBeenCalledTimes(1);
    expect((await req("/jobs", "POST", data)).status).toBe(200);
    expect(respond).toHaveBeenCalledTimes(1);
    expect((await req("/jobs", "POST", input())).status).toBe(202);
    await drain();
    const history = generationHistorySchema.parse(
      await (await req("/history")).json(),
    );
    expect(history.versions.map((v) => v.number).sort()).toEqual([1, 2]);
    const versions = await db.db.query<{
      number: number;
      parent_id: string | null;
    }>(
      "select number,parent_id from public.studio_site_versions order by number",
    );
    expect(versions.rows[1].parent_id).toBe(
      history.versions.find((v) => v.number === 1)?.id,
    );
  });
  it("rejects altered input for a reused key even after the briefing changes", async () => {
    const data = input();
    await req("/jobs", "POST", data);
    await drain();
    expect(
      (await req("/jobs", "POST", { ...data, brief_hash: "f".repeat(64) }))
        .status,
    ).toBe(409);
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("keeps an existing result readable while AI configuration is disabled", async () => {
    const data = input();
    const r = await req("/jobs", "POST", data);
    await drain();
    const body = (await r.json()) as { job: { id: string } };
    env.STUDIO_AI_PROVIDER = "disabled";
    expect((await req(`/jobs/${body.job.id}`)).status).toBe(200);
    expect((await req("/jobs", "POST", data)).status).toBe(200);
    expect((await req("/history")).status).toBe(200);
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("blocks a competing active job and permits explicit cancellation without overwriting results", async () => {
    let release: (value: SiteProviderOutput) => void = () => {};
    respond.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input())).json(),
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect((await req("/jobs", "POST", input())).status).toBe(409);
    expect(
      (await req(`/jobs/${first.job.id}/cancel`, "POST", { confirm: false }))
        .status,
    ).toBe(400);
    const cancelled = await req(`/jobs/${first.job.id}/cancel`, "POST", {
      confirm: true,
    });
    expect(cancelled.status).toBe(200);
    release({ text: JSON.stringify(documentFixture()) });
    await drain();
    const state = generationJobResponseSchema.parse(
      await (await req(`/jobs/${first.job.id}`)).json(),
    );
    expect(state.job).toMatchObject({
      status: "failed",
      error_code: "cancelled",
    });
    expect(state.version).toBeNull();
  });
  it.each(["disabled", "missing-key", "missing-guard", "zero-quota"])(
    "reports %s without creating a job or calling AI",
    async (caseName) => {
      if (caseName === "disabled") env.STUDIO_AI_PROVIDER = "disabled";
      if (caseName === "missing-key") delete env.STUDIO_AI_API_KEY;
      if (caseName === "missing-guard") delete env.STUDIO_AI_USAGE_GUARD;
      if (caseName === "zero-quota") env.STUDIO_AI_USER_REQUESTS_DAY = "0";
      const e = generationEligibilitySchema.parse(
        await (await eligibility()).json(),
      );
      expect(e.availability.available).toBe(false);
      const r = await req("/jobs", "POST", input());
      expect(r.status).toBe(503);
      expect(await r.json()).toHaveProperty("code");
      expect(
        (await db.db.query("select * from public.studio_generation_jobs")).rows,
      ).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();
    },
  );
  it("reports missing migration and missing RPC with safe actionable messages", async () => {
    db.missingTable = "studio_generation_jobs";
    expect(
      generationEligibilitySchema.parse(await (await eligibility()).json())
        .availability.code,
    ).toBe("migration_missing");
    const r = await req("/jobs", "POST", input());
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "migration_missing" });
    expect((await req("/history")).status).toBe(503);
    db.missingTable = null;
    db.missingRPC = "studio_create_generation_job";
    expect(await (await req("/jobs", "POST", input())).json()).toMatchObject({
      code: "migration_missing",
    });
    expect(respond).not.toHaveBeenCalled();
  });
  it("requires Worker execution context before admitting work", async () => {
    app = createApp(db.factory, {
      adapter: { provider: new MockSiteDocumentProvider(respond) },
    });
    expect(
      generationEligibilitySchema.parse(await (await eligibility()).json())
        .availability.code,
    ).toBe("execution_unavailable");
    expect(await (await req("/jobs", "POST", input())).json()).toMatchObject({
      code: "execution_unavailable",
    });
    expect(respond).not.toHaveBeenCalled();
  });
  it("denies anonymous, cross-origin, inactive and cross-user access", async () => {
    expect(
      (await req("/history", "GET", undefined, "", { Cookie: "" })).status,
    ).toBe(401);
    expect(
      (
        await req("/jobs", "POST", input(), "token-alice", {
          Origin: "https://attacker.example.com",
        })
      ).status,
    ).toBe(403);
    const created = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input())).json(),
    );
    await drain();
    expect((await req("/history", "GET", undefined, "token-bob")).status).toBe(
      404,
    );
    expect(
      (await req(`/jobs/${created.job.id}`, "GET", undefined, "token-bob"))
        .status,
    ).toBe(404);
    expect((await req("/jobs", "POST", input(), "token-bob")).status).toBe(404);
    expect(
      (
        await req(
          `/jobs/${created.job.id}/cancel`,
          "POST",
          { confirm: true },
          "token-bob",
        )
      ).status,
    ).toBe(404);
    await db.db.query(
      "update public.app_members set active=false where user_id=$1",
      [alice],
    );
    expect((await req("/history")).status).toBe(403);
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("refuses unapproved/private/stale briefings and injected configuration", async () => {
    p = await db.project(alice, false);
    expect((await req("/jobs", "POST", input())).status).toBe(400);
    p = await db.project();
    expect(
      (
        await req("/jobs", "POST", {
          ...input(),
          approved: true,
          endpoint: "https://evil.example.com",
        })
      ).status,
    ).toBe(400);
    expect(
      (await req("/jobs", "POST", { ...input(), brief_hash: "f".repeat(64) }))
        .status,
    ).toBe(409);
    const fields = briefFixture();
    fields.services.public_use = false;
    const saved = await db.client().rpc("studio_save_brief", {
      p_id: p.id,
      p_expected_head: p.brief,
      p_fields: fields,
      p_request_id: crypto.randomUUID(),
    });
    p.brief = (saved.data as { version_id: string }).version_id;
    const detail = await db
      .client()
      .rpc("studio_project_detail", { p_id: p.id, p_version_id: null });
    p.hash = (
      detail.data as { version: { content_hash: string } }
    ).version.content_hash;
    await db.client().rpc("studio_approve_brief", {
      p_id: p.id,
      p_version_id: p.brief,
      p_content_hash: p.hash,
    });
    expect((await req("/jobs", "POST", input())).status).toBe(400);
    expect(respond).not.toHaveBeenCalled();
  });
  it("records invalid generated output as failure without leaking the response", async () => {
    respond.mockResolvedValue({ text: `RAW_SECRET ${env.STUDIO_AI_API_KEY}` });
    const started = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input())).json(),
    );
    await drain();
    const result = await req(`/jobs/${started.job.id}`);
    const body = generationJobResponseSchema.parse(await result.json());
    expect(body.job).toMatchObject({
      status: "failed",
      error_code: "invalid_response",
    });
    expect(body.version).toBeNull();
    expect(JSON.stringify(body)).not.toContain("RAW_SECRET");
  });
  it("retries only idempotent persistence after a lost completion reply, never AI", async () => {
    db.completionCommitsBeforeLostReply = 1;
    const started = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input())).json(),
    );
    await drain();
    expect(
      generationJobResponseSchema.parse(
        await (await req(`/jobs/${started.job.id}`)).json(),
      ).job.status,
    ).toBe("completed");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(
      db.calls.filter((c) => c.fn === "studio_complete_generation_job"),
    ).toHaveLength(2);
    expect(
      (await db.db.query("select * from public.studio_site_versions")).rows,
    ).toHaveLength(1);
  });
  it("leaves ambiguous persistence for reconciliation rather than inventing success or rerunning AI", async () => {
    db.completionFailures = 2;
    const data = input();
    const started = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", data)).json(),
    );
    await drain();
    expect(
      generationJobResponseSchema.parse(
        await (await req(`/jobs/${started.job.id}`)).json(),
      ).job.status,
    ).toBe("processing");
    expect((await req("/jobs", "POST", data)).status).toBe(202);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(
      (await db.db.query("select * from public.studio_site_versions")).rows,
    ).toHaveLength(0);
  });
  it("keeps late output tied to its exact approved briefing when the briefing changes during AI", async () => {
    let release: (value: SiteProviderOutput) => void = () => {};
    respond.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const started = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input())).json(),
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    await db.client().rpc("studio_save_brief", {
      p_id: p.id,
      p_expected_head: p.brief,
      p_fields: briefFixture(),
      p_request_id: crypto.randomUUID(),
    });
    release({ text: JSON.stringify(documentFixture()) });
    await drain();
    const result = generationJobResponseSchema.parse(
      await (await req(`/jobs/${started.job.id}`)).json(),
    );
    expect(result.version?.brief_version_id).toBe(p.brief);
    expect(result.job.status).toBe("completed");
  });
  it("isolates two valid owners in the shared quota coordinator and database", async () => {
    const original = p;
    p = await db.project(bob);
    const theirs = generationJobResponseSchema.parse(
      await (await req("/jobs", "POST", input(), "token-bob")).json(),
    );
    await drain();
    p = original;
    expect((await req(`/jobs/${theirs.job.id}`)).status).toBe(404);
    const history = generationHistorySchema.parse(
      await (await req("/history")).json(),
    );
    expect(history.jobs).toHaveLength(0);
  });
  it("uses the real Hono Worker execution context to retain background work", async () => {
    app = createApp(db.factory, {
      adapter: { provider: new MockSiteDocumentProvider(respond) },
    });
    const ctx = {
      waitUntil: (task: Promise<void>) => tasks.push(task),
      passThroughOnException() {},
      props: {},
    };
    const response = await app.fetch(
      new Request(`https://sales.example.com${path("/jobs")}`, {
        method: "POST",
        headers: {
          Origin: "https://sales.example.com",
          "Content-Type": "application/json",
          Cookie: "__Host-bs-access=token-alice",
        },
        body: JSON.stringify(input()),
      }),
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(response.status).toBe(202);
    expect(tasks).toHaveLength(1);
    await drain();
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("aborts safely if dispatch fails after claim", async () => {
    app = createApp(db.factory, {
      adapter: { provider: new MockSiteDocumentProvider(respond) },
      schedule: () => {
        throw new Error("Synthetic unavailable dispatcher");
      },
    });
    const r = await req("/jobs", "POST", input());
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "execution_unavailable" });
    expect(respond).not.toHaveBeenCalled();
    const history = generationHistorySchema.parse(
      await (await req("/history")).json(),
    );
    expect(history.jobs[0].status).toBe("failed");
  });
  it("paginates bounded history without mixing jobs or duplicating versions", async () => {
    const client = db.client();
    for (let i = 0; i < 23; i++) {
      const r = await client.rpc("studio_create_generation_job", {
        p_project_id: p.id,
        p_brief_version_id: p.brief,
        p_brief_hash: p.hash,
        p_request_id: crypto.randomUUID(),
      });
      await client.rpc("studio_fail_generation_job", {
        p_job_id: (r.data as { id: string }).id,
        p_attempt_id: null,
        p_error_code: "cancelled",
      });
    }
    const first = generationHistorySchema.parse(
        await (await req("/history")).json(),
      ),
      next = generationHistorySchema.parse(
        await (await req("/history?offset=20")).json(),
      );
    expect(first.jobs).toHaveLength(20);
    expect(first.has_more).toBe(true);
    expect(next.jobs).toHaveLength(3);
    expect(next.has_more).toBe(false);
    expect(new Set([...first.jobs, ...next.jobs].map((j) => j.id)).size).toBe(
      23,
    );
    expect((await req("/history?offset=-1")).status).toBe(400);
  });
  it("flags a stalled job without mutating it and permits explicit termination", async () => {
    const admitted = await db.client().rpc("studio_create_generation_job", {
      p_project_id: p.id,
      p_brief_version_id: p.brief,
      p_brief_hash: p.hash,
      p_request_id: crypto.randomUUID(),
    });
    const id = (admitted.data as { id: string }).id;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180000);
    const state = generationJobResponseSchema.parse(
      await (await req(`/jobs/${id}`)).json(),
    );
    expect(state.job).toMatchObject({ status: "pending", stalled: true });
    clock.mockRestore();
    expect(
      (await req(`/jobs/${id}/cancel`, "POST", { confirm: true })).status,
    ).toBe(200);
    expect(respond).not.toHaveBeenCalled();
  });
  it("persists timeouts without retrying the model or releasing idempotency", async () => {
    respond.mockImplementation(() => new Promise(() => {}));
    const data = input(),
      started = generationJobResponseSchema.parse(
        await (await req("/jobs", "POST", data)).json(),
      );
    await drain();
    const state = generationJobResponseSchema.parse(
      await (await req(`/jobs/${started.job.id}`)).json(),
    );
    expect(state.job).toMatchObject({
      status: "failed",
      error_code: "timeout",
    });
    expect((await req("/jobs", "POST", data)).status).toBe(200);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
