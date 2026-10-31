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
import { GenerationDatabase } from "./fixtures/studio-generation-db";
import { previewFixture } from "./fixtures/studio-preview";
import { alice, bob, briefFixture } from "./fixtures/site-persistence";
import { siteExportStatusSchema } from "../shared/studio-export";
import { bytesSha256 } from "../server/studio-site-artifact";
const db = new GenerationDatabase(),
  app = createApp(db.factory);
let env: Bindings,
  p: { id: string; brief: string; hash: string },
  v: { id: string; document_hash: string; number: number };
const base = (id = v.id) =>
  `/api/studio/projects/${p.id}/site-preview/versions/${id}/export`;
const req = (
  suffix = "",
  method = "GET",
  body?: unknown,
  token = "token-alice",
  extra: Record<string, string> = {},
) =>
  app.request(
    `https://sales.example.com${base()}${suffix}`,
    {
      method,
      headers: {
        Cookie: token ? `__Host-bs-access=${token}` : "",
        Origin: "https://sales.example.com",
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
const status = async () =>
  siteExportStatusSchema.parse(
    await (await req(`/status?document_hash=${v.document_hash}`)).json(),
  );
async function createVersion(
  actor = alice,
  project = p,
  doc = previewFixture(),
) {
  const client = db.client(actor),
    r = await client.rpc("studio_create_generation_job", {
      p_project_id: project.id,
      p_brief_version_id: project.brief,
      p_brief_hash: project.hash,
      p_request_id: crypto.randomUUID(),
    });
  const id = (r.data as { id: string }).id,
    attempt = crypto.randomUUID();
  await client.rpc("studio_start_generation_job", {
    p_job_id: id,
    p_attempt_id: attempt,
  });
  const saved = await client.rpc("studio_complete_generation_job", {
    p_job_id: id,
    p_attempt_id: attempt,
    p_document: doc,
  });
  if (saved.error) throw new Error(saved.error.code);
  return saved.data as typeof v;
}
async function approve(request_id = crypto.randomUUID()) {
  const state = await status();
  const body = {
    document_hash: v.document_hash,
    artifact_hash: state.artifact_hash,
    visual_hash: state.visual_hash,
    request_id,
    decision: "approved",
    confirm_review: true,
    confirm_public_use: true,
  };
  const r = await req("/reviews", "POST", body);
  expect(r.status).toBe(200);
  return { body, state: siteExportStatusSchema.parse(await r.json()) };
}
const downloadBody = (state: Awaited<ReturnType<typeof status>>) => ({
  document_hash: v.document_hash,
  artifact_hash: state.artifact_hash,
  visual_hash: state.visual_hash,
  review_id: state.review?.id,
  confirm: true,
});
beforeAll(async () => {
  await db.initialize();
});
beforeEach(async () => {
  await db.reset();
  p = await db.project();
  v = await createVersion();
  env = {
    APP_ORIGIN: "https://sales.example.com",
    SUPABASE_URL: "https://provider.example.com",
    SUPABASE_PUBLISHABLE_KEY: "synthetic-server-key-not-exported",
    STUDIO_AI_PROVIDER: "disabled",
    STUDIO_SITE_EXPORT_ENABLED: "true",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No real API in export tests");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.db.close();
});
describe("authorized export with real temporary SQL/RLS and exact human site review", () => {
  it("requires a separate site review; briefing approval and frontend flags cannot authorize ZIP", async () => {
    const state = await status();
    expect(state).toMatchObject({
      can_review: true,
      can_export: false,
      code: "review_required",
      review: null,
    });
    expect(
      (
        await req("", "POST", {
          ...downloadBody(state),
          review_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req("", "POST", {
          ...downloadBody(state),
          review_id: crypto.randomUUID(),
          approved: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await db.db.query("select * from public.studio_site_reviews")).rows,
    ).toHaveLength(0);
  });
  it("records exact-version/artifact review and returns a deterministic binary with no private notes or credentials", async () => {
    const reviewed = await approve();
    expect(reviewed.state).toMatchObject({
      can_export: true,
      review: { decision: "approved" },
    });
    const a = await req("", "POST", downloadBody(reviewed.state)),
      b = await req("", "POST", downloadBody(reviewed.state));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const x = new Uint8Array(await a.arrayBuffer()),
      y = new Uint8Array(await b.arrayBuffer());
    expect(x).toEqual(y);
    expect(await bytesSha256(x)).toBe(a.headers.get("X-Studio-Archive-SHA256"));
    expect(a.headers.get("Content-Type")).toBe("application/zip");
    expect(a.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="black-sales-site-v1-[a-f0-9]{12}\.zip"$/,
    );
    expect(a.headers.get("Cache-Control")).toBe("no-store");
    const text = new TextDecoder().decode(x);
    for (const value of [
      "Contato privado sintético",
      "Nota privada sintética",
      "export-review-v1",
      alice,
      p.id,
      p.brief,
      p.hash,
      env.SUPABASE_PUBLISHABLE_KEY!,
      env.SUPABASE_URL!,
      "https://example.com",
      "mailto:",
    ])
      expect(text).not.toContain(value);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps review requests idempotent without duplicating approvals", async () => {
    const { body, state } = await approve();
    const r = await req("/reviews", "POST", body);
    expect(siteExportStatusSchema.parse(await r.json()).review?.id).toBe(
      state.review?.id,
    );
    expect(
      (await db.db.query("select * from public.studio_site_reviews")).rows,
    ).toHaveLength(1);
  });
  it("uses the latest decision, blocks revoked/changed approvals and allows an explicit fresh review", async () => {
    const approved = await approve();
    const rejected = await req("/reviews", "POST", {
      ...approved.body,
      request_id: crypto.randomUUID(),
      decision: "changes_requested",
      confirm_public_use: false,
    });
    expect(rejected.status).toBe(200);
    expect((await status()).can_export).toBe(false);
    expect((await req("", "POST", downloadBody(approved.state))).status).toBe(
      409,
    );
    expect((await approve()).state.can_export).toBe(true);
    expect(
      (await db.db.query("select * from public.studio_site_reviews")).rows,
    ).toHaveLength(3);
  });
  it("does not transfer approval to another version but preserves a historical reviewed package with the same current public briefing", async () => {
    const first = v,
      { state } = await approve();
    v = await createVersion();
    expect((await status()).can_export).toBe(false);
    v = first;
    expect((await status()).can_export).toBe(true);
    expect((await req("", "POST", downloadBody(state))).status).toBe(200);
    expect(
      (
        await req("/reviews", "POST", {
          document_hash: v.document_hash,
          artifact_hash: state.artifact_hash,
          visual_hash: state.visual_hash,
          request_id: crypto.randomUUID(),
          decision: "approved",
          confirm_review: true,
          confirm_public_use: true,
        })
      ).status,
    ).toBe(409);
  });
  it("blocks stale briefing/public-use authorization even when the old site review is approved", async () => {
    const reviewed = await approve(),
      fields = briefFixture();
    fields.services.public_use = false;
    await db.client().rpc("studio_save_brief", {
      p_id: p.id,
      p_expected_head: p.brief,
      p_fields: fields,
      p_request_id: crypto.randomUUID(),
    });
    expect(await status()).toMatchObject({
      can_export: false,
      code: "brief_changed",
    });
    expect((await req("", "POST", downloadBody(reviewed.state))).status).toBe(
      409,
    );
  });
  it("rejects stale hashes, wrong artifact, generic notes and missing public-use confirmation", async () => {
    const state = await status();
    const body = {
      document_hash: v.document_hash,
      artifact_hash: state.artifact_hash,
      visual_hash: state.visual_hash,
      request_id: crypto.randomUUID(),
      decision: "approved",
      confirm_review: true,
      confirm_public_use: false,
    };
    expect((await req("/reviews", "POST", body)).status).toBe(400);
    expect(
      (
        await req("/reviews", "POST", {
          ...body,
          confirm_public_use: true,
          artifact_hash: "f".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req("/reviews", "POST", {
          ...body,
          confirm_public_use: true,
          visual_hash: "f".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req("/reviews", "POST", {
          ...body,
          confirm_public_use: true,
          notes: "Observação privada",
        })
      ).status,
    ).toBe(400);
    await db.client().rpc("studio_review_site_version", {
      p_version_id: v.id,
      p_document_hash: v.document_hash,
      p_decision: "approved",
      p_notes: "Aprovação genérica anterior",
      p_request_id: crypto.randomUUID(),
    });
    expect((await status()).can_export).toBe(false);
    expect((await req(`/status?document_hash=${"f".repeat(64)}`)).status).toBe(
      409,
    );
  });
  it("denies anonymous/inactive/other-owner/cross-origin requests and leaves existing records unchanged", async () => {
    const before = await db.db.query(
      "select to_jsonb(v) as row from public.studio_site_versions v order by id",
    );
    expect(
      (
        await req(
          `/status?document_hash=${v.document_hash}`,
          "GET",
          undefined,
          "",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await req(
          `/status?document_hash=${v.document_hash}`,
          "GET",
          undefined,
          "token-bob",
        )
      ).status,
    ).toBe(404);
    const reviewed = await approve();
    expect(
      (await req("", "POST", downloadBody(reviewed.state), "token-bob")).status,
    ).toBe(404);
    expect(
      (
        await req("", "POST", downloadBody(reviewed.state), "token-alice", {
          Origin: "https://evil.example.com",
        })
      ).status,
    ).toBe(403);
    await db.db.query(
      "update public.app_members set active=false where user_id=$1",
      [alice],
    );
    expect((await req("", "POST", downloadBody(reviewed.state))).status).toBe(
      403,
    );
    expect(
      (
        await db.db.query(
          "select to_jsonb(v) as row from public.studio_site_versions v order by id",
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it("defaults to disabled, reports missing review persistence and exports with AI disabled after controlled activation", async () => {
    delete env.STUDIO_SITE_EXPORT_ENABLED;
    expect(await status()).toMatchObject({
      enabled: false,
      can_export: false,
      code: "export_disabled",
    });
    const state = await status();
    expect(
      (
        await req("/reviews", "POST", {
          document_hash: v.document_hash,
          artifact_hash: state.artifact_hash,
          visual_hash: state.visual_hash,
          request_id: crypto.randomUUID(),
          decision: "approved",
          confirm_review: true,
          confirm_public_use: true,
        })
      ).status,
    ).toBe(503);
    env.STUDIO_SITE_EXPORT_ENABLED = "true";
    db.missingTable = "studio_site_reviews";
    const missing = await req(`/status?document_hash=${v.document_hash}`);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "migration_missing" });
  });
  it("rejects known credentials embedded in otherwise valid stored public text", async () => {
    const doc = previewFixture();
    doc.identity.tagline = env.SUPABASE_PUBLISHABLE_KEY;
    v = await createVersion(alice, p, doc);
    const response = await req(`/status?document_hash=${v.document_hash}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_document" });
  });
  it("blocks an authorization change discovered at final revalidation before releasing ZIP bytes", async () => {
    const { state } = await approve(),
      original = db.query.bind(db);
    let reviewReads = 0;
    vi.spyOn(db, "query").mockImplementation(async (actor, sql, params) => {
      const result = await original(actor, sql, params);
      if (
        sql.includes('"studio_site_reviews"') &&
        ++reviewReads >= 2 &&
        !result.error
      )
        for (const row of result.data as Record<string, unknown>[])
          row.decision = "changes_requested";
      return result;
    });
    const r = await req("", "POST", downloadBody(state));
    expect(r.status).toBe(409);
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });
  it("cannot use a valid other-owner review to authorize the selected version", async () => {
    const other = await db.project(bob),
      version = await createVersion(bob, other),
      state = await status();
    const r = await req("", "POST", {
      ...downloadBody(state),
      review_id: version.id,
    });
    expect(r.status).toBe(409);
  });
  it("requires active owner authentication on both mutation endpoints and rejects mismatched visual hashes", async () => {
    const { body, state } = await approve();
    for (const token of ["", "token-bob"]) {
      expect([401, 403, 404]).toContain(
        (await req("/reviews", "POST", body, token)).status,
      );
      expect([401, 403, 404]).toContain(
        (await req("", "POST", downloadBody(state), token)).status,
      );
    }
    await db.db.query(
      "update public.app_members set active=false where user_id=$1",
      [alice],
    );
    expect((await req("/reviews", "POST", body)).status).toBe(403);
    expect((await req("", "POST", downloadBody(state))).status).toBe(403);
    await db.db.query(
      "update public.app_members set active=true where user_id=$1",
      [alice],
    );
    expect(
      (
        await req("", "POST", {
          ...downloadBody(state),
          visual_hash: "f".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (await req("", "POST", { ...downloadBody(state), confirm: false }))
        .status,
    ).toBe(400);
    expect(
      (await db.db.query("select * from public.studio_site_reviews")).rows,
    ).toHaveLength(1);
  });
});
