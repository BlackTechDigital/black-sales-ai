import type { Context } from "hono";
import { vi } from "vitest";
import type { ApiEnv } from "../../server/types";
import type { StudioAIEnv } from "../../server/studio-ai/config";
import { StudioAIUsageGuard } from "../../server/studio-ai/usage-guard";
import { alice, briefFixture, documentFixture } from "./site-persistence";

export { alice, documentFixture };
export const projectId = "33333333-3333-4333-8333-333333333333",
  briefId = "44444444-4444-4444-8444-444444444444",
  jobId = "55555555-5555-4555-8555-555555555555",
  attemptId = "66666666-6666-4666-8666-666666666666",
  hash = "a".repeat(64);
export function aiEnv(): StudioAIEnv {
  // Deliberately fictional credentials and endpoint; never used with real fetch.
  return {
    STUDIO_AI_PROVIDER: "openai-compatible",
    STUDIO_AI_ENDPOINT: "https://api.example.com/v1/chat/completions",
    STUDIO_AI_MODEL: "fixture-model",
    STUDIO_AI_ALLOWED_MODELS: '["fixture-model"]',
    STUDIO_AI_API_KEY: "fixture-only-not-a-real-api-key",
    STUDIO_AI_MAX_INPUT_TOKENS: "64000",
    STUDIO_AI_MAX_OUTPUT_TOKENS: "4096",
    STUDIO_AI_TIMEOUT_MS: "1000",
    STUDIO_AI_USER_REQUESTS_DAY: "5",
    STUDIO_AI_GLOBAL_REQUESTS_DAY: "10",
    STUDIO_AI_USER_TOKENS_DAY: "1000000",
    STUDIO_AI_GLOBAL_TOKENS_DAY: "2000000",
    STUDIO_AI_USER_REQUESTS_MINUTE: "5",
  };
}
export function aiContext() {
  const fields = briefFixture();
  const detail = {
    project: {
      id: projectId,
      head_id: briefId,
      mode: "demo",
      lead_snapshot: { contact: "Snapshot PRIVADO" },
    },
    version: {
      id: briefId,
      project_id: projectId,
      content_hash: hash,
      fields,
      approval: {
        id: "77777777-7777-4777-8777-777777777777",
        project_id: projectId,
        version_id: briefId,
        actor_id: alice,
        content_hash: hash,
      } as Record<string, string> | null,
    },
  };
  const job = {
    id: jobId,
    owner_id: alice,
    project_id: projectId,
    brief_version_id: briefId,
    brief_hash: hash,
    status: "processing",
    attempt_id: attemptId,
    project_mode: "demo",
    public_information: Object.fromEntries(
      Object.entries(fields)
        .filter(([k, f]) => k !== "creative_notes" && f.public_use)
        .map(([k, f]) => [k, f.value]),
    ),
  };
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: job,
      error: null as null | { code: string },
    })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const db = {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({ data: detail, error: null })),
  };
  const context = {
    get: (key: string) => (key === "user" ? { id: alice } : db),
  } as unknown as Pick<Context<ApiEnv>, "get">;
  return { context, db, query, detail, job };
}

// ONLY a transactional storage double. Production never imports this file or
// uses a Map as the cross-isolate quota store. Models rollback, persistence and
// serialized transactions so guard logic can be tested without cloud services.
export class MemoryGuardStorage {
  values = new Map<string, unknown>();
  #tail: Promise<unknown> = Promise.resolve();
  transaction<T>(
    operation: (tx: {
      get: <V>(key: string) => Promise<V | undefined>;
      put: (values: Record<string, unknown>) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const next = this.#tail.then(async () => {
      const draft = structuredClone(this.values);
      const result = await operation({
        get: async <V>(key: string) => draft.get(key) as V | undefined,
        put: async (values) => {
          for (const [k, v] of Object.entries(values)) draft.set(k, v);
        },
      });
      this.values = draft;
      return result;
    });
    this.#tail = next.catch(() => {});
    return next;
  }
  state() {
    return { storage: this as unknown as DurableObjectStorage };
  }
}
export function guardFixture(
  env = aiEnv(),
  storage = new MemoryGuardStorage(),
) {
  const guard = new StudioAIUsageGuard(storage.state(), env);
  const transport = vi.fn((request: Request) => guard.fetch(request));
  const namespace = {
    idFromName: vi.fn(() => "single-global-guard"),
    get: vi.fn(() => ({ fetch: transport })),
  } as unknown as DurableObjectNamespace;
  env.STUDIO_AI_USAGE_GUARD = namespace;
  return { env, guard, storage, transport, namespace };
}
