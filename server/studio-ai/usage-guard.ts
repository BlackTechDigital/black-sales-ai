import { z } from "zod";
import { readUsagePolicy, type StudioAIEnv } from "./config";
import { SiteAIError } from "./errors";

export interface UsageReservation {
  subject: string;
  key: string;
  tokens: number;
}
export interface SiteUsageGate {
  reserve(value: UsageReservation): Promise<void>;
}
const reservationSchema = z
  .object({
    subject: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    tokens: z.number().int().min(1).max(72192),
  })
  .strict();
interface Counter {
  requests: number;
  tokens: number;
}
function counter(value: Counter | undefined): Counter {
  if (value === undefined) return { requests: 0, tokens: 0 };
  if (
    !Number.isSafeInteger(value.requests) ||
    !Number.isSafeInteger(value.tokens) ||
    value.requests < 0 ||
    value.tokens < 0
  )
    throw new SiteAIError("guard_unavailable");
  return value;
}

// Exported for a FUTURE explicitly configured Worker binding. No binding or
// Durable Object migration is added/applied in this stage, and no public route
// forwards requests here. There is no in-memory production fallback.
export class StudioAIUsageGuard {
  #storage: DurableObjectStorage;
  #env: StudioAIEnv;
  constructor(state: Pick<DurableObjectState, "storage">, env: StudioAIEnv) {
    this.#storage = state.storage;
    this.#env = env;
  }
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/reserve"
    )
      return new Response(null, { status: 404 });
    // Internal fixed-size body: no briefing, prompt, credentials or provider output.
    if (Number(request.headers.get("content-length")) > 1024)
      return new Response(null, { status: 400 });
    try {
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      let raw = "",
        bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024) return new Response(null, { status: 400 });
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        void reader.cancel().catch(() => {});
      }
      const parsed = reservationSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return new Response(null, { status: 400 });
      const { subject, key, tokens } = parsed.data;
      const policy = readUsagePolicy(this.#env),
        now = Date.now();
      const jobKey = `job:${key}`,
        globalKey = `day:${Math.floor(now / 86400000)}:global`,
        userKey = `day:${Math.floor(now / 86400000)}:${subject}`,
        minuteKey = `minute:${Math.floor(now / 60000)}:${subject}`;
      const result = await this.#storage.transaction(async (tx) => {
        // Check idempotency before quotas, and retain the key across days,
        // failures, disconnects and Worker restarts. No refund or auto-retry.
        if ((await tx.get(jobKey)) !== undefined) return "duplicate_request";
        const global = counter(await tx.get<Counter>(globalKey)),
          user = counter(await tx.get<Counter>(userKey)),
          minute = counter(await tx.get<Counter>(minuteKey));
        if (
          global.requests >= policy.globalRequestsDay ||
          user.requests >= policy.userRequestsDay ||
          minute.requests >= policy.userRequestsMinute ||
          global.tokens + tokens > policy.globalTokensDay ||
          user.tokens + tokens > policy.userTokensDay
        )
          return "quota_exceeded";
        await tx.put({
          [jobKey]: { reservedAt: now, tokens },
          [globalKey]: {
            requests: global.requests + 1,
            tokens: global.tokens + tokens,
          },
          [userKey]: {
            requests: user.requests + 1,
            tokens: user.tokens + tokens,
          },
          [minuteKey]: {
            requests: minute.requests + 1,
            tokens: minute.tokens + tokens,
          },
        });
        return "allowed";
      });
      return Response.json(
        { code: result },
        {
          status:
            result === "allowed"
              ? 200
              : result === "duplicate_request"
                ? 409
                : 429,
        },
      );
    } catch {
      return Response.json({ code: "guard_unavailable" }, { status: 503 });
    }
  }
}
export function durableUsageGate(env: StudioAIEnv): SiteUsageGate {
  const namespace = env.STUDIO_AI_USAGE_GUARD;
  if (!namespace) throw new SiteAIError("guard_unavailable");
  return {
    async reserve(value) {
      try {
        const stub = namespace.get(
          namespace.idFromName("black-sales-studio-ai-usage-v1"),
        );
        const response = await stub.fetch(
          new Request("https://studio-usage.internal/reserve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reservationSchema.parse(value)),
          }),
        );
        const reply = z
          .object({
            code: z.enum([
              "allowed",
              "duplicate_request",
              "quota_exceeded",
              "guard_unavailable",
            ]),
          })
          .strict()
          .safeParse(await response.json());
        if (!reply.success) throw new SiteAIError("guard_unavailable");
        if (response.status === 200 && reply.data.code === "allowed") return;
        if (response.status === 409 && reply.data.code === "duplicate_request")
          throw new SiteAIError("duplicate_request");
        if (response.status === 429 && reply.data.code === "quota_exceeded")
          throw new SiteAIError("quota_exceeded");
        throw new SiteAIError("guard_unavailable");
      } catch (error) {
        if (error instanceof SiteAIError) throw error;
        throw new SiteAIError("guard_unavailable");
      }
    },
  };
}
