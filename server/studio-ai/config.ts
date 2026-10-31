import { z } from "zod";
import { SiteAIError } from "./errors";

// Worker bindings only: never read import.meta.env, process.env, request JSON,
// query parameters, project fields or browser localStorage here.
export interface StudioAIEnv {
  STUDIO_AI_PROVIDER?: string;
  STUDIO_AI_ENDPOINT?: string;
  STUDIO_AI_MODEL?: string;
  STUDIO_AI_ALLOWED_MODELS?: string;
  STUDIO_AI_API_KEY?: string;
  STUDIO_AI_TIMEOUT_MS?: string;
  STUDIO_AI_MAX_INPUT_TOKENS?: string;
  STUDIO_AI_MAX_OUTPUT_TOKENS?: string;
  STUDIO_AI_TOKEN_PARAMETER?: string;
  STUDIO_AI_USER_REQUESTS_DAY?: string;
  STUDIO_AI_GLOBAL_REQUESTS_DAY?: string;
  STUDIO_AI_USER_TOKENS_DAY?: string;
  STUDIO_AI_GLOBAL_TOKENS_DAY?: string;
  STUDIO_AI_USER_REQUESTS_MINUTE?: string;
  STUDIO_AI_USAGE_GUARD?: DurableObjectNamespace;
}
export interface UsagePolicy {
  userRequestsDay: number;
  globalRequestsDay: number;
  userTokensDay: number;
  globalTokensDay: number;
  userRequestsMinute: number;
}
export interface SiteAIConfig {
  readonly provider: "openai-compatible";
  readonly endpoint: string;
  readonly model: string;
  readonly allowedModels: readonly string[];
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly tokenParameter: "max_completion_tokens" | "max_tokens";
  readonly policy: UsagePolicy;
}
function integer(
  raw: string | undefined,
  fallback: number,
  max: number,
  min = 0,
) {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw))
    throw new SiteAIError("configuration_invalid");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new SiteAIError("configuration_invalid");
  return n;
}
export function readUsagePolicy(env: StudioAIEnv): UsagePolicy {
  return {
    userRequestsDay: integer(env.STUDIO_AI_USER_REQUESTS_DAY, 0, 1000),
    globalRequestsDay: integer(env.STUDIO_AI_GLOBAL_REQUESTS_DAY, 0, 10000),
    userTokensDay: integer(env.STUDIO_AI_USER_TOKENS_DAY, 0, 10_000_000),
    globalTokensDay: integer(env.STUDIO_AI_GLOBAL_TOKENS_DAY, 0, 100_000_000),
    userRequestsMinute: integer(env.STUDIO_AI_USER_REQUESTS_MINUTE, 0, 20),
  };
}
function trustedEndpoint(raw: string | undefined): string {
  if (!raw || raw.length > 2048 || /[\s\\%]/u.test(raw))
    throw new SiteAIError("configuration_invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SiteAIError("configuration_invalid");
  }
  if (
    raw !== url.href ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      url.hostname,
    ) ||
    /(?:^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(
      url.hostname,
    ) ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*chat\/completions$/.test(url.pathname)
  )
    throw new SiteAIError("configuration_invalid");
  return url.href;
}
export function readSiteAIConfig(env: StudioAIEnv): SiteAIConfig {
  if (
    env.STUDIO_AI_PROVIDER === undefined ||
    env.STUDIO_AI_PROVIDER === "disabled"
  )
    throw new SiteAIError("disabled");
  if (env.STUDIO_AI_PROVIDER !== "openai-compatible")
    throw new SiteAIError("configuration_invalid");
  const modelSchema = z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
  let allowed: unknown;
  try {
    allowed = JSON.parse(env.STUDIO_AI_ALLOWED_MODELS ?? "null");
  } catch {
    throw new SiteAIError("configuration_invalid");
  }
  const models = z.array(modelSchema).min(1).max(20).safeParse(allowed);
  const model = modelSchema.safeParse(env.STUDIO_AI_MODEL);
  const key = env.STUDIO_AI_API_KEY;
  const parameter = env.STUDIO_AI_TOKEN_PARAMETER ?? "max_completion_tokens";
  if (
    !models.success ||
    !model.success ||
    !models.data.includes(model.data) ||
    !key ||
    key.length < 16 ||
    key.length > 4096 ||
    !/^[a-zA-Z0-9._~+/-]+=*$/.test(key) ||
    (parameter !== "max_completion_tokens" && parameter !== "max_tokens")
  )
    throw new SiteAIError("configuration_invalid");
  return Object.freeze({
    provider: "openai-compatible",
    endpoint: trustedEndpoint(env.STUDIO_AI_ENDPOINT),
    model: model.data,
    allowedModels: Object.freeze([...new Set(models.data)]),
    apiKey: key,
    timeoutMs: integer(env.STUDIO_AI_TIMEOUT_MS, 20000, 60000, 1000),
    maxInputTokens: integer(env.STUDIO_AI_MAX_INPUT_TOKENS, 16000, 64000, 1000),
    maxOutputTokens: integer(env.STUDIO_AI_MAX_OUTPUT_TOKENS, 4096, 8192, 256),
    tokenParameter: parameter,
    policy: Object.freeze(readUsagePolicy(env)),
  });
}
