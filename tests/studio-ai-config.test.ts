import { describe, expect, it } from "vitest";
import { readSiteAIConfig, readUsagePolicy } from "../server/studio-ai/config";
import { aiEnv } from "./fixtures/studio-ai";

describe("backend-only AI configuration", () => {
  it("is disabled without an explicit provider and has zero quotas by default", () => {
    expect(() => readSiteAIConfig({})).toThrow("desativada");
    expect(() => readSiteAIConfig({ STUDIO_AI_PROVIDER: "disabled" })).toThrow(
      "desativada",
    );
    expect(Object.values(readUsagePolicy({}))).toEqual([0, 0, 0, 0, 0]);
  });
  it("accepts an explicitly allowed model and canonical trusted HTTPS endpoint", () => {
    const cfg = readSiteAIConfig(aiEnv());
    expect(cfg.model).toBe("fixture-model");
    expect(cfg.endpoint).toBe("https://api.example.com/v1/chat/completions");
    expect(cfg.tokenParameter).toBe("max_completion_tokens");
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.policy)).toBe(true);
    expect(
      readSiteAIConfig({ ...aiEnv(), STUDIO_AI_TOKEN_PARAMETER: "max_tokens" })
        .tokenParameter,
    ).toBe("max_tokens");
  });
  it.each([
    "http://api.example.com/v1/chat/completions",
    "https://localhost/v1/chat/completions",
    "https://127.0.0.1/v1/chat/completions",
    "https://[::1]/v1/chat/completions",
    "https://169.254.169.254/v1/chat/completions",
    "https://metadata.internal/v1/chat/completions",
    "https://api.example.com:8443/v1/chat/completions",
    "https://user:secret@api.example.com/v1/chat/completions",
    "https://api.example.com/v1/chat/completions?api_key=secret",
    "https://api.example.com/v1/chat/completions#other",
    "https://api.example.com/v1/responses",
    "https://%61pi.example.com/v1/chat/completions",
    "https://api.example.com/../v1/chat/completions",
    "https://api.example.com/v1/chat/completions\n",
  ])("rejects unsafe/noncanonical endpoint %s", (endpoint) => {
    expect(() =>
      readSiteAIConfig({ ...aiEnv(), STUDIO_AI_ENDPOINT: endpoint }),
    ).toThrow();
  });
  it.each([
    { STUDIO_AI_PROVIDER: "mock" },
    { STUDIO_AI_PROVIDER: "ollama" },
    { STUDIO_AI_MODEL: "unapproved-model" },
    { STUDIO_AI_ALLOWED_MODELS: "[]" },
    { STUDIO_AI_ALLOWED_MODELS: "not JSON" },
    { STUDIO_AI_API_KEY: undefined },
    { STUDIO_AI_API_KEY: "\r\nAuthorization: forbidden" },
    { STUDIO_AI_TIMEOUT_MS: "0" },
    { STUDIO_AI_TIMEOUT_MS: "60001" },
    { STUDIO_AI_USER_REQUESTS_DAY: "-1" },
    { STUDIO_AI_GLOBAL_TOKENS_DAY: "Infinity" },
    { STUDIO_AI_USER_TOKENS_DAY: "1e6" },
    { STUDIO_AI_USER_REQUESTS_MINUTE: "21" },
    { STUDIO_AI_MAX_OUTPUT_TOKENS: "8193" },
    { STUDIO_AI_MAX_INPUT_TOKENS: "64001" },
    { STUDIO_AI_TOKEN_PARAMETER: "arbitrary_option" },
  ])("rejects invalid configuration without echoing its values %j", (patch) => {
    let error: unknown;
    try {
      readSiteAIConfig({ ...aiEnv(), ...patch });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "configuration_invalid" });
    expect(String(error)).not.toContain("Authorization:");
    expect(String(error)).not.toContain(aiEnv().STUDIO_AI_API_KEY);
  });
});
