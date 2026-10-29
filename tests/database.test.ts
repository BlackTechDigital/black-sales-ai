import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real PostgreSQL engine in WASM, in memory only. Never reads DATABASE_URL or contacts Supabase.
const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const fixture = {
  id: "legacy-test-id",
  company: "Empresa de teste",
  city: "Cidade de teste",
  sector: "Serviços",
  contact: "",
  site: "none",
  status: "Novo",
  notes: "Fixture exclusiva de teste.",
};
async function actor(id: string) {
  await db.exec(
    `reset role; set role authenticated; set "request.jwt.claim.sub" = '${id}';`,
  );
}
async function rows(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}
async function importRecords(records: unknown[], commit = true) {
  const result = await rows(
    "select public.import_leads_v1($1::jsonb,$2::boolean) as result",
    [JSON.stringify(records), commit],
  );
  return result[0].result as {
    total: number;
    created: number;
    duplicates: number;
    conflicts: number;
    conflict_rows: number[];
  };
}
async function create() {
  return (
    await rows(
      "insert into public.leads(company,city,sector) values ('Empresa de teste','Cidade de teste','Serviços') returning *",
    )
  )[0];
}
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610290001_foundation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
beforeEach(async () => {
  await db.exec(`reset role; truncate public.lead_events, public.leads, public.app_members, auth.users cascade;
    insert into auth.users values ('${alice}'),('${bob}');
    insert into public.app_members values ('${alice}',true),('${bob}',true);`);
  await actor(alice);
});
afterAll(async () => {
  await db.close();
});

describe("PostgreSQL RLS and audit", () => {
  it("isolates reads, updates, and history between users", async () => {
    const lead = await create();
    await actor(bob);
    expect(await rows("select * from public.leads")).toHaveLength(0);
    expect(await rows("select * from public.lead_events")).toHaveLength(0);
    expect(
      await rows("update public.leads set notes=$1 where id=$2 returning id", [
        "unauthorized",
        lead.id,
      ]),
    ).toHaveLength(0);
    await expect(
      db.query(
        "insert into public.leads(owner_id,company,city) values ($1,$2,$3)",
        [alice, "Teste", "Cidade"],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await actor(alice);
    expect((await rows("select notes from public.leads"))[0].notes).toBe("");
  });
  it("denies anonymous access and membership self-activation", async () => {
    await expect(
      db.exec(
        `insert into public.app_members values ('33333333-3333-4333-8333-333333333333',true)`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role; set role anon");
    await expect(db.exec("select * from public.leads")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      db.query("select public.import_leads_v1($1::jsonb,true)", [
        JSON.stringify([fixture]),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("revoked members lose access to data and mutations", async () => {
    await create();
    await db.exec(
      `reset role; update public.app_members set active=false where user_id='${alice}'`,
    );
    await actor(alice);
    expect(await rows("select * from public.leads")).toHaveLength(0);
    await expect(create()).rejects.toMatchObject({ code: "42501" });
    await expect(importRecords([fixture])).rejects.toMatchObject({
      code: "42501",
    });
  });
  it("defaults to unknown presence, captures actor and immutable history", async () => {
    const lead = await create();
    expect(lead.site).toBe("unknown");
    const events = await rows("select * from public.lead_events");
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe(alice);
    expect(events[0].action).toBe("created");
    await expect(
      db.exec("update public.lead_events set action='updated'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.exec("delete from public.lead_events"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(db.exec("delete from public.leads")).rejects.toMatchObject({
      code: "42501",
    });
  });
  it("updates atomically, rejects stale edits, and retains previous values", async () => {
    const lead = await create();
    const payload = {
      ...fixture,
      company: "Empresa atualizada",
      site: "unknown",
    };
    await db.query("select public.update_lead($1,1,$2::jsonb,null)", [
      lead.id,
      JSON.stringify(payload),
    ]);
    await expect(
      db.query("select public.update_lead($1,1,$2::jsonb,null)", [
        lead.id,
        JSON.stringify(fixture),
      ]),
    ).rejects.toMatchObject({ code: "40001" });
    const updated = (await rows("select * from public.leads"))[0];
    expect(updated.company).toBe("Empresa atualizada");
    expect(updated.version).toBe(2);
    const events = await rows(
      "select * from public.lead_events where action='updated'",
    );
    expect(events[0].before_data).toMatchObject({
      company: "Empresa de teste",
    });
    expect(events[0].after_data).toMatchObject({
      company: "Empresa atualizada",
    });
  });
  it("archives and restores without deleting or reimporting the company", async () => {
    await importRecords([fixture]);
    const lead = (await rows("select * from public.leads"))[0];
    await db.query("select public.update_lead($1,1,$2::jsonb,true)", [
      lead.id,
      JSON.stringify(fixture),
    ]);
    expect(
      (await rows("select deleted_at from public.leads"))[0].deleted_at,
    ).not.toBeNull();
    expect((await importRecords([fixture])).created).toBe(0);
    await db.query("select public.update_lead($1,2,$2::jsonb,false)", [
      lead.id,
      JSON.stringify(fixture),
    ]);
    expect(
      (await rows("select deleted_at from public.leads"))[0].deleted_at,
    ).toBeNull();
    expect(
      (await rows("select action from public.lead_events")).map(
        (e) => e.action,
      ),
    ).toEqual(expect.arrayContaining(["imported", "archived", "restored"]));
  });
  it("prevents ownership or provenance changes", async () => {
    await importRecords([fixture]);
    await expect(
      db.query("update public.leads set owner_id=$1", [bob]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      db.exec("update public.leads set legacy_snapshot='{}'::jsonb"),
    ).rejects.toMatchObject({ code: "22023" });
  });
});
describe("atomic, non-destructive legacy import", () => {
  it("previews without writing leads or audit events", async () => {
    expect(await importRecords([fixture, fixture], false)).toMatchObject({
      total: 2,
      created: 1,
      duplicates: 1,
      conflicts: 0,
    });
    expect(await rows("select * from public.leads")).toHaveLength(0);
    expect(await rows("select * from public.lead_events")).toHaveLength(0);
  });
  it("repeated imports are idempotent and preserve the exact original object", async () => {
    const original = {
      ...fixture,
      company: "  Empresa de teste  ",
      extra_information: { source: "test" },
    };
    expect((await importRecords([original])).created).toBe(1);
    expect((await importRecords([original])).duplicates).toBe(1);
    const leads = await rows("select * from public.leads");
    expect(leads).toHaveLength(1);
    expect(leads[0].legacy_snapshot).toEqual(original);
    expect(leads[0].source).toBe("v1_import");
    expect(await rows("select * from public.lead_events")).toHaveLength(1);
  });
  it("handles duplicate IDs and equivalent identity with a different ID", async () => {
    const result = await importRecords([
      fixture,
      fixture,
      { ...fixture, id: "other-id" },
    ]);
    expect(result).toMatchObject({ created: 1, duplicates: 2, conflicts: 0 });
    expect(await rows("select * from public.leads")).toHaveLength(1);
  });
  it("never overwrites conflicting notes or company details", async () => {
    await importRecords([fixture]);
    const result = await importRecords([
      { ...fixture, notes: "Changed notes" },
      { ...fixture, id: "another-id", notes: "Changed notes" },
    ]);
    expect(result).toMatchObject({
      created: 0,
      conflicts: 2,
      conflict_rows: [1, 2],
    });
    expect((await rows("select notes from public.leads"))[0].notes).toBe(
      fixture.notes,
    );
    expect(await rows("select * from public.lead_events")).toHaveLength(1);
  });
  it("rejects an invalid batch and rolls back earlier records", async () => {
    await expect(
      importRecords([
        fixture,
        { ...fixture, id: "invalid", status: "inventado" },
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await rows("select * from public.leads")).toHaveLength(0);
    expect(await rows("select * from public.lead_events")).toHaveLength(0);
  });
  it("accepts more than 1,000 records without silently truncating", async () => {
    const fixtures = Array.from({ length: 1001 }, (_, i) => ({
      ...fixture,
      id: `fixture-${i}`,
      company: `Empresa de teste ${i}`,
    }));
    expect((await importRecords(fixtures)).created).toBe(1001);
    expect(
      (await rows("select count(*)::int as total from public.leads"))[0].total,
    ).toBe(1001);
  });
  it("enforces uniqueness on simultaneous inserts at the database boundary", async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "23505" });
    expect(await rows("select * from public.leads")).toHaveLength(1);
  });
});

it("matches a manual lead UUID on reimport even after its identity changed", async () => {
  const lead = await create();
  await db.query("update public.leads set company=$1 where id=$2", [
    "Empresa atualizada",
    lead.id,
  ]);
  const result = await importRecords([{ ...fixture, id: lead.id, notes: "" }]);
  expect(result).toMatchObject({ created: 0, conflicts: 1 });
  expect(await rows("select * from public.leads")).toHaveLength(1);
  expect((await rows("select company from public.leads"))[0].company).toBe(
    "Empresa atualizada",
  );
});
