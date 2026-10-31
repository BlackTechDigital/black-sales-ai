import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "./types";
import { getSiteGenerationEligibility } from "./studio-site-eligibility";
import { generateStudioSite } from "./studio-ai/generate";
import { readSiteAIConfig } from "./studio-ai/config";
import { SiteAIError, type SiteAIErrorCode } from "./studio-ai/errors";
import { siteGenerationRequestSchema } from "../shared/studio-sites";
import {
  generationJobSchema,
  siteVersionSummarySchema,
  generationFailureSchema,
  requestSiteGenerationSchema,
  type GenerationJob,
  type GenerationFailure,
  type GenerationAvailability,
} from "../shared/studio-generation";

type Ctx = Context<ApiEnv>;
export interface GenerationDependencies {
  // Trusted server/test injection, never request data or an env switch.
  adapter?: Parameters<typeof generateStudioSite>[3];
  schedule?(task: Promise<void>): void;
}
const messages = {
  migration_missing:
    "A persistência de sites ainda não está disponível. Um administrador deve revisar a migração da Etapa 2; nenhuma migração será aplicada automaticamente.",
  read_unavailable:
    "Não foi possível consultar a geração. Atualize antes de tentar novamente.",
  job_unavailable: "Projeto ou trabalho indisponível para esta conta.",
  brief_changed:
    "O briefing mudou. Atualize e revise a versão aprovada antes de continuar.",
  invalid_request: "Confira projeto, versão, hash e chave da solicitação.",
  active_job:
    "Já existe um trabalho ativo neste projeto. Acompanhe-o antes de solicitar outro.",
  execution_unavailable:
    "O processamento em segundo plano não está disponível neste ambiente.",
} as const;
export class StudioGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "StudioGenerationError";
  }
}
const error = (
  code: keyof typeof messages,
  status: 400 | 403 | 404 | 409 | 429 | 503 = 503,
) => new StudioGenerationError(code, status, messages[code]);
function database(errorValue: { code?: string } | null) {
  if (!errorValue) return;
  if (
    ["42P01", "42883", "PGRST202", "PGRST205"].includes(errorValue.code ?? "")
  )
    throw error("migration_missing");
  if (errorValue.code === "42501") throw error("job_unavailable", 403);
  if (["40001", "23505"].includes(errorValue.code ?? ""))
    throw error("active_job", 409);
  if (["22023", "23514", "22P02"].includes(errorValue.code ?? ""))
    throw error("invalid_request", 400);
  throw error("read_unavailable");
}
const jobColumns =
  "id,project_id,request_id,brief_version_id,brief_hash,status,error_code,created_at,started_at,finished_at";
const versionColumns =
  "id,job_id,number,brief_version_id,brief_hash,document_hash,created_at";
const internalJobSchema = generationJobSchema
  .omit({ stalled: true })
  .extend({ attempt_id: z.uuid().nullable() })
  .strip();
type InternalJob = z.infer<typeof internalJobSchema>;
const rpcJobSchema = internalJobSchema; // Strip every private/provenance field returned by RPCs.
const user = (c: Ctx) => c.get("user").id;
const scoped = (c: Ctx, table: string, columns: string, project: string) =>
  c
    .get("db")
    .from(table)
    .select(columns)
    .eq("owner_id", user(c))
    .eq("project_id", project);
async function ownProject(c: Ctx, id: string) {
  const r = await c
    .get("db")
    .from("studio_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user(c))
    .maybeSingle();
  database(r.error);
  if (!r.data) throw error("job_unavailable", 404);
}
async function getJob(
  c: Ctx,
  project: string,
  id: string,
): Promise<InternalJob> {
  const r = await scoped(
    c,
    "studio_generation_jobs",
    `${jobColumns},attempt_id`,
    project,
  )
    .eq("id", id)
    .maybeSingle();
  database(r.error);
  if (!r.data) throw error("job_unavailable", 404);
  const parsed = internalJobSchema.safeParse(r.data);
  if (!parsed.success) throw error("read_unavailable");
  return parsed.data;
}
function summary(job: InternalJob): GenerationJob {
  const { attempt_id: _, ...safe } = job;
  const active = job.status === "pending" || job.status === "processing";
  return generationJobSchema.parse({
    ...safe,
    stalled:
      active &&
      Date.now() - Date.parse(job.started_at ?? job.created_at) > 120000,
  });
}
async function responseJob(c: Ctx, project: string, job: InternalJob) {
  const r = await scoped(c, "studio_site_versions", versionColumns, project)
    .eq("job_id", job.id)
    .maybeSingle();
  database(r.error);
  return {
    job: summary(job),
    version: r.data ? siteVersionSummarySchema.parse(r.data) : null,
  };
}
function runtimeAvailability(c: Ctx): GenerationAvailability {
  try {
    const config = readSiteAIConfig(c.env);
    if (!c.env.STUDIO_AI_USAGE_GUARD)
      return {
        available: false,
        code: "guard_unavailable",
        message:
          "O coordenador de cotas ainda não está configurado. Nenhuma chamada será enviada.",
      };
    if (Object.values(config.policy).some((n) => n === 0))
      return {
        available: false,
        code: "quota_exceeded",
        message: "As cotas de geração estão desativadas no servidor.",
      };
    return {
      available: true,
      code: "ready",
      message:
        "Geração disponível. O resultado continuará exigindo revisão humana.",
    };
  } catch (e) {
    const safe =
      e instanceof SiteAIError ? e : new SiteAIError("configuration_invalid");
    return {
      available: false,
      code: safe.code === "disabled" ? "disabled" : "configuration_invalid",
      message: safe.message,
    };
  }
}
async function persistenceAvailable(c: Ctx, project: string) {
  for (const table of [
    "studio_generation_jobs",
    "studio_sites",
    "studio_site_versions",
    "studio_site_reviews",
  ]) {
    const r = await scoped(c, table, "id", project).limit(1);
    database(r.error);
  }
}
function scheduler(c: Ctx, deps: GenerationDependencies) {
  if (deps.schedule) return deps.schedule;
  try {
    const ctx = c.executionCtx;
    if (typeof ctx.waitUntil === "function")
      return (p: Promise<void>) => ctx.waitUntil(p);
  } catch {
    /* Not a Worker execution context. */
  }
  throw error("execution_unavailable");
}
function failureCode(code: SiteAIErrorCode): GenerationFailure {
  if (code === "timeout") return "timeout";
  if (["brief_changed", "brief_unavailable"].includes(code))
    return "brief_changed";
  if (
    ["provider_invalid_response", "output_limit", "input_limit"].includes(code)
  )
    return "invalid_response";
  if (code === "cancelled") return "cancelled";
  if (
    [
      "provider_auth",
      "provider_rate_limited",
      "provider_unavailable",
      "quota_exceeded",
    ].includes(code)
  )
    return "provider_unavailable";
  return "internal_error";
}

// waitUntil is bounded by the platform. Keep generation within 20s and use a
// separate finalization window. This is not a durable queue or automatic retry.
export async function processSiteGeneration(
  c: Ctx,
  job: InternalJob,
  deps: GenerationDependencies,
  dispatchSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController(),
    end = Date.now() + 28000;
  const stop = () => controller.abort();
  dispatchSignal?.addEventListener("abort", stop, { once: true });
  if (dispatchSignal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (fn: string, args: Record<string, unknown>) =>
    c
      .get("db")
      .rpc(fn, args)
      .abortSignal(
        AbortSignal.timeout(Math.max(1, Math.min(3000, end - Date.now()))),
      );
  async function fail(code: GenerationFailure) {
    try {
      await write("studio_fail_generation_job", {
        p_job_id: job.id,
        p_attempt_id: job.attempt_id,
        p_error_code: code,
      });
    } catch {
      /* No raw errors or secrets in logs. Polling reconciles persisted state. */
    }
  }
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SiteAIError("timeout"));
        controller.abort();
      }, 20000);
    });
    const result = await Promise.race([
      timeout,
      generateStudioSite(c, { job_id: job.id }, c.env, {
        ...deps.adapter,
        signal: controller.signal,
      }),
    ]);
    clearTimeout(timer);
    if (!result.ok) {
      await fail(failureCode(result.code));
      return;
    }
    // Only persistence may be repeated, with the exact same immutable payload.
    // Never repeat a model call after an ambiguous network response.
    for (let n = 0; n < 2 && Date.now() < end; n++) {
      let r;
      try {
        r = await write("studio_complete_generation_job", {
          p_job_id: job.id,
          p_attempt_id: job.attempt_id,
          p_document: result.document,
        });
      } catch {
        continue;
      }
      if (!r.error) return;
      if (["22023", "23514"].includes(r.error.code ?? "")) {
        await fail("invalid_response");
        return;
      }
      if (["40001", "42501"].includes(r.error.code ?? "")) return;
    }
    // An unconfirmed completion may already have committed. Do not overwrite
    // it as failed or call the model again; status reads are authoritative.
  } catch (e) {
    await fail(
      e instanceof SiteAIError && e.code === "timeout"
        ? "timeout"
        : "internal_error",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    dispatchSignal?.removeEventListener("abort", stop);
  }
}

export function registerStudioGenerationRoutes(
  app: Hono<ApiEnv>,
  deps: { readJson(c: Ctx): Promise<unknown> },
  options: GenerationDependencies = {},
) {
  // Authentication is installed by registerStudioRoutes on /api/studio/*.
  const base = "/api/studio/projects/:id/site-generation";
  const project = (c: Ctx) => z.uuid().parse(c.req.param("id"));
  app.get(`${base}/eligibility`, async (c) => {
    const id = project(c);
    await ownProject(c, id);
    const input = siteGenerationRequestSchema.parse({
      project_id: id,
      brief_version_id: c.req.query("brief_version_id"),
      brief_hash: c.req.query("brief_hash"),
    });
    const e = await getSiteGenerationEligibility(c, input);
    let availability = runtimeAvailability(c);
    try {
      await persistenceAvailable(c, id);
      scheduler(c, options);
    } catch (f) {
      if (
        f instanceof StudioGenerationError &&
        [
          "migration_missing",
          "read_unavailable",
          "execution_unavailable",
        ].includes(f.code)
      )
        availability = {
          available: false,
          code: f.code as GenerationAvailability["code"],
          message: f.message,
        };
      else throw f;
    }
    return c.json({
      eligible: e.eligible,
      code: e.eligible ? "eligible" : e.code,
      message: e.eligible
        ? "Briefing aprovado e com conteúdo público essencial autorizado."
        : e.message,
      missing_fields: e.eligible ? [] : (e.missing_fields ?? []),
      availability,
    });
  });
  app.get(`${base}/history`, async (c) => {
    const id = project(c);
    await ownProject(c, id);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(c.req.query("offset") ?? 0);
    const jobs = await scoped(
      c,
      "studio_generation_jobs",
      `${jobColumns},attempt_id`,
      id,
    )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + 20);
    database(jobs.error);
    const selected = (jobs.data ?? [])
      .slice(0, 20)
      .map((v) => rpcJobSchema.parse(v));
    const versions = selected.length
      ? await scoped(c, "studio_site_versions", versionColumns, id).in(
          "job_id",
          selected.map((j) => j.id),
        )
      : { data: [], error: null };
    database(versions.error);
    return c.json({
      jobs: selected.map(summary),
      versions: (versions.data ?? []).map((v) =>
        siteVersionSummarySchema.parse(v),
      ),
      has_more: (jobs.data ?? []).length > 20,
    });
  });
  app.get(`${base}/jobs/:jobId`, async (c) => {
    const id = project(c);
    await ownProject(c, id);
    return c.json(
      await responseJob(
        c,
        id,
        await getJob(c, id, z.uuid().parse(c.req.param("jobId"))),
      ),
    );
  });
  app.post(`${base}/jobs`, async (c) => {
    const id = project(c),
      input = requestSiteGenerationSchema.parse(await deps.readJson(c));
    await ownProject(c, id);
    const existing = await scoped(
      c,
      "studio_generation_jobs",
      `${jobColumns},attempt_id`,
      id,
    )
      .eq("request_id", input.request_id)
      .maybeSingle();
    database(existing.error);
    let job: InternalJob;
    if (existing.data) {
      job = rpcJobSchema.parse(existing.data);
      if (
        job.brief_version_id !== input.brief_version_id ||
        job.brief_hash !== input.brief_hash
      )
        throw error("brief_changed", 409);
      // A replay only returns state; it never reclaims or reruns a job.
      return c.json(
        await responseJob(c, id, job),
        job.status === "pending" || job.status === "processing" ? 202 : 200,
      );
    }
    const availability = runtimeAvailability(c);
    if (!availability.available)
      throw new StudioGenerationError(
        availability.code,
        503,
        availability.message,
      );
    await persistenceAvailable(c, id);
    const schedule = scheduler(c, options);
    const eligible = await getSiteGenerationEligibility(c, {
      project_id: id,
      brief_version_id: input.brief_version_id,
      brief_hash: input.brief_hash,
    });
    if (!eligible.eligible)
      throw new StudioGenerationError(
        eligible.code,
        eligible.code === "brief_changed" ? 409 : 400,
        eligible.message,
      );
    const admitted = await c.get("db").rpc("studio_create_generation_job", {
      p_project_id: id,
      p_brief_version_id: input.brief_version_id,
      p_brief_hash: input.brief_hash,
      p_request_id: input.request_id,
    });
    database(admitted.error);
    job = rpcJobSchema.parse(admitted.data);
    if (job.status !== "pending")
      return c.json(
        await responseJob(c, id, job),
        job.status === "processing" ? 202 : 200,
      );
    const attempt = crypto.randomUUID();
    const claimed = await c.get("db").rpc("studio_start_generation_job", {
      p_job_id: job.id,
      p_attempt_id: attempt,
    });
    if (claimed.error?.code === "40001")
      return c.json(await responseJob(c, id, await getJob(c, id, job.id)), 202);
    database(claimed.error);
    job = rpcJobSchema.parse(claimed.data);
    if (job.status !== "processing" || job.attempt_id !== attempt)
      throw error("read_unavailable");
    const dispatch = new AbortController(),
      task = processSiteGeneration(c, job, options, dispatch.signal);
    try {
      schedule(task);
    } catch {
      dispatch.abort();
      await task;
      throw error("execution_unavailable");
    }
    return c.json({ job: summary(job), version: null }, 202);
  });
  app.post(`${base}/jobs/:jobId/cancel`, async (c) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(await deps.readJson(c));
    const id = project(c);
    await ownProject(c, id);
    const job = await getJob(c, id, z.uuid().parse(c.req.param("jobId")));
    if (job.status !== "failed" && job.status !== "completed") {
      const r = await c.get("db").rpc("studio_fail_generation_job", {
        p_job_id: job.id,
        p_attempt_id: job.attempt_id,
        p_error_code: generationFailureSchema.parse("cancelled"),
      });
      database(r.error);
    }
    return c.json(await responseJob(c, id, await getJob(c, id, job.id)));
  });
}
