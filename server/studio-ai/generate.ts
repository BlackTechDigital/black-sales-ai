import type { Context } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { getSiteGenerationEligibility } from "../studio-site-eligibility";
import {
  parseSiteDocumentText,
  type SiteDocument,
} from "../../shared/studio-sites";
import { readSiteAIConfig, type StudioAIEnv } from "./config";
import { SiteAIError, type SiteAIErrorCode } from "./errors";
import { OpenAICompatibleSiteProvider } from "./openai-compatible";
import { createSitePrompt, hasInternalOutputLeak } from "./prompt";
import type { SiteDocumentProvider } from "./provider";
import { durableUsageGate, type SiteUsageGate } from "./usage-guard";

const inputSchema = z.object({ job_id: z.uuid() }).strict();
const jobSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  brief_version_id: z.uuid(),
  brief_hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("processing"),
  attempt_id: z.uuid(),
  project_mode: z.enum(["opportunity", "demo"]),
  public_information: z.record(z.string(), z.string()),
});
type AIContext = Pick<Context<ApiEnv>, "get">;
async function authorizedJob(context: AIContext, id: string, owner: string) {
  let record;
  try {
    record = await context
      .get("db")
      .from("studio_generation_jobs")
      .select(
        "id,owner_id,project_id,brief_version_id,brief_hash,status,attempt_id,project_mode,public_information",
      )
      .eq("id", id)
      .eq("owner_id", owner)
      .maybeSingle();
  } catch {
    throw new SiteAIError("job_unavailable");
  }
  const job = jobSchema.safeParse(record.data);
  if (
    record.error ||
    !job.success ||
    job.data.id !== id ||
    job.data.owner_id !== owner
  )
    throw new SiteAIError("job_unavailable");
  const eligibility = await getSiteGenerationEligibility(context, {
    project_id: job.data.project_id,
    brief_version_id: job.data.brief_version_id,
    brief_hash: job.data.brief_hash,
  });
  if (!eligibility.eligible)
    throw new SiteAIError(
      eligibility.code === "brief_changed"
        ? "brief_changed"
        : "brief_unavailable",
    );
  const brief = eligibility.context,
    stored = job.data.public_information,
    authorized = brief.public_information;
  if (
    job.data.project_mode !== brief.mode ||
    Object.keys(stored).length !== Object.keys(authorized).length ||
    Object.entries(authorized).some(([k, v]) => stored[k] !== v)
  )
    throw new SiteAIError("brief_changed");
  return { job: job.data, brief };
}
export type SiteAIGenerationResult =
  | {
      ok: true;
      document: SiteDocument;
      job_id: string;
      brief_version_id: string;
      brief_hash: string;
      requiresHumanReview: true;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; code: SiteAIErrorCode; message: string };
const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
async function deadline<T>(
  ms: number,
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) throw new SiteAIError("cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SiteAIError("timeout"));
      controller.abort();
    }, ms);
    abort = () => {
      reject(new SiteAIError("cancelled"));
      controller.abort();
    };
    parent?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([failure, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** Backend-only adapter service, deliberately NOT registered as a route/worker
 * consumer. Caller context must come from the existing auth middleware. Job
 * admission/claim, persistence, scheduling and human review remain separate.
 * Dependencies are for explicit trusted tests; never construct them from HTTP.
 */
export async function generateStudioSite(
  context: AIContext,
  input: unknown,
  env: StudioAIEnv,
  dependencies: {
    provider?: SiteDocumentProvider;
    gate?: SiteUsageGate;
    transport?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<SiteAIGenerationResult> {
  try {
    const user = context.get("user"),
      db = context.get("db");
    if (!user || !z.uuid().safeParse(user.id).success || !db)
      throw new SiteAIError("authentication_required");
    const request = inputSchema.safeParse(input);
    if (!request.success) throw new SiteAIError("invalid_request");
    const config = readSiteAIConfig(env);
    const gate = dependencies.gate ?? durableUsageGate(env);
    const { job, brief } = await authorizedJob(
      context,
      request.data.job_id,
      user.id,
    );
    const authorized = brief.public_information;
    const prompt = createSitePrompt(brief);
    // Conservative byte-based estimate + framing allowance, not a model tokenizer.
    // Reserve the FULL configured input/output budgets, even on errors/timeouts.
    const estimatedInput =
      new TextEncoder().encode(JSON.stringify(prompt)).byteLength + 1024;
    if (estimatedInput > config.maxInputTokens)
      throw new SiteAIError("input_limit");
    const provider =
      dependencies.provider ??
      new OpenAICompatibleSiteProvider(config, dependencies.transport);
    const reservation = {
      subject: await sha256(`studio-ai-user:${user.id}`),
      key: await sha256(`studio-ai-job:${job.id}`),
      tokens: config.maxInputTokens + config.maxOutputTokens,
    };
    const output = await deadline(
      config.timeoutMs,
      dependencies.signal,
      async (signal) => {
        await gate.reserve(reservation);
        if (signal.aborted) throw new SiteAIError("cancelled");
        // The durable reservation may have waited. Recheck membership, job
        // state and briefing immediately before any external network call.
        const current = await authorizedJob(context, job.id, user.id);
        if (
          current.job.attempt_id !== job.attempt_id ||
          current.brief.brief_hash !== brief.brief_hash ||
          current.brief.brief_version_id !== brief.brief_version_id
        )
          throw new SiteAIError("brief_changed");
        if (signal.aborted) throw new SiteAIError("cancelled");
        return provider.generate(prompt, signal);
      },
    );
    let document: SiteDocument;
    try {
      if (
        typeof output.text !== "string" ||
        hasInternalOutputLeak(output.text, config.apiKey)
      )
        throw new Error();
      document = parseSiteDocumentText(output.text);
      if (
        hasInternalOutputLeak(JSON.stringify(document), config.apiKey) ||
        document.identity.business_name !== authorized.company?.trim()
      )
        throw new Error();
    } catch {
      throw new SiteAIError("provider_invalid_response");
    }
    const usage = output.usage;
    if (
      usage &&
      (!Number.isSafeInteger(usage.inputTokens) ||
        !Number.isSafeInteger(usage.outputTokens) ||
        usage.inputTokens < 0 ||
        usage.outputTokens < 0 ||
        usage.inputTokens > config.maxInputTokens ||
        usage.outputTokens > config.maxOutputTokens)
    )
      throw new SiteAIError("output_limit");
    return {
      ok: true,
      document,
      job_id: job.id,
      brief_version_id: brief.brief_version_id,
      brief_hash: brief.brief_hash,
      requiresHumanReview: true,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    const safe =
      error instanceof SiteAIError
        ? error
        : new SiteAIError("provider_unavailable");
    return { ok: false, code: safe.code, message: safe.message };
  }
}
