import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
const db = new PGlite();
const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222";
const record = {
  company: "Empresa sintética de teste",
  city: "Passos",
  state: "MG",
  sector: "Serviços",
  contact: "",
  website: "https://company.example.test",
};
const source = {
  name: "Fonte sintética de testes",
  url: "https://source.example.test",
  collected_at: "2026-01-01T12:00:00Z",
};
async function rows(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}
async function actor(id = alice) {
  await db.exec(
    `reset role; set role authenticated; set "request.jwt.claim.sub"='${id}';`,
  );
}
async function importRecords(
  records: unknown[] = [record],
  commit = true,
  origin = source,
) {
  return (
    await rows(
      "select public.import_discovery_results($1::jsonb,$2::jsonb,$3) as result",
      [JSON.stringify(origin), JSON.stringify(records), commit],
    )
  )[0].result as { created: number; duplicates: number; committed: boolean };
}
async function promote(id: unknown) {
  return (
    await rows("select public.promote_discovery_result($1) as result", [id])
  )[0].result as { outcome: string; lead_id: string; archived: boolean };
}
async function resultId() {
  return (await rows("select id from public.discovery_results"))[0].id;
}
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
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
  // Start with existing data before the additive migration; it must survive intact.
  await db.exec(
    `insert into auth.users values ('${alice}'); insert into public.app_members values ('${alice}',true);`,
  );
  await actor();
  await db.exec(
    "insert into public.leads(company,city,notes) values ('Registro anterior de teste','Passos','Preservar integralmente')",
  );
  await db.exec("reset role");
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610290002_discovery.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await actor();
  expect(
    (await rows("select company,notes,version from public.leads"))[0],
  ).toEqual({
    company: "Registro anterior de teste",
    notes: "Preservar integralmente",
    version: 1,
  });
  expect(await rows("select * from public.lead_events")).toHaveLength(1);
});
beforeEach(async () => {
  await db.exec(`reset role; truncate public.discovery_origins,public.discovery_results,public.lead_events,public.leads,public.app_members,auth.users cascade;
    insert into auth.users values ('${alice}'),('${bob}'); insert into public.app_members values ('${alice}',true),('${bob}',true);`);
  await actor();
});
afterAll(async () => {
  await db.close();
});
describe("discovery persistence and permissions in PostgreSQL", () => {
  it("previews without writing, persists source and collection time, and reimports without overwriting", async () => {
    expect(await importRecords([record], false)).toMatchObject({
      created: 1,
      committed: false,
    });
    expect(await rows("select * from public.discovery_results")).toHaveLength(
      0,
    );
    expect(await importRecords()).toMatchObject({ created: 1, duplicates: 0 });
    expect(
      await importRecords([{ ...record, contact: "different" }], true, {
        ...source,
        name: "Another source",
      }),
    ).toMatchObject({ created: 0, duplicates: 1 });
    const saved = (await rows("select * from public.discovery_results"))[0];
    expect(saved).toMatchObject({
      company: record.company,
      source_name: source.name,
      source_url: source.url,
      contact: "",
      source_kind: "manual",
    });
    expect(new Date(String(saved.collected_at)).toISOString()).toBe(
      source.collected_at.replace("Z", ".000Z"),
    );
    expect(await rows("select * from public.leads")).toHaveLength(0);
  });
  it("deduplicates within a file and across imports using accents, whitespace, case and UF", async () => {
    expect(
      await importRecords([
        record,
        { ...record, company: "  EMPRESA   SINTETICA DE TESTE  " },
      ]),
    ).toMatchObject({ created: 1, duplicates: 1 });
    expect(await importRecords([{ ...record, state: "SP" }])).toMatchObject({
      created: 1,
    });
  });
  it("rolls back the entire import when any row is invalid, including direct RPC calls", async () => {
    for (const patch of [
      { state: "ZZ" },
      { website: "javascript:alert(1)" },
      { company: "bad\ncompany" },
      { owner_id: bob },
      { site: "good" },
      { sector: "" },
    ]) {
      await expect(
        importRecords([record, { ...record, ...patch }]),
      ).rejects.toMatchObject({ code: "22023" });
      expect(await rows("select * from public.discovery_results")).toHaveLength(
        0,
      );
    }
    await expect(
      importRecords([record], true, { ...source, collected_at: "infinity" }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      importRecords([record], true, {
        ...source,
        collected_at: "2999-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("keeps source records immutable and denies hard deletion", async () => {
    await importRecords();
    for (const sql of [
      "update public.discovery_results set source_name='changed'",
      "delete from public.discovery_results",
    ])
      await expect(db.exec(sql)).rejects.toMatchObject({ code: "42501" });
  });
  it("isolates results, origins, promotion and matching between users", async () => {
    await importRecords();
    const id = await resultId();
    await promote(id);
    await actor(bob);
    expect(await rows("select * from public.discovery_results")).toHaveLength(
      0,
    );
    expect(await rows("select * from public.discovery_origins")).toHaveLength(
      0,
    );
    expect(
      (
        await rows("select public.discovery_pipeline_match($1) as result", [id])
      )[0].result,
    ).toBeNull();
    await expect(promote(id)).rejects.toMatchObject({ code: "42501" });
    // Another user's company must not suppress the same user's own opportunity.
    await importRecords();
    expect((await promote(await resultId())).outcome).toBe("added");
  });
  it("rejects anonymous and revoked access, even when calling SQL directly", async () => {
    await importRecords();
    const id = await resultId();
    await db.exec(
      `reset role; update public.app_members set active=false where user_id='${alice}'`,
    );
    await actor();
    expect(await rows("select * from public.discovery_results")).toHaveLength(
      0,
    );
    await expect(importRecords()).rejects.toMatchObject({ code: "42501" });
    await expect(promote(id)).rejects.toMatchObject({ code: "42501" });
    await expect(
      rows("select * from public.list_discovery_results() "),
    ).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role; set role anon");
    await expect(
      rows("select * from public.discovery_results"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(promote(id)).rejects.toMatchObject({ code: "42501" });
  });
  it("creates an unanalysed new lead, durable origin and audit only after promotion", async () => {
    await importRecords();
    const id = await resultId();
    const result = await promote(id);
    expect(result.outcome).toBe("added");
    const lead = (await rows("select * from public.leads"))[0];
    expect(lead).toMatchObject({
      company: record.company,
      city: "Passos, MG",
      site: "unknown",
      status: "Novo",
      notes: "",
      owner_id: alice,
    });
    expect(
      (await rows("select * from public.discovery_origins"))[0],
    ).toMatchObject({
      lead_id: result.lead_id,
      discovery_result_id: id,
      owner_id: alice,
    });
    expect(
      (await rows("select action from public.lead_events"))[0].action,
    ).toBe("created");
    expect((await promote(id)).outcome).toBe("already_added");
    expect(await rows("select * from public.leads")).toHaveLength(1);
    await expect(
      db.exec("update public.discovery_origins set added_at=now() "),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.exec("delete from public.discovery_origins"),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it.each(["Passos", "Passos, MG", "Passos - MG", "Passos/MG", "Passos (MG)"])(
    "flags existing or v1 leads in %s, despite different contact or segment",
    async (city) => {
      await rows("select public.import_leads_v1($1::jsonb,true)", [
        JSON.stringify([
          {
            id: "v1-synthetic",
            company: record.company.toUpperCase(),
            city,
            sector: "Outro",
            contact: "another contact",
            status: "Novo",
            site: "good",
          },
        ]),
      ]);
      await importRecords();
      const result = await promote(await resultId());
      expect(result.outcome).toBe("duplicate");
      expect(await rows("select * from public.leads")).toHaveLength(1);
      expect(await rows("select * from public.discovery_origins")).toHaveLength(
        0,
      );
    },
  );
  it("keeps original links after edits/archival and identifies archived potential duplicates", async () => {
    await importRecords();
    const id = await resultId();
    await promote(id);
    await db.exec(
      "update public.leads set company='Nome alterado de teste',city='Outra cidade',deleted_at=now()",
    );
    expect(await promote(id)).toMatchObject({
      outcome: "already_added",
      archived: true,
    });
    await importRecords([{ ...record, company: "Outra sintética de teste" }]);
    await rows(
      "insert into public.leads(company,city) values ($1,'Passos, MG')",
      ["Outra sintética de teste"],
    );
    await db.exec("update public.leads set deleted_at=now()");
    const next = (
      await rows("select id from public.discovery_results where company=$1", [
        "Outra sintética de teste",
      ])
    )[0].id;
    expect(await promote(next)).toMatchObject({
      outcome: "duplicate",
      archived: true,
    });
  });
  it("distinguishes explicitly different states and rechecks after a preview", async () => {
    await importRecords();
    const id = await resultId();
    await rows(
      "insert into public.leads(company,city) values ($1,'Passos, SP')",
      [record.company],
    );
    expect((await promote(id)).outcome).toBe("added");
    await importRecords([{ ...record, company: "Concorrência de teste" }]);
    const next = (
      await rows("select id from public.discovery_results where company=$1", [
        "Concorrência de teste",
      ])
    )[0].id;
    await rows("select * from public.list_discovery_results()");
    await rows(
      "insert into public.leads(company,city) values ($1,'Passos, MG')",
      ["Concorrência de teste"],
    );
    expect((await promote(next)).outcome).toBe("duplicate");
  });
  it("filters by city, state and literal segment, with stable pagination", async () => {
    await importRecords(
      Array.from({ length: 105 }, (_, i) => ({
        ...record,
        company: `Empresa sintética ${i}`,
      })),
    );
    expect(
      await rows(
        "select * from public.list_discovery_results('passos','MG','servicos',0)",
      ),
    ).toHaveLength(100);
    expect(
      await rows(
        "select * from public.list_discovery_results('Passos','MG','',100)",
      ),
    ).toHaveLength(5);
    expect(
      await rows(
        "select * from public.list_discovery_results('Passos','SP','',0)",
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        "select * from public.list_discovery_results('Outra cidade','MG','',0)",
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        "select * from public.list_discovery_results('Passos','MG','%',0)",
      ),
    ).toHaveLength(0);
  });
  it("prevents cross-owner origin forgery and table ownership injection", async () => {
    await importRecords();
    const id = await resultId();
    const first = await promote(id);
    await actor(bob);
    await importRecords([{ ...record, company: "Outro usuário de teste" }]);
    const other = await resultId();
    await expect(
      rows(
        "insert into public.discovery_origins(lead_id,discovery_result_id) values ($1,$2)",
        [first.lead_id, other],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rows(
        "insert into public.discovery_results(owner_id,company,city,state,sector,source_name,collected_at) values ($1,'Teste','Passos','MG','Teste','Fonte',now())",
        [alice],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
