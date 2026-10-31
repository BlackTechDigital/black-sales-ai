import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { Context } from "hono";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import type { ApiEnv } from "../server/types";
import { getSiteGenerationEligibility } from "../server/studio-site-eligibility";
import { siteDocumentSchema, type SiteDocument } from "../shared/studio-sites";
import {
  alice,
  bob,
  authBootstrap,
  briefFixture,
  documentFixture,
  persistenceMigration,
  previousMigrations,
} from "./fixtures/site-persistence";

const db = new PGlite(); // In memory only; never reads DATABASE_URL.
interface Project {
  id: string;
  brief: string;
  hash: string;
}
interface Job {
  id: string;
  site_id: string;
  brief_version_id: string;
  brief_hash: string;
  public_information: Record<string, string>;
  status: string;
  attempt_id: string | null;
  base_version_id: string | null;
  error_code: string | null;
}
interface Version {
  id: string;
  job_id: string;
  number: number;
  parent_id: string | null;
  document_hash: string;
  document: SiteDocument;
  site_id: string;
  brief_version_id: string;
}
async function rows(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}
async function actor(id = alice) {
  await db.exec(
    `reset role;set role authenticated;set "request.jwt.claim.sub"='${id}';`,
  );
}
async function rpc<T>(
  fn: string,
  values: unknown[],
  casts = values.map(() => ""),
) {
  return (
    await rows(
      `select to_jsonb(public.${fn}(${values.map((_, i) => `$${i + 1}${casts[i]}`).join(",")})) as result`,
      values,
    )
  )[0].result as T;
}
async function project(fields = briefFixture()): Promise<Project> {
  const p = await rpc<{ project_id: string; version_id: string }>(
    "studio_create_project",
    ["Projeto sintético", "demo", null, crypto.randomUUID()],
  );
  const v = await rpc<{ version_id: string }>(
    "studio_save_brief",
    [p.project_id, p.version_id, JSON.stringify(fields), crypto.randomUUID()],
    ["", "", "::jsonb", ""],
  );
  const d = await rpc<{ version: { content_hash: string } }>(
    "studio_project_detail",
    [p.project_id, null],
  );
  await rpc("studio_approve_brief", [
    p.project_id,
    v.version_id,
    d.version.content_hash,
  ]);
  return {
    id: p.project_id,
    brief: v.version_id,
    hash: d.version.content_hash,
  };
}
const admit = (p: Project, request = crypto.randomUUID()) =>
  rpc<Job>("studio_create_generation_job", [p.id, p.brief, p.hash, request]);
const start = (job: Job, attempt = crypto.randomUUID()) =>
  rpc<Job>("studio_start_generation_job", [job.id, attempt]);
const complete = (
  job: Job,
  doc: unknown = documentFixture(),
  attempt = job.attempt_id,
) =>
  rpc<Version>(
    "studio_complete_generation_job",
    [job.id, attempt, JSON.stringify(doc)],
    ["", "", "::jsonb"],
  );
const fail = (job: Job, code = "cancelled", attempt = job.attempt_id) =>
  rpc<Job>("studio_fail_generation_job", [job.id, attempt, code]);
const review = (
  v: Version,
  decision = "approved",
  request = crypto.randomUUID(),
  notes = "Revisão sintética",
) =>
  rpc<{ id: string; actor_id: string; document_hash: string }>(
    "studio_review_site_version",
    [v.id, v.document_hash, decision, notes, request],
  );
async function migration(file: string) {
  await db.exec(
    await readFile(
      new URL(`../supabase/migrations/${file}`, import.meta.url),
      "utf8",
    ),
  );
}
beforeAll(async () => {
  await db.exec(authBootstrap);
  for (const file of previousMigrations) await migration(file);
  await db.exec(
    `insert into auth.users values ('${alice}'),('${bob}');insert into public.app_members values ('${alice}',true),('${bob}',true);`,
  );
  await actor();
  await db.exec(
    "insert into public.leads(company,city,notes) values ('Registro sintético anterior','Passos','Preservar integralmente')",
  );
  await db.exec(
    "insert into public.discovery_results(company,city,state,sector,source_name,collected_at) values ('Descoberta sintética','Passos','MG','Teste','Fixture',now())",
  );
  await project();
  const tables = [
    "leads",
    "lead_events",
    "discovery_results",
    "studio_projects",
    "studio_brief_versions",
    "studio_brief_approvals",
  ];
  const before = await Promise.all(
    tables.map((t) =>
      rows(`select to_jsonb(t) as row from public.${t} t order by id`),
    ),
  );
  await db.exec("reset role");
  // Supabase installations may have permissive defaults. New objects must
  // explicitly revoke these grants rather than only revoking PUBLIC.
  await db.exec(
    "alter default privileges in schema public grant all on tables to anon,authenticated;alter default privileges in schema public grant all on functions to anon,authenticated;",
  );
  await migration(persistenceMigration);
  await actor();
  expect(
    await Promise.all(
      tables.map((t) =>
        rows(`select to_jsonb(t) as row from public.${t} t order by id`),
      ),
    ),
  ).toEqual(before);
});
beforeEach(async () => {
  await db.exec(`reset role;truncate public.studio_site_reviews,public.studio_site_versions,public.studio_generation_jobs,public.studio_sites,public.studio_brief_approvals,public.studio_brief_versions,public.studio_projects,public.discovery_origins,public.discovery_results,public.lead_events,public.leads,public.app_members,auth.users cascade;
    insert into auth.users values ('${alice}'),('${bob}');insert into public.app_members values ('${alice}',true),('${bob}',true);`);
  await actor();
});
afterAll(async () => {
  await db.close();
});

describe("site persistence: admission and state machine", () => {
  it("atomically records an approved briefing and snapshots exactly the Stage 1 public context", async () => {
    const p = await project();
    const request = crypto.randomUUID();
    const job = await admit(p, request);
    const context = {
      get: (key: string) =>
        key === "user"
          ? { id: alice }
          : {
              rpc: async (
                _name: string,
                args: { p_id: string; p_version_id: string | null },
              ) => ({
                data: await rpc("studio_project_detail", [
                  args.p_id,
                  args.p_version_id,
                ]),
                error: null,
              }),
            },
    } as unknown as Pick<Context<ApiEnv>, "get">;
    const eligibility = await getSiteGenerationEligibility(context, {
      project_id: p.id,
      brief_version_id: p.brief,
      brief_hash: p.hash,
    });
    expect(eligibility.eligible).toBe(true);
    if (!eligibility.eligible) throw new Error("Expected eligible fixture");
    expect(job.public_information).toEqual(
      eligibility.context.public_information,
    );
    expect(JSON.stringify(job)).not.toContain("privado");
    expect(job).toMatchObject({
      status: "pending",
      brief_version_id: p.brief,
      brief_hash: p.hash,
      attempt_id: null,
      base_version_id: null,
    });
    expect(await admit(p, request)).toEqual(job);
    expect(await rows("select * from public.studio_sites")).toHaveLength(1);
    expect(
      await rows("select * from public.studio_generation_jobs"),
    ).toHaveLength(1);
    expect(
      await rows("select * from public.studio_site_versions"),
    ).toHaveLength(0);
  });
  it("rejects unapproved, insufficient-public, wrong hash and outdated briefs without inserting rows", async () => {
    const raw = await rpc<{ project_id: string; version_id: string }>(
      "studio_create_project",
      ["Fixture", "demo", null, crypto.randomUUID()],
    );
    const d = await rpc<{ version: { content_hash: string } }>(
      "studio_project_detail",
      [raw.project_id, null],
    );
    await expect(
      admit({
        id: raw.project_id,
        brief: raw.version_id,
        hash: d.version.content_hash,
      }),
    ).rejects.toMatchObject({ code: "22023" });
    const fields = briefFixture();
    fields.services.public_use = false;
    const privateProject = await project(fields);
    await expect(admit(privateProject)).rejects.toMatchObject({
      code: "22023",
    });
    const p = await project();
    await expect(admit({ ...p, hash: "f".repeat(64) })).rejects.toMatchObject({
      code: "22023",
    });
    await rpc(
      "studio_save_brief",
      [p.id, p.brief, JSON.stringify(briefFixture()), crypto.randomUUID()],
      ["", "", "::jsonb", ""],
    );
    await expect(admit(p)).rejects.toMatchObject({ code: "40001" });
    expect(
      await rows("select * from public.studio_generation_jobs"),
    ).toHaveLength(0);
    expect(await rows("select * from public.studio_sites")).toHaveLength(0);
  });
  it("prevents a second active job, rejects request reuse with different input and retains idempotency after completion", async () => {
    const p = await project(),
      request = crypto.randomUUID();
    let j = await admit(p, request);
    await expect(admit(p)).rejects.toMatchObject({ code: "40001" });
    await expect(
      admit({ ...p, hash: "f".repeat(64) }, request),
    ).rejects.toMatchObject({ code: "22023" });
    j = await start(j);
    const v = await complete(j);
    expect((await admit(p, request)).status).toBe("completed");
    const next = await admit(p);
    expect(next.base_version_id).toBe(v.id);
    expect(next.id).not.toBe(j.id);
    expect(
      await rows("select * from public.studio_generation_jobs"),
    ).toHaveLength(2);
  });
  it("supports guarded claims, completion retries and terminal states without reusing another attempt", async () => {
    let j = await admit(await project());
    await expect(complete(j)).rejects.toMatchObject({ code: "40001" });
    const attempt = crypto.randomUUID();
    j = await start(j, attempt);
    expect(await start(j, attempt)).toEqual(j);
    await expect(start(j)).rejects.toMatchObject({ code: "40001" });
    await expect(
      complete(j, documentFixture(), crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "40001" });
    const v = await complete(j);
    expect(await complete(j)).toEqual(v);
    const different = documentFixture();
    different.pages[0].description = "Outro conteúdo sintético";
    await expect(complete(j, different)).rejects.toMatchObject({
      code: "22023",
    });
    await expect(fail(j)).rejects.toMatchObject({ code: "40001" });
    expect(
      await rows("select * from public.studio_site_versions"),
    ).toHaveLength(1);
  });
  it("fails pending/processing jobs with bounded error codes and cannot complete or reopen failures", async () => {
    const p = await project();
    let j = await admit(p);
    j = await fail(j);
    expect(j).toMatchObject({
      status: "failed",
      error_code: "cancelled",
      attempt_id: null,
    });
    expect(await fail(j)).toEqual(j);
    await expect(start(j)).rejects.toMatchObject({ code: "40001" });
    await expect(complete(j)).rejects.toMatchObject({ code: "40001" });
    let next = await admit(p);
    next = await start(next);
    await expect(
      fail(next, "provider message containing secret token"),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      fail(next, "timeout", crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "40001" });
    expect((await fail(next, "timeout")).status).toBe("failed");
    expect(
      await rows("select * from public.studio_site_versions"),
    ).toHaveLength(0);
  });
  it("blocks starting an outdated queued brief but permits explicit cancellation", async () => {
    const p = await project();
    const j = await admit(p);
    await rpc(
      "studio_save_brief",
      [p.id, p.brief, JSON.stringify(briefFixture()), crypto.randomUUID()],
      ["", "", "::jsonb", ""],
    );
    await expect(start(j)).rejects.toMatchObject({ code: "40001" });
    expect((await fail(j, "brief_changed")).status).toBe("failed");
  });
});

describe("site persistence: document, versions and reviews", () => {
  it("appends immutable numbered versions with matching parent, job and briefing", async () => {
    const p = await project();
    let j = await start(await admit(p));
    const first = await complete(j);
    j = await start(await admit(p));
    const doc = documentFixture();
    doc.pages[0].description = "Segundo resultado sintético";
    const second = await complete(j, doc);
    expect(first.number).toBe(1);
    expect(first.parent_id).toBeNull();
    expect(second).toMatchObject({
      number: 2,
      parent_id: first.id,
      brief_version_id: p.brief,
    });
    expect(
      (
        await rows(
          "select document from public.studio_site_versions where id=$1",
          [first.id],
        )
      )[0].document,
    ).toEqual(documentFixture());
    expect(
      (await rows("select head_version_id from public.studio_sites"))[0]
        .head_version_id,
    ).toBe(second.id);
  });
  it("requires exact human review bindings, appends decisions and never transfers review to a new version", async () => {
    const p = await project();
    const v = await complete(await start(await admit(p)));
    const request = crypto.randomUUID();
    const r = await review(v, "approved", request);
    expect(r).toMatchObject({
      actor_id: alice,
      document_hash: v.document_hash,
    });
    expect(await review(v, "approved", request)).toEqual(r);
    await expect(review(v, "changes_requested", request)).rejects.toMatchObject(
      { code: "22023" },
    );
    await expect(
      review({ ...v, document_hash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "40001" });
    await review(v, "changes_requested");
    expect(await rows("select * from public.studio_site_reviews")).toHaveLength(
      2,
    );
    const next = await complete(await start(await admit(p)));
    expect(
      await rows(
        "select * from public.studio_site_reviews where version_id=$1",
        [next.id],
      ),
    ).toHaveLength(0);
    await expect(review(v)).rejects.toMatchObject({ code: "40001" });
    expect(await review(v, "approved", request)).toEqual(r); // Historical retry creates no new approval.
  });
  it("keeps in-flight output tied to its approved input but refuses approval when the briefing has changed", async () => {
    const p = await project();
    const j = await start(await admit(p));
    await rpc(
      "studio_save_brief",
      [p.id, p.brief, JSON.stringify(briefFixture()), crypto.randomUUID()],
      ["", "", "::jsonb", ""],
    );
    const v = await complete(j);
    expect(v.brief_version_id).toBe(p.brief);
    await expect(review(v)).rejects.toMatchObject({ code: "40001" });
    expect(await review(v, "changes_requested")).toHaveProperty("id");
  });
  it("validates structured output and fails atomically without creating a partial version", async () => {
    const j = await start(await admit(await project()));
    const valid = documentFixture();
    expect(siteDocumentSchema.safeParse(valid).success).toBe(true);
    const invalid: unknown[] = [
      null,
      {},
      { ...valid, schema_version: 2 },
      { ...valid, script: "alert(1)" },
      { ...valid, pages: [] },
      {
        ...valid,
        identity: { ...valid.identity, business_name: "Other company" },
      },
    ];
    for (const section of [
      { ...valid.pages[0].sections[0], type: "script" },
      {
        ...valid.pages[0].sections[0],
        visual: { ...valid.pages[0].sections[0].visual, spacing: "100px" },
      },
      {
        ...valid.pages[0].sections[0],
        buttons: [
          { label: "Bad", href: "javascript:alert(1)", appearance: "primary" },
        ],
      },
      {
        ...valid.pages[0].sections[0],
        buttons: [{ label: "Bad", href: "#missing", appearance: "primary" }],
      },
    ])
      invalid.push({
        ...valid,
        pages: [{ ...valid.pages[0], sections: [section] }],
      });
    for (const doc of invalid)
      await expect(complete(j, doc)).rejects.toMatchObject({ code: "22023" });
    expect(
      await rows("select * from public.studio_site_versions"),
    ).toHaveLength(0);
    expect(
      (await rows("select status from public.studio_generation_jobs"))[0]
        .status,
    ).toBe("processing");
  });
  it("matches Zod Unicode code-point limits and the compact UTF-8 document byte budget", async () => {
    const j = await start(await admit(await project()));
    const doc = documentFixture();
    doc.pages[0].sections[0].heading = "😀".repeat(160);
    expect(siteDocumentSchema.safeParse(doc).success).toBe(true);
    await complete(j, doc);
    const p = await project();
    const other = await start(await admit(p));
    doc.pages[0].sections[0].heading = "😀".repeat(161);
    expect(siteDocumentSchema.safeParse(doc).success).toBe(false);
    await expect(complete(other, doc)).rejects.toMatchObject({ code: "22023" });
    const large = documentFixture();
    large.pages[0].sections = [
      large.pages[0].sections[0],
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `text-${i}`,
        type: "text" as const,
        heading: "Teste",
        visual: large.pages[0].sections[0].visual,
        paragraphs: Array(8).fill("á".repeat(1000)),
      })),
    ];
    expect(siteDocumentSchema.safeParse(large).success).toBe(false);
    await expect(complete(other, large)).rejects.toMatchObject({
      code: "22023",
    });
  });
  it("checks safe-link and structural boundaries against the unchanged Stage 1 contract", async () => {
    await db.exec("reset role");
    const documents: unknown[] = [documentFixture()];
    for (const href of [
      "https://example.com/path?q=one#anchor",
      "https://EXAMPLE.com:443/path",
      "mailto:one.two+tag@example.com",
      "tel:+5535999999999",
      "/#services",
      "//example.com",
      "https://user@example.com",
      "https://example.com:8443",
      "https://127.0.0.1",
      "https://metadata.internal",
      "https://example.com/%0a",
      "https://example.com/\u00a0",
      "mailto:one..two@example.com",
      "mailto:.one@example.com",
      "mailto:one@example.com?subject=Hello",
      "tel:+12",
      "javascript:alert(1)",
      "/missing",
      "#missing",
    ]) {
      const doc = documentFixture();
      const section = doc.pages[0].sections[0];
      if (section.type !== "hero") throw new Error("Expected hero fixture");
      section.buttons[0].href = href;
      documents.push(doc);
    }
    const change = (fn: (doc: SiteDocument) => void) => {
      const doc = documentFixture();
      fn(doc);
      documents.push(doc);
    };
    change((doc) => {
      doc.pages[0].description = "<script>";
    });
    change((doc) => {
      doc.pages[0].sections.push(doc.pages[0].sections[0]);
    });
    change((doc) => {
      doc.pages.push(structuredClone(doc.pages[0]));
    });
    change((doc) => {
      doc.pages[0].path = "/no-home";
    });
    change((doc) => {
      doc.pages[0].sections[1].id = "Bad Id";
    });
    change((doc) => {
      doc.identity.palette.primary = "blue";
    });
    change((doc) => {
      doc.pages[0].sections[0].heading = "\u00a0";
    });
    change((doc) => {
      const next = structuredClone(doc.pages[0]);
      next.id = "other";
      next.path = "/other";
      doc.pages.push(next);
      const section = doc.pages[0].sections[0];
      if (section.type === "hero") section.buttons[0].href = "/other#services";
    });
    for (const document of documents) {
      const result = await rows(
        "select public.studio_site_document_valid($1::jsonb) as valid",
        [JSON.stringify(document)],
      );
      expect(result[0].valid, JSON.stringify(document)).toBe(
        siteDocumentSchema.safeParse(document).success,
      );
    }
    await actor();
  });
  it("fails closed for noncanonical HTTPS representations without changing the Stage 1 contract", async () => {
    await db.exec("reset role");
    for (const href of [
      "https://éxample.com",
      "https://%65xample.com",
      "https://example.com:0443",
    ]) {
      const doc = documentFixture();
      const hero = doc.pages[0].sections[0];
      if (hero.type !== "hero") throw new Error("Expected hero fixture");
      hero.buttons[0].href = href;
      expect(siteDocumentSchema.safeParse(doc).success).toBe(true);
      expect(
        (
          await rows(
            "select public.studio_site_document_valid($1::jsonb) as valid",
            [JSON.stringify(doc)],
          )
        )[0].valid,
      ).toBe(false);
    }
    await actor();
  });
});

describe("site persistence: RLS and referential integrity", () => {
  it("restricts helper execution and grants only the intended RPCs, despite permissive defaults", async () => {
    for (const fn of [
      "studio_site_trim(text)",
      "studio_site_document_valid(jsonb)",
      "studio_generation_lock_job(uuid)",
    ]) {
      const result = await rows(
        "select has_function_privilege('authenticated',$1,'execute') as allowed",
        [`public.${fn}`],
      );
      expect(result[0].allowed).toBe(false);
    }
    for (const fn of [
      "studio_create_generation_job(uuid,uuid,text,uuid)",
      "studio_start_generation_job(uuid,uuid)",
      "studio_complete_generation_job(uuid,uuid,jsonb)",
      "studio_fail_generation_job(uuid,uuid,text)",
      "studio_review_site_version(uuid,text,text,text,uuid)",
    ]) {
      const result = await rows(
        "select has_function_privilege('authenticated',$1,'execute') as allowed,has_function_privilege('anon',$1,'execute') as anonymous",
        [`public.${fn}`],
      );
      expect(result[0]).toEqual({ allowed: true, anonymous: false });
    }
  });
  it("denies anonymous access and direct table writes, including owner/actor injection", async () => {
    const p = await project(),
      j = await admit(p);
    for (const table of [
      "studio_sites",
      "studio_generation_jobs",
      "studio_site_versions",
      "studio_site_reviews",
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
        "insert into public.studio_sites(owner_id,project_id) values ($1,$2)",
        [bob, p.id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role;set role anon");
    await expect(admit(p)).rejects.toMatchObject({ code: "42501" });
    await expect(start(j)).rejects.toMatchObject({ code: "42501" });
    for (const table of [
      "studio_sites",
      "studio_generation_jobs",
      "studio_site_versions",
      "studio_site_reviews",
    ])
      await expect(
        db.exec(`select * from public.${table}`),
      ).rejects.toMatchObject({ code: "42501" });
  });
  it("isolates every table and mutation between active users", async () => {
    const p = await project(),
      j = await start(await admit(p)),
      v = await complete(j);
    await review(v);
    await actor(bob);
    for (const table of [
      "studio_sites",
      "studio_generation_jobs",
      "studio_site_versions",
      "studio_site_reviews",
    ])
      expect(await rows(`select * from public.${table}`)).toHaveLength(0);
    for (const action of [
      () => admit(p),
      () => start(j),
      () => complete(j),
      () => fail(j),
      () => review(v),
    ])
      await expect(action()).rejects.toMatchObject({ code: "42501" });
    const own = await project();
    expect((await admit(own)).status).toBe("pending");
  });
  it("revokes reads and every write RPC after membership is disabled", async () => {
    const p = await project(),
      j = await start(await admit(p)),
      v = await complete(j);
    await review(v);
    await db.exec(
      `reset role;update public.app_members set active=false where user_id='${alice}'`,
    );
    await actor();
    for (const table of [
      "studio_sites",
      "studio_generation_jobs",
      "studio_site_versions",
      "studio_site_reviews",
    ])
      expect(await rows(`select * from public.${table}`)).toHaveLength(0);
    for (const action of [
      () => admit(p),
      () => start(j),
      () => complete(j),
      () => fail(j),
      () => review(v),
    ])
      await expect(action()).rejects.toMatchObject({ code: "42501" });
  });
  it("also blocks privileged accidental rewrites and invalid state transitions", async () => {
    const p = await project(),
      j = await start(await admit(p)),
      v = await complete(j);
    await review(v);
    await db.exec("reset role");
    for (const table of ["studio_site_versions", "studio_site_reviews"])
      for (const statement of [
        `update public.${table} set created_at=now()`,
        `delete from public.${table}`,
      ])
        await expect(db.exec(statement)).rejects.toMatchObject({
          code: "22023",
        });
    await expect(
      db.exec("update public.studio_generation_jobs set status='pending'"),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.exec(
        "update public.studio_generation_jobs set brief_hash=repeat('0',64)",
      ),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.exec("delete from public.studio_generation_jobs"),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("enforces same-owner/project/site references even for privileged inserts", async () => {
    const p = await project(),
      j = await start(await admit(p)),
      v = await complete(j);
    await actor(bob);
    const own = await project(),
      otherJob = await start(await admit(own)),
      otherVersion = await complete(otherJob);
    const unusedJob = await admit(own);
    await db.exec("reset role");
    await expect(
      rows("update public.studio_sites set head_version_id=$1 where id=$2", [
        otherVersion.id,
        v.site_id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      rows(
        "insert into public.studio_site_reviews(owner_id,project_id,site_id,version_id,document_hash,request_id,decision,actor_id) values ($1,$2,$3,$4,$5,$6,'approved',$1)",
        [
          alice,
          p.id,
          v.site_id,
          otherVersion.id,
          otherVersion.document_hash,
          crypto.randomUUID(),
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      rows(
        `insert into public.studio_site_versions(owner_id,project_id,site_id,job_id,brief_version_id,brief_hash,number,parent_id,document,document_hash,created_by)
      values ($1,$2,$3,$4,$5,$6,50,$7,$8::jsonb,$9,$1)`,
        [
          alice,
          p.id,
          v.site_id,
          unusedJob.id,
          p.brief,
          p.hash,
          otherVersion.id,
          JSON.stringify(documentFixture()),
          v.document_hash,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
