import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type {
  Session,
  SupabaseClient,
  SupportedStorage,
} from "@supabase/supabase-js";
import { z } from "zod";
import type { ApiEnv, Bindings, ClientFactory } from "./types";
import { authorizedOrigin } from "./origins";
import {
  recoveryPasswordSchema,
  recoveryProofSchema,
} from "../shared/recovery";

type Ctx = Context<ApiEnv>;
const RECOVERY_SECONDS = 15 * 60;
const recoveryClaimsSchema = z.object({
  sub: z.string(),
  exp: z.number(),
  session_id: z.string().min(1),
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })),
});
export class RecoveryError extends Error {
  constructor(
    public status: 400 | 401 | 429 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () =>
  new RecoveryError(
    400,
    "recovery_invalid",
    "Este link de recuperação é inválido, expirou ou já foi utilizado. Solicite um novo link.",
  );
function providerError(error: { status?: number; code?: string } | null) {
  if (!error) return;
  if (error.status === 429)
    throw new RecoveryError(
      429,
      "rate_limit",
      "Muitas tentativas. Aguarde antes de tentar novamente.",
    );
  if (![400, 401, 403, 404, 422].includes(error.status ?? 0))
    throw new RecoveryError(
      503,
      "auth_unavailable",
      "Não foi possível acessar a autenticação agora. Tente novamente em instantes.",
    );
  throw invalid();
}
function options(env: Bindings, maxAge?: number) {
  return {
    httpOnly: true,
    secure: env.APP_ORIGIN?.startsWith("https:"),
    sameSite: "Strict" as const,
    path: "/",
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}
function names(c: Ctx) {
  const prefix = c.env.APP_ORIGIN?.startsWith("https:") ? "__Host-" : "";
  return {
    access: `${prefix}bs-recovery-access`,
    refresh: `${prefix}bs-recovery-refresh`,
    pkce: `${prefix}bs-recovery-pkce`,
  };
}
function clearGrant(c: Ctx) {
  const n = names(c);
  deleteCookie(c, n.access, options(c.env));
  deleteCookie(c, n.refresh, options(c.env));
}

// The SDK's PKCE entries are HttpOnly cookies. Session objects stay only in this
// request's memory, never in the browser's localStorage or a normal login cookie.
export function pkceStorage(c: Ctx, fresh = false): SupportedStorage {
  let pending: Record<string, string> = {};
  if (!fresh) {
    try {
      const raw = getCookie(c, names(c).pkce);
      if (raw && raw.length <= 3500) {
        const parsed = z
          .record(z.string().max(160), z.string().max(1024))
          .safeParse(JSON.parse(raw));
        if (parsed.success && Object.keys(parsed.data).length <= 8)
          pending = parsed.data;
      }
    } catch {
      /* Invalid cookie is not proof of a recovery flow. */
    }
  }
  const memory = new Map<string, string>();
  const persist = () => {
    if (!Object.keys(pending).length)
      deleteCookie(c, names(c).pkce, options(c.env));
    else
      setCookie(
        c,
        names(c).pkce,
        JSON.stringify(pending),
        options(c.env, 3600),
      );
  };
  return {
    getItem: (key) =>
      key.endsWith("-code-verifier")
        ? (pending[key] ?? null)
        : (memory.get(key) ?? null),
    setItem: (key, value) => {
      if (key.endsWith("-code-verifier")) {
        pending[key] = value;
        persist();
      } else memory.set(key, value);
    },
    removeItem: (key) => {
      if (key.endsWith("-code-verifier")) {
        delete pending[key];
        persist();
      } else memory.delete(key);
    },
  };
}

async function verifiedRecovery(client: SupabaseClient, accessToken: string) {
  // Verify with Auth before interpreting any JWT claim. Decoding is NOT validation.
  const checked = await client.auth.getUser(accessToken);
  providerError(checked.error);
  if (!checked.data.user) throw invalid();
  let raw: unknown;
  try {
    const part = accessToken.split(".")[1];
    raw = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(part.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
  } catch {
    throw invalid();
  }
  const parsed = recoveryClaimsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sub !== checked.data.user.id)
    throw invalid();
  const now = Math.floor(Date.now() / 1000);
  const recovery = parsed.data.amr
    .filter(
      (claim) => claim.method === "recovery" && claim.timestamp <= now + 30,
    )
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const expiresAt = Math.min(
    parsed.data.exp,
    (recovery?.timestamp ?? 0) + RECOVERY_SECONDS,
  );
  if (!recovery || expiresAt <= now) throw invalid();
  return {
    user: checked.data.user,
    expiresAt,
    sessionId: parsed.data.session_id,
  };
}
function readGrant(c: Ctx) {
  const n = names(c),
    accessToken = getCookie(c, n.access),
    refreshToken = getCookie(c, n.refresh);
  if (!accessToken || !refreshToken) throw invalid();
  return { accessToken, refreshToken };
}
function writeGrant(c: Ctx, session: Session, expiresAt: number) {
  const ttl = expiresAt - Math.floor(Date.now() / 1000);
  const n = names(c);
  setCookie(c, n.access, session.access_token, options(c.env, ttl));
  setCookie(c, n.refresh, session.refresh_token, options(c.env, ttl));
}
export function registerRecoveryRoutes(
  app: Hono<ApiEnv>,
  deps: {
    clientFactory: ClientFactory;
    readJson: (c: Ctx) => Promise<unknown>;
    configured: (env: Bindings) => boolean;
    clearLogin: (c: Ctx) => void;
  },
) {
  const { clientFactory, readJson } = deps;
  app.use("/api/recovery/*", async (c, next) => {
    if (!deps.configured(c.env))
      throw new RecoveryError(
        503,
        "not_configured",
        "A recuperação de senha ainda não está configurada. Contate o administrador.",
      );
    await next();
  });
  app.post("/api/recovery/request", async (c) => {
    const { email } = z
      .object({ email: z.email().max(254) })
      .strict()
      .parse(await readJson(c));
    const auth = clientFactory(c.env, undefined, pkceStorage(c, true));
    const result = await auth.auth.resetPasswordForEmail(email, {
      redirectTo: `${authorizedOrigin(c.env, c.req.header("origin")) ?? c.env.APP_ORIGIN}/reset-password`,
    });
    if (result.error) {
      if (
        result.error.status === 429 ||
        ![400, 401, 403, 404, 422].includes(result.error.status ?? 0)
      )
        providerError(result.error);
      // Do not reveal whether this address is registered or eligible.
    }
    return c.json({
      message:
        "Se houver uma conta para este e-mail, você receberá um link de recuperação. Confira também a pasta de spam.",
    });
  });
  app.post("/api/recovery/verify", async (c) => {
    const proof = recoveryProofSchema.parse(await readJson(c));
    clearGrant(c);
    const client = clientFactory(c.env, undefined, pkceStorage(c));
    let result;
    if (proof.kind === "tokenHash")
      result = await client.auth.verifyOtp({
        token_hash: proof.tokenHash,
        type: "recovery",
      });
    else if (proof.kind === "code")
      result = await client.auth.exchangeCodeForSession(
        proof.code,
        proof.flowId ? { flowId: proof.flowId } : undefined,
      );
    else {
      // Reject ordinary login tokens and expired links before setSession can refresh.
      await verifiedRecovery(client, proof.accessToken);
      result = await client.auth.setSession({
        access_token: proof.accessToken,
        refresh_token: proof.refreshToken,
      });
    }
    providerError(result.error);
    if (!result.data.session) throw invalid();
    const verified = await verifiedRecovery(
      client,
      result.data.session.access_token,
    );
    writeGrant(c, result.data.session, verified.expiresAt);
    deleteCookie(c, names(c).pkce, options(c.env));
    return c.json({
      ready: true,
      email: verified.user.email,
      expiresAt: verified.expiresAt,
    });
  });
  app.get("/api/recovery/session", async (c) => {
    try {
      const grant = readGrant(c);
      const verified = await verifiedRecovery(
        clientFactory(c.env),
        grant.accessToken,
      );
      return c.json({
        ready: true,
        email: verified.user.email,
        expiresAt: verified.expiresAt,
      });
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_invalid")
        clearGrant(c);
      throw error;
    }
  });
  app.post("/api/recovery/password", async (c) => {
    const input = recoveryPasswordSchema.parse(await readJson(c));
    try {
      const grant = readGrant(c);
      const client = clientFactory(c.env);
      const original = await verifiedRecovery(client, grant.accessToken);
      // A revoked refresh token cannot be used to replay an already completed reset.
      const refreshed = await client.auth.refreshSession({
        refresh_token: grant.refreshToken,
      });
      providerError(refreshed.error);
      if (!refreshed.data.session) throw invalid();
      const verified = await verifiedRecovery(
        client,
        refreshed.data.session.access_token,
      );
      if (
        verified.user.id !== original.user.id ||
        verified.sessionId !== original.sessionId
      )
        throw invalid();
      writeGrant(c, refreshed.data.session, verified.expiresAt);
      const result = await client.auth.updateUser({ password: input.password });
      if (result.error?.code === "weak_password")
        throw new RecoveryError(
          400,
          "password_policy",
          "A senha não atende à política de segurança da conta. Escolha uma senha mais forte.",
        );
      if (result.error?.code === "same_password")
        throw new RecoveryError(
          400,
          "password_policy",
          "Escolha uma senha diferente da senha anterior.",
        );
      providerError(result.error);
      if (!result.data.user || result.data.user.id !== verified.user.id)
        throw invalid();
      clearGrant(c);
      deps.clearLogin(c);
      let revoked = false;
      try {
        const signedOut = await client.auth.signOut({ scope: "global" });
        revoked = !signedOut.error;
      } catch {
        /* Password is saved; report revocation separately. */
      }
      return c.json({
        updated: true,
        message: revoked
          ? "Senha atualizada. Entre novamente com a nova senha."
          : "Senha atualizada. Entre novamente. Não foi possível confirmar o encerramento de todas as outras sessões.",
      });
    } catch (error) {
      if (error instanceof RecoveryError && error.code === "recovery_invalid")
        clearGrant(c);
      throw error;
    }
  });
}
