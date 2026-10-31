import { z } from "zod";
import { SITE_LIMITS } from "../../shared/studio-sites";
import type { SiteAIConfig } from "./config";
import { SiteAIError } from "./errors";
import type {
  SiteDocumentProvider,
  SiteProviderRequest,
  SiteProviderOutput,
} from "./provider";

// JSON escaping can expand a valid 128 KiB document inside the API envelope.
export const MAX_PROVIDER_RESPONSE_BYTES =
  SITE_LIMITS.documentBytes * 6 + 16384;
const envelope = z.object({
  model: z.string().max(120).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.literal("stop"),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string(),
          refusal: z.null().optional(),
          tool_calls: z.never().optional(),
          function_call: z.never().optional(),
        }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().safe(),
      completion_tokens: z.number().int().nonnegative().safe(),
    })
    .optional(),
});
async function boundedJSON(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new SiteAIError("output_limit");
  }
  if (!response.body) throw new SiteAIError("provider_invalid_response");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      if (signal.aborted) throw new SiteAIError("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES)
        throw new SiteAIError("output_limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SiteAIError) throw error;
    throw new SiteAIError("provider_invalid_response");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
export class OpenAICompatibleSiteProvider implements SiteDocumentProvider {
  #config: SiteAIConfig;
  #fetch: typeof fetch;
  constructor(config: SiteAIConfig, transport: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = transport;
  }
  async generate(
    request: SiteProviderRequest,
    signal: AbortSignal,
  ): Promise<SiteProviderOutput> {
    if (signal.aborted) throw new SiteAIError("cancelled");
    const cfg = this.#config;
    let response: Response;
    try {
      response = await this.#fetch(cfg.endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: request.messages,
          stream: false,
          n: 1,
          store: false,
          [cfg.tokenParameter]: cfg.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "black_sales_site_v1",
              strict: true,
              schema: request.schema,
            },
          },
        }),
      });
    } catch {
      throw new SiteAIError(
        signal.aborted ? "cancelled" : "provider_unavailable",
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        throw new SiteAIError("provider_auth");
      if (response.status === 429)
        throw new SiteAIError("provider_rate_limited");
      throw new SiteAIError("provider_unavailable");
    }
    if (
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      void response.body?.cancel().catch(() => {});
      throw new SiteAIError("provider_invalid_response");
    }
    const parsed = envelope.safeParse(await boundedJSON(response, signal));
    if (
      !parsed.success ||
      (parsed.data.model && !cfg.allowedModels.includes(parsed.data.model))
    )
      throw new SiteAIError("provider_invalid_response");
    const usage = parsed.data.usage;
    if (
      usage &&
      (usage.prompt_tokens > cfg.maxInputTokens ||
        usage.completion_tokens > cfg.maxOutputTokens)
    )
      throw new SiteAIError("output_limit");
    return {
      text: parsed.data.choices[0].message.content,
      ...(usage
        ? {
            usage: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
          }
        : {}),
    };
  }
}
