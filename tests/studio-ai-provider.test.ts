import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleSiteProvider,
  MAX_PROVIDER_RESPONSE_BYTES,
} from "../server/studio-ai/openai-compatible";
import { readSiteAIConfig } from "../server/studio-ai/config";
import { createSitePrompt } from "../server/studio-ai/prompt";
import {
  aiEnv,
  aiContext,
  documentFixture,
  projectId,
  briefId,
  hash,
} from "./fixtures/studio-ai";

const prompt = () =>
  createSitePrompt({
    project_id: projectId,
    brief_version_id: briefId,
    brief_hash: hash,
    approval_id: projectId,
    mode: "demo",
    public_information: aiContext().job.public_information,
  });
const responseEnvelope = () => ({
  model: "fixture-model",
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify(documentFixture()),
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 200 },
});
const requestSignal = () => new AbortController().signal;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network forbidden in AI tests");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("OpenAI-compatible bounded transport", () => {
  it("sends one strict structured request to the configured endpoint with server-only authorization", async () => {
    const cfg = readSiteAIConfig(aiEnv()),
      transport = vi.fn(async () => Response.json(responseEnvelope()));
    const provider = new OpenAICompatibleSiteProvider(cfg, transport);
    const result = await provider.generate(prompt(), requestSignal());
    expect(JSON.parse(result.text)).toEqual(documentFixture());
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [endpoint, options] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe(cfg.endpoint);
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(new Headers(options.headers).get("Authorization")).toBe(
      `Bearer ${cfg.apiKey}`,
    );
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({
      model: "fixture-model",
      max_completion_tokens: 4096,
      stream: false,
      n: 1,
      store: false,
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(body)).not.toContain(cfg.apiKey);
    expect(JSON.stringify(provider)).not.toContain(cfg.apiKey);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses max_tokens only if explicitly configured, without probing another mode", async () => {
    const transport = vi.fn(async () => Response.json(responseEnvelope()));
    await new OpenAICompatibleSiteProvider(
      readSiteAIConfig({ ...aiEnv(), STUDIO_AI_TOKEN_PARAMETER: "max_tokens" }),
      transport,
    ).generate(prompt(), requestSignal());
    const body = JSON.parse(
      (transport.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
  it.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [429, "provider_rate_limited"],
    [400, "provider_unavailable"],
    [500, "provider_unavailable"],
    [302, "provider_unavailable"],
  ])("sanitizes status %s and never retries", async (status, code) => {
    const raw = `SECRET_RAW_PROVIDER_ERROR ${aiEnv().STUDIO_AI_API_KEY}`;
    const transport = vi.fn(
      async () => new Response(raw, { status: Number(status) }),
    );
    await expect(
      new OpenAICompatibleSiteProvider(
        readSiteAIConfig(aiEnv()),
        transport,
      ).generate(prompt(), requestSignal()),
    ).rejects.toMatchObject({ code });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    {},
    { choices: [] },
    {
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "{}" },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: null,
            refusal: "Cannot answer",
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}", tool_calls: [] },
        },
      ],
    },
    {
      choices: [
        { finish_reason: "stop", message: { role: "user", content: "{}" } },
      ],
    },
    {
      model: "unapproved",
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}" },
        },
      ],
    },
  ])(
    "rejects malformed, refused, truncated or tool responses",
    async (value) => {
      const transport = vi.fn(async () => Response.json(value));
      await expect(
        new OpenAICompatibleSiteProvider(
          readSiteAIConfig(aiEnv()),
          transport,
        ).generate(prompt(), requestSignal()),
      ).rejects.toMatchObject({ code: "provider_invalid_response" });
    },
  );
  it("rejects non-JSON, malformed JSON and invalid UTF-8 without returning provider text", async () => {
    for (const response of [
      new Response("not JSON", { headers: { "Content-Type": "text/html" } }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
      new Response(new Uint8Array([0xff]), {
        headers: { "Content-Type": "application/json" },
      }),
    ]) {
      await expect(
        new OpenAICompatibleSiteProvider(
          readSiteAIConfig(aiEnv()),
          async () => response,
        ).generate(prompt(), requestSignal()),
      ).rejects.toMatchObject({ code: "provider_invalid_response" });
    }
  });
  it("bounds declared and streamed response bytes and cancels oversized streams", async () => {
    const cancel = vi.fn();
    for (const response of [
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
        },
      }),
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1));
          },
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ]) {
      await expect(
        new OpenAICompatibleSiteProvider(
          readSiteAIConfig(aiEnv()),
          async () => response,
        ).generate(prompt(), requestSignal()),
      ).rejects.toMatchObject({ code: "output_limit" });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects reported token usage beyond configured limits", async () => {
    const value = responseEnvelope();
    value.usage.completion_tokens = 8193;
    await expect(
      new OpenAICompatibleSiteProvider(readSiteAIConfig(aiEnv()), async () =>
        Response.json(value),
      ).generate(prompt(), requestSignal()),
    ).rejects.toMatchObject({ code: "output_limit" });
  });
  it("sanitizes transport exceptions and distinguishes cancellation", async () => {
    const fail = async () => {
      throw new Error(`Authorization: ${aiEnv().STUDIO_AI_API_KEY}`);
    };
    const provider = new OpenAICompatibleSiteProvider(
      readSiteAIConfig(aiEnv()),
      fail,
    );
    await expect(
      provider.generate(prompt(), requestSignal()),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generate(prompt(), controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
