import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { ClientFactory } from "../../server/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  alice,
  bob,
  authBootstrap,
  briefFixture,
  previousMigrations,
  persistenceMigration,
} from "./site-persistence";

// A small PostgREST-shaped test bridge to REAL in-memory SQL/RLS. No HTTP,
// environment credentials, hosted Supabase, service role or external API.
type Result = { data: unknown; error: null | { code: string } };
class Operation implements PromiseLike<Result> {
  #work: () => Promise<Result>;
  constructor(work: () => Promise<Result>) {
    this.#work = work;
  }
  abortSignal(_signal: AbortSignal) {
    return this;
  }
  then<A = Result, B = never>(
    resolve?: ((value: Result) => A | PromiseLike<A>) | null,
    reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.#work().then(resolve, reject);
  }
}
const identifier = (v: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(v))
    throw new Error("Invalid test SQL identifier");
  return `"${v}"`;
};
const signatures: Record<string, string[]> = {
  studio_create_project: ["p_title", "p_mode", "p_lead_id", "p_request_id"],
  studio_save_brief: ["p_id", "p_expected_head", "p_fields", "p_request_id"],
  studio_approve_brief: ["p_id", "p_version_id", "p_content_hash"],
  studio_project_detail: ["p_id", "p_version_id"],
  studio_create_generation_job: [
    "p_project_id",
    "p_brief_version_id",
    "p_brief_hash",
    "p_request_id",
  ],
  studio_start_generation_job: ["p_job_id", "p_attempt_id"],
  studio_complete_generation_job: ["p_job_id", "p_attempt_id", "p_document"],
  studio_fail_generation_job: ["p_job_id", "p_attempt_id", "p_error_code"],
  studio_review_site_version: [
    "p_version_id",
    "p_document_hash",
    "p_decision",
    "p_notes",
    "p_request_id",
  ],
};
export class GenerationDatabase {
  db = new PGlite();
  missingTable: string | null = null;
  missingRPC: string | null = null;
  completionFailures = 0;
  completionCommitsBeforeLostReply = 0;
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  async initialize() {
    await this.db.exec(authBootstrap);
    for (const f of [...previousMigrations, persistenceMigration])
      await this.db.exec(
        await readFile(
          new URL(`../../supabase/migrations/${f}`, import.meta.url),
          "utf8",
        ),
      );
  }
  async reset() {
    this.calls = [];
    this.missingTable = null;
    this.missingRPC = null;
    this.completionFailures = 0;
    this.completionCommitsBeforeLostReply = 0;
    await this.db
      .exec(`truncate public.studio_site_reviews,public.studio_site_versions,public.studio_generation_jobs,public.studio_sites,public.studio_brief_approvals,public.studio_brief_versions,public.studio_projects,public.discovery_origins,public.discovery_results,public.lead_events,public.leads,public.app_members,auth.users cascade;
      insert into auth.users values ('${alice}'),('${bob}');insert into public.app_members values ('${alice}',true),('${bob}',true);`);
  }
  async query(
    actor: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<Result> {
    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.exec(
          `set local role authenticated;set local "request.jwt.claim.sub"='${actor}';`,
        );
        return tx.query(sql, values);
      });
      // PostgREST serializes timestamptz as JSON strings; PGlite SELECT returns
      // native Date objects. Preserve the real HTTP boundary in this bridge.
      return { data: JSON.parse(JSON.stringify(result.rows)), error: null };
    } catch (e) {
      return { data: null, error: { code: (e as { code: string }).code } };
    }
  }
  client(actor = alice) {
    const self = this;
    return {
      from(table: string) {
        let columns = "id",
          single = false,
          limit: number | undefined,
          offset = 0;
        const conditions: string[] = [],
          values: unknown[] = [],
          orders: string[] = [];
        const op = new Operation(async () => {
          if (self.missingTable === table)
            return { data: null, error: { code: "PGRST205" } };
          const result = await self.query(
            actor,
            `select ${columns} from public.${identifier(table)}${conditions.length ? ` where ${conditions.join(" and ")}` : ""}${orders.length ? ` order by ${orders.join(",")}` : ""}${limit !== undefined ? ` limit ${limit} offset ${offset}` : ""}`,
            values,
          );
          if (result.error) return result;
          const rows = result.data as unknown[];
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        });
        const builder = Object.assign(op, {
          select(value: string) {
            columns = value.split(",").map(identifier).join(",");
            return builder;
          },
          eq(column: string, value: unknown) {
            values.push(value);
            conditions.push(`${identifier(column)}=$${values.length}`);
            return builder;
          },
          in(column: string, value: unknown[]) {
            values.push(value);
            conditions.push(
              `${identifier(column)}=any($${values.length}::uuid[])`,
            );
            return builder;
          },
          order(column: string, options: { ascending: boolean }) {
            orders.push(
              `${identifier(column)} ${options.ascending ? "asc" : "desc"}`,
            );
            return builder;
          },
          range(from: number, to: number) {
            offset = from;
            limit = to - from + 1;
            return builder;
          },
          limit(value: number) {
            limit = value;
            return builder;
          },
          maybeSingle() {
            single = true;
            return builder;
          },
        });
        return builder;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        return new Operation(async () => {
          self.calls.push({ fn, args });
          if (self.missingRPC === fn)
            return { data: null, error: { code: "PGRST202" } };
          if (
            fn === "studio_complete_generation_job" &&
            self.completionFailures > 0
          ) {
            self.completionFailures--;
            return { data: null, error: { code: "NETWORK_TEST_ONLY" } };
          }
          const signature = signatures[fn];
          if (!signature) throw new Error("Unknown test RPC");
          const params = signature.map((k) =>
            typeof args[k] === "object" && args[k] !== null
              ? JSON.stringify(args[k])
              : args[k],
          );
          const result = await self.query(
            actor,
            `select to_jsonb(public.${identifier(fn)}(${signature.map((k, i) => `$${i + 1}${["p_fields", "p_document"].includes(k) ? "::jsonb" : ""}`).join(",")})) as result`,
            params,
          );
          if (
            fn === "studio_complete_generation_job" &&
            !result.error &&
            self.completionCommitsBeforeLostReply > 0
          ) {
            self.completionCommitsBeforeLostReply--;
            return { data: null, error: { code: "NETWORK_TEST_ONLY" } };
          }
          return {
            data: result.error
              ? null
              : (result.data as { result: unknown }[])[0].result,
            error: result.error,
          };
        });
      },
    };
  }
  factory: ClientFactory = (_env, token) => {
    const actor = token === "token-bob" ? bob : alice;
    return {
      ...this.client(actor),
      auth: {
        getUser: async (access: string) => ({
          data: { user: { id: access === "token-bob" ? bob : alice } },
          error: null,
        }),
      },
    } as unknown as SupabaseClient;
  };
  async project(actor = alice, approved = true) {
    const client = this.client(actor);
    const initial = await client.rpc("studio_create_project", {
      p_title: "Projeto sintético controlado",
      p_mode: "demo",
      p_lead_id: null,
      p_request_id: crypto.randomUUID(),
    });
    const p = initial.data as { project_id: string; version_id: string };
    const saved = await client.rpc("studio_save_brief", {
      p_id: p.project_id,
      p_expected_head: p.version_id,
      p_fields: briefFixture(),
      p_request_id: crypto.randomUUID(),
    });
    const version = (saved.data as { version_id: string }).version_id;
    const detail = await client.rpc("studio_project_detail", {
      p_id: p.project_id,
      p_version_id: null,
    });
    const hash = (detail.data as { version: { content_hash: string } }).version
      .content_hash;
    if (approved)
      await client.rpc("studio_approve_brief", {
        p_id: p.project_id,
        p_version_id: version,
        p_content_hash: hash,
      });
    return { id: p.project_id, brief: version, hash };
  }
}
