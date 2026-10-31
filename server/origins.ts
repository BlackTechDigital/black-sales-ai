// Trusted Worker configuration only. Never derive this list from Host,
// X-Forwarded-* headers, a request body or a VITE_* variable.
interface OriginSettings {
  APP_ORIGIN?: string;
  APP_LOCAL_ORIGINS?: string;
}
const loopback = (host: string) => host === "localhost" || host === "127.0.0.1";
function canonicalOrigin(raw: string): URL | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return raw === url.origin && ["http:", "https:"].includes(url.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}
function privateIPv4(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const parts = host.split(".").map(Number);
  return (
    parts.every((n) => n >= 0 && n <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}
export function configuredOrigins(
  env: OriginSettings,
): readonly string[] | null {
  const primary = canonicalOrigin(env.APP_ORIGIN ?? "");
  if (!primary || (primary.protocol === "http:" && !loopback(primary.hostname)))
    return null;
  if (env.APP_LOCAL_ORIGINS === undefined) return [primary.origin];
  // LAN HTTP is an explicit local opt-in. An HTTPS/production origin cannot
  // acquire HTTP exceptions, mixed cookie modes or new trusted origins here.
  if (
    primary.protocol !== "http:" ||
    !loopback(primary.hostname) ||
    env.APP_LOCAL_ORIGINS.length > 4096
  )
    return null;
  let extra: unknown;
  try {
    extra = JSON.parse(env.APP_LOCAL_ORIGINS);
  } catch {
    return null;
  }
  if (!Array.isArray(extra) || extra.length > 8) return null;
  const origins = [primary.origin];
  for (const raw of extra) {
    if (typeof raw !== "string") return null;
    const url = canonicalOrigin(raw);
    if (
      !url ||
      url.protocol !== "http:" ||
      (!loopback(url.hostname) && !privateIPv4(url.hostname))
    )
      return null;
    origins.push(raw);
  }
  return [...new Set(origins)];
}
export function authorizedOrigin(
  env: OriginSettings,
  raw: string | undefined,
): string | null {
  // Compare the received header verbatim: no prefix, suffix, substring, regex
  // wildcard, URL normalization, missing-Origin or "null" exceptions.
  return raw && configuredOrigins(env)?.includes(raw) ? raw : null;
}
