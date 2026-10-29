import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { emptyBrief, type BriefFields } from "../shared/studio";
const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222";
async function rows(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}
async function actor(id = alice) {
  await db.exec(
    `reset role;set role authenticated;set "request.jwt.claim.sub"='${id}';`,
  );
}
async function create(
  mode = "demo",
  lead: unknown = null,
  request = crypto.randomUUID(),
  title = "Projeto sintético de teste",
) {
  return (
    await rows("select public.studio_create_project($1,$2,$3,$4) as r", [
      title,
      mode,
      lead,
      request,
    ])
  )[0].r as { project_id: string; version_id: string };
}
async function detail(id: string, version: string | null = null) {
  return (
    await rows("select public.studio_project_detail($1,$2) as r", [id, version])
  )[0].r as {
    project: { head_id: string; lead_snapshot: Record<string, unknown> };
    version: {
      id: string;
      number: number;
      fields: BriefFields;
      parent_id: string | null;
      content_hash: string;
      approval: Record<string, unknown> | null;
    };
  };
}
async function save(
  id: string,
  head: string,
  fields: BriefFields,
  request = crypto.randomUUID(),
) {
  return (
    await rows("select public.studio_save_brief($1,$2,$3::jsonb,$4) as r", [
      id,
      head,
      JSON.stringify(fields),
      request,
    ])
  )[0].r as { version_id: string; number: number };
}
async function approve(id: string, version: string, hash: string) {
  return (
    await rows("select public.studio_approve_brief($1,$2,$3) as r", [
      id,
      version,
      hash,
    ])
  )[0].r as Record<string, unknown>;
}
function reviewed() {
  const f = emptyBrief();
  for (const k of [
    "company",
    "sector",
    "city",
    "services",
    "audience",
  ] as const)
    f[k] = {
      value: `${k}: fixture sintética`,
      source: "Declaração de teste",
      verification: "verified",
      public_use: false,
    };
  return f;
}
beforeAll(async () => {
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for (const file of [
    "202610290001_foundation.sql",
    "202610290002_discovery.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  await db.exec(
    `insert into auth.users values ('${alice}');insert into public.app_members values ('${alice}',true);`,
  );
  await actor();
  await db.exec(
    "insert into public.leads(company,city,notes) values ('Empresa anterior de teste','Passos','Preservar')",
  );
  await db.exec(
    "insert into public.discovery_results(company,city,state,sector,source_name,collected_at) values ('Descoberta anterior de teste','Passos','MG','Teste','Fixture',now())",
  );
  await db.exec("reset role");
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610290003_studio.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await actor();
  expect((await rows("select notes,version from public.leads"))[0]).toEqual({
    notes: "Preservar",
    version: 1,
  });
  expect(await rows("select * from public.lead_events")).toHaveLength(1);
  expect(await rows("select * from public.discovery_results")).toHaveLength(1);
});
beforeEach(async () => {
  await db.exec(`reset role;truncate public.studio_brief_approvals,public.studio_brief_versions,public.studio_projects,public.discovery_origins,public.discovery_results,public.lead_events,public.leads,public.app_members,auth.users cascade;
  insert into auth.users values ('${alice}'),('${bob}');insert into public.app_members values ('${alice}',true),('${bob}',true);`);
  await actor();
});
afterAll(async () => {
  await db.close();
});
describe("studio PostgreSQL persistence, immutable versions and approvals", () => {
  it("creates a labelled demonstration with an empty first draft, and retries idempotently", async () => {
    const request = crypto.randomUUID();
    const p = await create("demo", null, request);
    const d = await detail(p.project_id);
    expect(d.version.fields).toEqual(emptyBrief());
    expect(d.version.number).toBe(1);
    expect(d.version.approval).toBeNull();
    expect(await create("demo", null, request)).toEqual(p);
    expect(await rows("select * from public.studio_projects")).toHaveLength(1);
    await expect(
      create("demo", null, request, "Other title"),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await rows("select * from public.leads")).toHaveLength(0);
  });
  it("takes an owned active opportunity snapshot, without asserting verification or changing the CRM", async () => {
    const lead = (
      await rows(
        "insert into public.leads(company,city,sector,contact) values ('Fixture real de teste','Passos','Serviços','Contato de teste') returning id",
      )
    )[0].id;
    const p = await create("opportunity", lead);
    let d = await detail(p.project_id);
    expect(d.version.fields.company).toMatchObject({
      value: "Fixture real de teste",
      verification: "pending",
      public_use: false,
    });
    expect(d.version.fields.contacts.value).toBe("Contato de teste");
    await rows(
      "update public.leads set company='Renamed synthetic fixture',deleted_at=now() where id=$1",
      [lead],
    );
    d = await detail(p.project_id);
    expect(d.project.lead_snapshot.company).toBe("Fixture real de teste");
    expect(d.version.fields.company.value).toBe("Fixture real de teste");
    await expect(create("opportunity", lead)).rejects.toMatchObject({
      code: "42501",
    });
    expect(await rows("select * from public.lead_events")).toHaveLength(2);
  });
  it("blocks foreign opportunities, archived records, invalid modes and owner/actor forgery", async () => {
    const lead = (
      await rows(
        "insert into public.leads(company,city) values ('Owned test','Passos') returning id",
      )
    )[0].id;
    await actor(bob);
    await expect(create("opportunity", lead)).rejects.toMatchObject({
      code: "42501",
    });
    for (const [mode, ref] of [
      ["other", null],
      ["demo", lead],
      ["opportunity", null],
    ])
      await expect(create(mode as string, ref)).rejects.toMatchObject({
        code: "22023",
      });
    expect(await rows("select * from public.studio_projects")).toHaveLength(0);
    await expect(
      rows(
        "insert into public.studio_projects(owner_id,title,mode,request_id) values ($1,'forged','demo',$2)",
        [alice, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("saves partial drafts immutably with revisions, rejects stale saves and supports safe retries", async () => {
    const p = await create();
    const fields = emptyBrief();
    fields.company.value = "Rascunho sintético";
    const request = crypto.randomUUID();
    const v = await save(p.project_id, p.version_id, fields, request);
    expect(v.number).toBe(2);
    expect((await detail(p.project_id)).version.parent_id).toBe(p.version_id);
    expect(
      (await detail(p.project_id, p.version_id)).version.fields.company.value,
    ).toBe("");
    expect(await save(p.project_id, p.version_id, fields, request)).toEqual(v);
    await expect(
      save(p.project_id, p.version_id, fields),
    ).rejects.toMatchObject({ code: "40001" });
    const changed = structuredClone(fields);
    changed.company.value = "Other";
    await expect(
      save(p.project_id, p.version_id, changed, request),
    ).rejects.toMatchObject({ code: "22023" });
    expect(
      await rows("select * from public.studio_brief_versions"),
    ).toHaveLength(2);
  });
  it("rejects malformed fields, private notes made public, unknown keys and fabricated verification in a real project", async () => {
    const p = await create();
    const invalid: unknown[] = [
      {},
      null,
      { ...emptyBrief(), extra: "injected" },
    ];
    for (const patch of [
      { value: 22 },
      { value: "bad\u0001" },
      { value: "a".repeat(101) },
      { value: "verified", verification: "verified", source: "" },
      { value: "x", verification: "pending", public_use: true },
      { value: "x", owner_id: bob },
    ])
      invalid.push({
        ...emptyBrief(),
        company: { ...emptyBrief().company, ...patch },
      });
    const privateNotes = reviewed();
    privateNotes.creative_notes = {
      value: "Internal",
      source: "Author",
      verification: "verified",
      public_use: true,
    };
    invalid.push(privateNotes);
    for (const fields of invalid)
      await expect(
        save(p.project_id, p.version_id, fields as BriefFields),
      ).rejects.toMatchObject({ code: "22023" });
    expect(
      await rows("select * from public.studio_brief_versions"),
    ).toHaveLength(1);
    const lead = (
      await rows(
        "insert into public.leads(company,city) values ('Test','Passos') returning id",
      )
    )[0].id;
    const real = await create("opportunity", lead);
    const fictional = reviewed();
    fictional.company.verification = "fictional";
    await expect(
      save(real.project_id, real.version_id, fictional),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("requires reviewed required content and binds approval to exact ID and hash with server actor/time", async () => {
    const p = await create();
    let d = await detail(p.project_id);
    await expect(
      approve(p.project_id, p.version_id, d.version.content_hash),
    ).rejects.toMatchObject({ code: "22023" });
    const f = reviewed();
    f.company.public_use = true;
    const saved = await save(p.project_id, p.version_id, f);
    d = await detail(p.project_id);
    await expect(
      approve(p.project_id, saved.version_id, "f".repeat(64)),
    ).rejects.toMatchObject({ code: "40001" });
    const a = await approve(
      p.project_id,
      saved.version_id,
      d.version.content_hash,
    );
    expect(a).toMatchObject({
      actor_id: alice,
      version_id: saved.version_id,
      content_hash: d.version.content_hash,
    });
    expect(a.created_at).toBeTruthy();
    expect(
      await approve(p.project_id, saved.version_id, d.version.content_hash),
    ).toEqual(a);
    expect(
      await rows("select * from public.studio_brief_approvals"),
    ).toHaveLength(1);
  });
  it("does not transfer approval to a new draft, keeps old approval and rejects old-head approval", async () => {
    const p = await create();
    const f = reviewed();
    const v2 = await save(p.project_id, p.version_id, f);
    const approved = await detail(p.project_id);
    await approve(p.project_id, v2.version_id, approved.version.content_hash);
    f.colors.value = "Direção nova informada pelo teste";
    const v3 = await save(p.project_id, v2.version_id, f);
    expect((await detail(p.project_id)).version.approval).toBeNull();
    expect(
      (await detail(p.project_id, v2.version_id)).version.approval,
    ).not.toBeNull();
    await expect(
      approve(p.project_id, v2.version_id, approved.version.content_hash),
    ).rejects.toMatchObject({ code: "40001" });
    expect((await detail(p.project_id)).project.head_id).toBe(v3.version_id);
    for (const table of [
      "studio_projects",
      "studio_brief_versions",
      "studio_brief_approvals",
    ]) {
      await expect(
        db.exec(`delete from public.${table}`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.exec(`update public.${table} set owner_id='${bob}'`),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      rows(
        "insert into public.studio_brief_approvals(owner_id,project_id,version_id,content_hash,actor_id) values ($1,$2,$3,$4,$1)",
        [alice, p.project_id, v3.version_id, approved.version.content_hash],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("isolates reads and all definer RPCs between users, including cross-project version selection", async () => {
    const p = await create();
    const f = reviewed();
    await save(p.project_id, p.version_id, f);
    const original = await detail(p.project_id);
    await actor(bob);
    for (const table of [
      "studio_projects",
      "studio_brief_versions",
      "studio_brief_approvals",
    ])
      expect(await rows(`select * from public.${table}`)).toHaveLength(0);
    await expect(detail(p.project_id)).rejects.toMatchObject({ code: "42501" });
    await expect(
      save(p.project_id, original.version.id, f),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approve(p.project_id, original.version.id, original.version.content_hash),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rows("select * from public.studio_list_briefs($1,0)", [p.project_id]),
    ).rejects.toMatchObject({ code: "42501" });
    const own = await create();
    await expect(
      detail(own.project_id, original.version.id),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approve(
        own.project_id,
        original.version.id,
        original.version.content_hash,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await actor();
    expect((await detail(p.project_id)).version.fields).toEqual(f);
  });
  it("revokes reads, writes and approvals when membership is disabled; denies anonymous RPC access", async () => {
    const p = await create();
    await db.exec(
      `reset role;update public.app_members set active=false where user_id='${alice}'`,
    );
    await actor();
    expect(await rows("select * from public.studio_projects")).toHaveLength(0);
    for (const action of [
      () => create(),
      () => detail(p.project_id),
      () => save(p.project_id, p.version_id, emptyBrief()),
      () => approve(p.project_id, p.version_id, "x"),
    ])
      await expect(action()).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role;set role anon");
    await expect(create()).rejects.toMatchObject({ code: "42501" });
    await expect(
      rows("select * from public.studio_brief_versions"),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("paginates project/history lists and omits full fields from history metadata", async () => {
    const p = await create();
    let head = p.version_id;
    for (let i = 0; i < 51; i++) {
      const f = emptyBrief();
      f.company.value = `Rascunho de teste ${i}`;
      head = (await save(p.project_id, head, f)).version_id;
    }
    const first = await rows("select * from public.studio_list_briefs($1,0)", [
      p.project_id,
    ]);
    const second = await rows(
      "select * from public.studio_list_briefs($1,50)",
      [p.project_id],
    );
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain('"fields"');
    expect(
      await rows("select * from public.studio_list_projects(50)"),
    ).toHaveLength(0);
    await expect(
      rows("select * from public.studio_list_projects(-1)"),
    ).rejects.toMatchObject({ code: "22023" });
  });
});
