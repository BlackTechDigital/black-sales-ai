import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { createClient, type Session } from "@supabase/supabase-js";
import { z } from "zod";
import {
  leadInputSchema,
  MAX_BACKUP_BYTES,
  parseLegacyBackup,
} from "../shared/leads";

import type { ApiEnv, Bindings, ClientFactory } from "./types";
import { registerRecoveryRoutes, RecoveryError } from "./recovery";
import { registerDiscoveryRoutes } from "./discovery";
import { registerStudioRoutes } from "./studio";
import {
  registerStudioGenerationRoutes,
  StudioGenerationError,
  type GenerationDependencies,
} from "./studio-generation";
import {
  registerStudioPreviewRoutes,
  StudioPreviewError,
  isStudioPreviewFramePath,
  previewFrameError,
} from "./studio-preview";
import { registerStudioExportRoutes, StudioExportError } from "./studio-export";
// Internal Durable Object class only; no route or binding is enabled here.
export { StudioAIUsageGuard } from "./studio-ai/usage-guard";
export type { Bindings, ClientFactory } from "./types";
type ApiContext = Context<ApiEnv>;
const columns =
  "id,company,city,sector,contact,site,status,notes,legacy_id,source,created_at,updated_at,deleted_at,version,discovery_origin:discovery_origins(discovery_result_id,result:discovery_results(source_name,source_url,collected_at,state,website))";
const uuid = z.uuid();
const editSchema = z
  .object({
    values: leadInputSchema,
    version: z.number().int().positive(),
    archived: z.boolean().optional(),
  })
  .strict();
const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(256) })
  .strict();
const importSchema = z
  .object({ records: z.unknown(), commit: z.boolean() })
  .strict();

function configured(env: Bindings): boolean {
  if (!env.APP_ORIGIN || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY)
    return false;
  try {
    const origin = new URL(env.APP_ORIGIN);
    const provider = new URL(env.SUPABASE_URL);
    return (
      env.APP_ORIGIN === origin.origin &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(origin.hostname))) &&
      (provider.protocol === "https:" ||
        (provider.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(provider.hostname)))
    );
  } catch {
    return false;
  }
}
const defaultClient: ClientFactory = (env, token, recoveryStorage) =>
  createClient(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      debug: false,
      ...(recoveryStorage
        ? {
            persistSession: true,
            flowType: "pkce" as const,
            storageKey: "black-sales-recovery",
            storage: recoveryStorage,
          }
        : {}),
    },
    global: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      fetch: async (input, init) => {
        try {
          const timeout = AbortSignal.timeout(15_000);
          return await fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, timeout])
              : timeout,
          });
        } catch {
          // auth-js logs thrown fetch errors. Return a sanitized service response
          // instead, so errors containing request details cannot expose secrets.
          return Response.json(
            { message: "Authentication temporarily unavailable" },
            { status: 503 },
          );
        }
      },
    },
  });
function cookieNames(c: ApiContext) {
  const prefix = c.env.APP_ORIGIN?.startsWith("https:") ? "__Host-" : "";
  return { access: `${prefix}bs-access`, refresh: `${prefix}bs-refresh` };
}
function writeSession(c: ApiContext, session: Session) {
  const names = cookieNames(c);
  const options = {
    httpOnly: true,
    secure: c.env.APP_ORIGIN?.startsWith("https:"),
    sameSite: "Strict" as const,
    path: "/",
  };
  // Keep the expired access token long enough to refresh it on a later visit.
  setCookie(c, names.access, session.access_token, {
    ...options,
    maxAge: 7 * 86400,
  });
  setCookie(c, names.refresh, session.refresh_token, {
    ...options,
    maxAge: 7 * 86400,
  });
}
function clearSession(c: ApiContext) {
  const names = cookieNames(c);
  const options = {
    path: "/",
    secure: c.env.APP_ORIGIN?.startsWith("https:"),
    httpOnly: true,
    sameSite: "Strict" as const,
  };
  deleteCookie(c, names.access, options);
  deleteCookie(c, names.refresh, options);
}
async function readJson(c: ApiContext): Promise<unknown> {
  if (c.req.header("content-type")?.split(";")[0].trim() !== "application/json")
    throw new HTTPException(415, { message: "Use conteúdo JSON." });
  const length = Number(c.req.header("content-length"));
  if (length > MAX_BACKUP_BYTES)
    throw new HTTPException(413, {
      message: "O arquivo deve ter no máximo 2 MB.",
    });
  // Enforce the actual stream size too; Content-Length cannot be trusted.
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "Informe os dados." });
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MAX_BACKUP_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, {
        message: "O arquivo deve ter no máximo 2 MB.",
      });
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPException(400, { message: "JSON inválido." });
  }
}
function databaseError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "23505")
    throw new HTTPException(409, {
      message:
        "Já existe um registro com essa identificação. Revise os dados existentes.",
    });
  if (error.code === "40001")
    throw new HTTPException(409, {
      message:
        "O registro mudou em outra sessão. Atualize a lista antes de tentar novamente.",
    });
  if (error.code === "42501")
    throw new HTTPException(403, {
      message: "Você não tem permissão para essa operação.",
    });
  if (["22023", "23514", "22P02"].includes(error.code ?? ""))
    throw new HTTPException(400, {
      message: "Dados inválidos. Confira os campos informados.",
    });
  throw new HTTPException(503, {
    message:
      "Não foi possível concluir no banco. Nenhuma confirmação de sucesso foi recebida; atualize os dados antes de tentar novamente.",
  });
}
function pageOffset(c: ApiContext): number {
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .safeParse(c.req.query("offset") ?? "0");
  if (!offset.success)
    throw new HTTPException(400, { message: "Página inválida." });
  return offset.data;
}

export function createApp(
  clientFactory: ClientFactory = defaultClient,
  generation: GenerationDependencies = {},
) {
  const app = new Hono<ApiEnv>();
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (!configured(c.env))
        throw new HTTPException(503, {
          message: "Supabase ainda não configurado no servidor.",
        });
      if (c.req.header("origin") !== c.env.APP_ORIGIN)
        throw new HTTPException(403, {
          message: "Origem da requisição não autorizada.",
        });
      if (c.req.header("sec-fetch-site") === "cross-site")
        throw new HTTPException(403, {
          message: "Requisição externa bloqueada.",
        });
    }
    await next();
  });
  async function authenticate(c: ApiContext) {
    if (!configured(c.env))
      throw new HTTPException(503, {
        message: "Supabase ainda não configurado no servidor.",
      });
    const names = cookieNames(c);
    let token = getCookie(c, names.access);
    if (!token)
      throw new HTTPException(401, {
        message: "Entre para acessar seus dados.",
      });
    const auth = clientFactory(c.env);
    let check = await auth.auth.getUser(token);
    if (check.error) {
      // A network/provider failure is not an expired session. Do not discard cookies.
      if (check.error.status !== 401 && check.error.status !== 403)
        throw new HTTPException(503, {
          message: "Não foi possível verificar sua sessão. Tente novamente.",
        });
      const refresh = getCookie(c, names.refresh);
      if (!refresh)
        throw new HTTPException(401, {
          message: "Sua sessão expirou. Entre novamente.",
        });
      const renewed = await auth.auth.refreshSession({
        refresh_token: refresh,
      });
      if (renewed.error || !renewed.data.session) {
        if (
          renewed.error &&
          ![400, 401, 403, 422].includes(renewed.error.status ?? 0)
        )
          throw new HTTPException(503, {
            message: "Autenticação indisponível. Tente novamente.",
          });
        clearSession(c);
        throw new HTTPException(401, {
          message: "Sua sessão expirou. Entre novamente.",
        });
      }
      token = renewed.data.session.access_token;
      check = { data: { user: renewed.data.session.user }, error: null };
      writeSession(c, renewed.data.session);
    }
    if (!check.data.user)
      throw new HTTPException(401, { message: "Entre novamente." });
    const db = clientFactory(c.env, token);
    const member = await db
      .from("app_members")
      .select("active")
      .eq("user_id", check.data.user.id)
      .maybeSingle();
    databaseError(member.error);
    if (!member.data?.active) {
      clearSession(c);
      throw new HTTPException(403, {
        message: "Seu acesso precisa ser liberado pelo administrador.",
      });
    }
    c.set("db", db);
    c.set("user", { id: check.data.user.id, email: check.data.user.email });
  }
  registerRecoveryRoutes(app, {
    clientFactory,
    readJson,
    configured,
    clearLogin: clearSession,
  });
  app.get("/api/session", async (c) => {
    if (!configured(c.env)) return c.json({ configured: false, user: null });
    if (!getCookie(c, cookieNames(c).access))
      return c.json({ configured: true, user: null });
    await authenticate(c);
    return c.json({ configured: true, user: c.get("user") });
  });
  app.post("/api/login", async (c) => {
    const input = loginSchema.parse(await readJson(c));
    const result = await clientFactory(c.env).auth.signInWithPassword(input);
    if (result.error || !result.data.session) {
      if (result.error?.status === 429)
        throw new HTTPException(429, {
          message: "Muitas tentativas. Aguarde antes de tentar novamente.",
        });
      if (
        result.error &&
        ![400, 401, 403, 422, 429].includes(result.error.status ?? 0)
      )
        throw new HTTPException(503, {
          message: "Autenticação temporariamente indisponível.",
        });
      throw new HTTPException(401, {
        message:
          "Não foi possível entrar. Confira suas credenciais e a liberação de acesso.",
      });
    }
    const member = await clientFactory(c.env, result.data.session.access_token)
      .from("app_members")
      .select("active")
      .eq("user_id", result.data.user.id)
      .maybeSingle();
    databaseError(member.error);
    if (!member.data?.active)
      throw new HTTPException(403, {
        message: "Seu acesso precisa ser liberado pelo administrador.",
      });
    writeSession(c, result.data.session);
    return c.json({
      user: { id: result.data.user.id, email: result.data.user.email },
    });
  });
  app.post("/api/logout", async (c) => {
    const token = getCookie(c, cookieNames(c).access);
    clearSession(c);
    if (token) {
      try {
        const response = await fetch(
          `${c.env.SUPABASE_URL}/auth/v1/logout?scope=local`,
          {
            method: "POST",
            headers: {
              apikey: c.env.SUPABASE_PUBLISHABLE_KEY!,
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!response.ok)
          return c.json({
            message:
              "Sessão local encerrada. A revogação remota não pôde ser confirmada.",
          });
      } catch {
        return c.json({
          message:
            "Sessão local encerrada. A revogação remota não pôde ser confirmada.",
        });
      }
    }
    return c.json({ message: "Sessão encerrada." });
  });
  app.use("/api/leads", async (c, next) => {
    await authenticate(c);
    await next();
  });
  app.use("/api/leads/*", async (c, next) => {
    await authenticate(c);
    await next();
  });
  app.get("/api/leads", async (c) => {
    const offset = pageOffset(c);
    const result = await c
      .get("db")
      .from("leads")
      .select(columns)
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + 199);
    databaseError(result.error);
    return c.json({ leads: result.data ?? [] });
  });
  app.post("/api/leads", async (c) => {
    const values = leadInputSchema.parse(await readJson(c));
    const result = await c
      .get("db")
      .from("leads")
      .insert(values)
      .select(columns)
      .single();
    databaseError(result.error);
    return c.json({ lead: result.data }, 201);
  });
  app.patch("/api/leads/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const input = editSchema.parse(await readJson(c));
    const result = await c.get("db").rpc("update_lead", {
      p_id: id,
      p_version: input.version,
      p_values: input.values,
      p_archived: input.archived ?? null,
    });
    databaseError(result.error);
    return c.json({ ok: true });
  });
  app.get("/api/leads/:id/history", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const offset = pageOffset(c);
    const result = await c
      .get("db")
      .from("lead_events")
      .select("id,lead_id,action,occurred_at,before_data,after_data")
      .eq("lead_id", id)
      .order("occurred_at", { ascending: false })
      .order("id")
      .range(offset, offset + 199);
    databaseError(result.error);
    return c.json({ events: result.data ?? [] });
  });
  app.post("/api/leads/import", async (c) => {
    const input = importSchema.parse(await readJson(c));
    let records;
    try {
      records = parseLegacyBackup(input.records);
    } catch (error) {
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : "Backup inválido.",
      });
    }
    const result = await c
      .get("db")
      .rpc("import_leads_v1", { p_records: records, p_commit: input.commit });
    databaseError(result.error);
    return c.json({ summary: result.data });
  });
  registerDiscoveryRoutes(app, { authenticate, readJson, databaseError });
  registerStudioRoutes(app, { authenticate, readJson, databaseError });
  registerStudioGenerationRoutes(app, { readJson }, generation);
  registerStudioPreviewRoutes(app);
  registerStudioExportRoutes(app, { readJson });
  app.notFound((c) => c.json({ message: "Operação não encontrada." }, 404));
  app.onError((error, c) => {
    if (isStudioPreviewFramePath(c.req.path))
      return previewFrameError(
        c,
        error instanceof StudioPreviewError || error instanceof HTTPException
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 503,
      );
    if (error instanceof StudioPreviewError)
      return c.json({ message: error.message, code: error.code }, error.status);
    if (error instanceof StudioExportError)
      return c.json({ message: error.message, code: error.code }, error.status);
    if (error instanceof StudioGenerationError)
      return c.json({ message: error.message, code: error.code }, error.status);
    if (error instanceof RecoveryError)
      return c.json({ message: error.message, code: error.code }, error.status);
    if (error instanceof HTTPException)
      return c.json({ message: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        { message: "Dados inválidos. Confira os campos informados." },
        400,
      );
    // Never log requests, passwords, provider errors, cookies, or tokens.
    return c.json(
      { message: "Serviço temporariamente indisponível. Tente novamente." },
      503,
    );
  });
  return app;
}
const api = createApp();
export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/"))
      return api.fetch(request, env, ctx);
    if (!env.ASSETS)
      return new Response("Execute npm run dev para abrir o painel.", {
        status: 404,
      });
    // Keep callback credentials out of asset/cache lookup URLs. The browser still
    // has its original location long enough for the early callback parser.
    const assetUrl = new URL(request.url);
    for (const key of [
      "code",
      "token_hash",
      "access_token",
      "refresh_token",
      "error",
      "error_code",
      "error_description",
      "sb_flow_id",
    ])
      assetUrl.searchParams.delete(key);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    if (response.headers.get("Content-Type")?.includes("text/html"))
      headers.set("Cache-Control", "no-store");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
};
