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
import {
  previewVersionsSchema,
  previewVersionSchema,
} from "../shared/studio-preview";

const db = new GenerationDatabase();
const env: Bindings = {
  APP_ORIGIN: "https://sales.example.com",
  SUPABASE_URL: "https://provider.example.com",
  SUPABASE_PUBLISHABLE_KEY: "synthetic-server-only-key",
  STUDIO_AI_PROVIDER: "disabled",
};
const app = createApp(db.factory);
let project: { id: string; brief: string; hash: string };
let first: { id: string; document_hash: string; number: number },
  second: typeof first;
const path = (suffix: string, id = project.id) =>
  `/api/studio/projects/${id}/site-preview${suffix}`;
const req = (suffix: string, token = "token-alice", id = project.id) =>
  app.request(
    `https://sales.example.com${path(suffix, id)}`,
    { headers: { Cookie: token ? `__Host-bs-access=${token}` : "" } },
    env,
  );
const selected = (v: typeof first) =>
  `/versions/${v.id}?document_hash=${v.document_hash}`;
const frame = (v: typeof first) =>
  `/versions/${v.id}/frame?document_hash=${v.document_hash}`;
async function version(
  actor = alice,
  p = project,
  label = "Primeira versão sintética",
) {
  const client = db.client(actor);
  const admitted = await client.rpc("studio_create_generation_job", {
    p_project_id: p.id,
    p_brief_version_id: p.brief,
    p_brief_hash: p.hash,
    p_request_id: crypto.randomUUID(),
  });
  const id = (admitted.data as { id: string }).id,
    attempt = crypto.randomUUID();
  await client.rpc("studio_start_generation_job", {
    p_job_id: id,
    p_attempt_id: attempt,
  });
  const doc = previewFixture();
  doc.pages[0].sections[0].heading = label;
  const result = await client.rpc("studio_complete_generation_job", {
    p_job_id: id,
    p_attempt_id: attempt,
    p_document: doc,
  });
  if (result.error)
    throw new Error(`Synthetic version fixture failed: ${result.error.code}`);
  return result.data as typeof first;
}
beforeAll(async () => {
  await db.initialize();
});
beforeEach(async () => {
  await db.reset();
  project = await db.project();
  first = await version();
  second = await version(alice, project, "Segunda versão sintética");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network or AI allowed in preview tests");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.db.close();
});
describe("read-only authenticated preview API (temporary real SQL/RLS)", () => {
  it("lists only metadata, identifies the current site and previews the exact selected version", async () => {
    const response = await req("/versions");
    expect(response.status).toBe(200);
    const list = previewVersionsSchema.parse(await response.json());
    expect(list.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(list.current_version_id).toBe(second.id);
    const metadata = previewVersionSchema.parse(
      await (await req(selected(first))).json(),
    );
    expect(metadata.version).toMatchObject({
      id: first.id,
      document_hash: first.document_hash,
      number: 1,
    });
    expect(metadata.current_version_id).toBe(second.id);
    const a = await req(frame(first)),
      b = await req(frame(second));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const html = await a.text(),
      other = await b.text();
    expect(html).toContain("Primeira versão sintética");
    expect(html).not.toContain("Segunda versão sintética");
    expect(other).toContain("Segunda versão sintética");
    expect(a.headers.get("X-Studio-Site-Version")).toBe(first.id);
    expect(a.headers.get("X-Studio-Document-Hash")).toBe(first.document_hash);
    expect(metadata.visual_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.headers.get("X-Studio-Visual-SHA256")).toBe(metadata.visual_hash);
    expect(
      (await req(frame(first) + `&visual_hash=${metadata.visual_hash}`)).status,
    ).toBe(200);
    const changedRenderer = await req(
      frame(first) + `&visual_hash=${"f".repeat(64)}`,
    );
    expect(changedRenderer.status).toBe(409);
    expect(await changedRenderer.text()).not.toContain(
      "Primeira versão sintética",
    );
    expect(JSON.stringify(metadata)).not.toContain('document"');
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sets restrictive framing/security/cache policies without weakening ordinary API responses", async () => {
    const response = await req(frame(first));
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "; sandbox",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await req(selected(first))).headers.get("X-Frame-Options")).toBe(
      "DENY",
    );
  });
  it("omits private brief/snapshot data and external destinations from rendered output", async () => {
    const response = await req(frame(first)),
      html = await response.text();
    for (const s of [
      "Contato privado sintético",
      "Nota privada sintética",
      "Documento interno",
      "public_information",
      "owner_id",
      "attempt_id",
      "https://example.com",
      "mailto:",
      env.SUPABASE_PUBLISHABLE_KEY!,
    ])
      expect(html).not.toContain(s);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
  });
  it("rejects wrong/missing hash instead of silently showing a different/latest version", async () => {
    const wrong = await req(
      `/versions/${first.id}?document_hash=${"f".repeat(64)}`,
    );
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: "preview_changed" });
    const bad = await req(
      `/versions/${first.id}/frame?document_hash=${"f".repeat(64)}`,
    );
    expect(bad.status).toBe(409);
    expect(await bad.text()).not.toContain("Primeira versão sintética");
    expect((await req(`/versions/${first.id}`)).status).toBe(400);
    expect(
      (
        await req(
          `/versions/${crypto.randomUUID()}?document_hash=${first.document_hash}`,
        )
      ).status,
    ).toBe(404);
  });
  it("denies anonymous, inactive and cross-user access, including direct iframe URLs", async () => {
    expect((await req("/versions", "")).status).toBe(401);
    const anon = await req(frame(first), "");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("Content-Type")).toContain("text/html");
    expect(await anon.text()).toContain("Entre novamente");
    for (const suffix of ["/versions", selected(first), frame(first)])
      expect((await req(suffix, "token-bob")).status).toBe(404);
    await db.db.query(
      "update public.app_members set active=false where user_id=$1",
      [alice],
    );
    expect((await req(frame(first))).status).toBe(403);
  });
  it("rejects a version belonging to another project even for the same owner", async () => {
    const other = await db.project(),
      v = await version(alice, other);
    expect((await req(selected(v))).status).toBe(404);
    expect((await req(frame(v))).status).toBe(404);
    const theirs = await db.project(bob),
      theirVersion = await version(bob, theirs);
    expect(
      (await req(frame(theirVersion), "token-bob", theirs.id)).status,
    ).toBe(200);
  });
  it("returns empty state and a safe missing-migration error without creating data", async () => {
    const empty = await db.project();
    expect(
      previewVersionsSchema.parse(
        await (await req("/versions", "token-alice", empty.id)).json(),
      ),
    ).toMatchObject({ versions: [], current_version_id: null });
    db.missingTable = "studio_site_versions";
    const missing = await req("/versions");
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "migration_missing" });
    const html = await req(frame(first));
    expect(html.status).toBe(503);
    expect(await html.text()).toContain("Prévia indisponível");
  });
  it("identifies the original briefing without loading private current fields or changing approvals", async () => {
    const before = await db.db.query(
      "select to_jsonb(a) as row from public.studio_brief_approvals a order by id",
    );
    const newer = await db.client().rpc("studio_save_brief", {
      p_id: project.id,
      p_expected_head: project.brief,
      p_fields: briefFixture(),
      p_request_id: crypto.randomUUID(),
    });
    const metadata = previewVersionSchema.parse(
      await (await req(selected(first))).json(),
    );
    expect(metadata.current_brief_version_id).toBe(
      (newer.data as { version_id: string }).version_id,
    );
    expect(metadata.version.brief_version_id).toBe(project.brief);
    expect((await req(frame(first))).status).toBe(200);
    expect(
      (
        await db.db.query(
          "select to_jsonb(a) as row from public.studio_brief_approvals a order by id",
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it("rejects invalid stored documents in BOTH metadata and HTML paths without changing immutable rows", async () => {
    // Inject corruption at the transport seam; real table CHECKs/triggers remain
    // enabled. This proves the HTTP boundary validates even if storage lies.
    const original = db.query.bind(db);
    vi.spyOn(db, "query").mockImplementation(async (actor, sql, params) => {
      const result = await original(actor, sql, params);
      if (
        sql.includes('"document"') &&
        sql.includes('"studio_site_versions"') &&
        !result.error
      ) {
        for (const row of result.data as Record<string, unknown>[])
          row.document = { ...previewFixture(), javascript: "alert(1)" };
      }
      return result;
    });
    const metadata = await req(selected(first));
    expect(metadata.status).toBe(422);
    expect(await metadata.json()).toMatchObject({ code: "invalid_document" });
    const response = await req(frame(first));
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("alert(1)");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
  });
});
