import type { Bindings } from "./types";

export interface HomologBindings extends Bindings {
  // Encrypted Worker secret. Never a VITE_ variable or a build variable.
  HOMOLOG_BASIC_AUTH?: string;
}
interface ApplicationWorker {
  fetch(
    request: Request,
    env: Bindings,
    ctx?: ExecutionContext,
  ): Promise<Response>;
}
// An absolute end assertion also rejects a final newline (unlike `$` alone).
const credentialPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[\x21-\x7e]{32,128}(?![\s\S])/;
function blocked(status: 401 | 403 | 503) {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  if (status === 401)
    headers.set(
      "WWW-Authenticate",
      'Basic realm="Black Sales AI - Homologacao", charset="UTF-8"',
    );
  return new Response(
    status === 401
      ? "Autenticação da homologação necessária."
      : status === 403
        ? "A homologação exige HTTPS."
        : "Homologação indisponível. A configuração de acesso precisa ser concluída.",
    { status, headers },
  );
}
function basicCredential(header: string | null): string | null {
  if (!header || header.length > 512) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match || match[1].length % 4 !== 0) return null;
  try {
    const decoded = atob(match[1]);
    if (btoa(decoded) !== match[1] || !credentialPattern.test(decoded))
      return null;
    return decoded;
  } catch {
    return null;
  }
}
async function matchesCredential(expected: string, received: string) {
  // HMAC blinding + native MAC verification avoids a JS string/byte comparison
  // with secret-dependent early returns. The ephemeral key/tag never leave here.
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const encoder = new TextEncoder();
  const tag = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, tag, encoder.encode(received));
}

// No enable/disable switch: this entry always gates every request before the
// application can touch ASSETS, Auth, PostgreSQL, previews or export.
export function withHomologAccess(application: ApplicationWorker) {
  return {
    async fetch(
      request: Request,
      bindings: HomologBindings,
      ctx?: ExecutionContext,
    ): Promise<Response> {
      if (new URL(request.url).protocol !== "https:") return blocked(403);
      const { HOMOLOG_BASIC_AUTH: expected, ...env } = bindings;
      if (typeof expected !== "string" || !credentialPattern.test(expected))
        return blocked(503);
      const received = basicCredential(request.headers.get("Authorization"));
      if (!received) return blocked(401);
      try {
        if (!(await matchesCredential(expected, received))) return blocked(401);
      } catch {
        // No raw error, header, URL, supplied credential or secret in logs.
        return blocked(503);
      }
      const headers = new Headers(request.headers);
      headers.delete("Authorization");
      headers.delete("Proxy-Authorization");
      // Supabase continues to use its own HttpOnly session cookies/JWT. Do not
      // forward Basic credentials or its binding into the application or assets.
      const response = await application.fetch(
        new Request(request, { headers }),
        env,
        ctx,
      );
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("Cache-Control", "no-store");
      responseHeaders.set("Pragma", "no-cache");
      const vary =
        responseHeaders
          .get("Vary")
          ?.split(",")
          .map((v) => v.trim()) ?? [];
      for (const name of ["Authorization", "Cookie"])
        if (!vary.some((v) => v.toLowerCase() === name.toLowerCase()))
          vary.push(name);
      responseHeaders.set("Vary", vary.join(", "));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
  };
}
