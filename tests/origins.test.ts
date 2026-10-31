import { describe, expect, it } from "vitest";
import { authorizedOrigin, configuredOrigins } from "../server/origins";
const primary = "http://localhost:5173";
const lan = "http://192.168.18.7:5173";
const env = { APP_ORIGIN: primary, APP_LOCAL_ORIGINS: JSON.stringify([lan]) };
describe("exact local origin configuration", () => {
  it("keeps the single-origin default and opts in only the configured LAN address", () => {
    expect(configuredOrigins({ APP_ORIGIN: primary })).toEqual([primary]);
    expect(authorizedOrigin({ APP_ORIGIN: primary }, lan)).toBeNull();
    expect(configuredOrigins(env)).toEqual([primary, lan]);
    expect(authorizedOrigin(env, primary)).toBe(primary);
    expect(authorizedOrigin(env, lan)).toBe(lan);
  });
  it.each([
    undefined,
    "",
    "null",
    "*",
    "http://192.168.18.8:5173",
    "http://192.168.18.7:5174",
    "https://192.168.18.7:5173",
    "http://192.168.18.7:5173/",
    "http://192.168.18.7:5173.evil.example",
    "http://192.168.18.7:5173@evil.example",
    "http://evil.example",
    "http://127.0.0.1:5173",
    " http://192.168.18.7:5173",
    "http://localhost:5173 http://192.168.18.7:5173",
  ])("rejects non-exact request Origin %s", (origin) => {
    expect(authorizedOrigin(env, origin)).toBeNull();
  });
  it.each([
    "*",
    "",
    "null",
    '"http://192.168.18.7:5173"',
    '["*"]',
    '["http://0.0.0.0:5173"]',
    '["http://8.8.8.8:5173"]',
    '["https://192.168.18.7:5173"]',
    '["http://192.168.18.7:5173/"]',
    '["http://user:secret@192.168.18.7:5173"]',
    '["http://192.168.18.7:5173?x=1"]',
    '["http://192.168.18.7:5173#x"]',
    '["http://office.local:5173"]',
    '["http://172.32.0.1:5173"]',
    '["http://[::]:5173"]',
    "[null]",
    "[42]",
    "{}",
    JSON.stringify(Array(9).fill(lan)),
    " ".repeat(4097),
  ])("fails closed for invalid local-origin configuration %#", (raw) => {
    expect(
      configuredOrigins({ APP_ORIGIN: primary, APP_LOCAL_ORIGINS: raw }),
    ).toBeNull();
  });
  it("supports explicit RFC1918 entries and deduplicates without broadening access", () => {
    const settings = {
      APP_ORIGIN: primary,
      APP_LOCAL_ORIGINS: JSON.stringify([
        lan,
        lan,
        "http://10.0.0.2:5173",
        "http://172.16.0.2:5173",
        "http://127.0.0.1:5173",
      ]),
    };
    expect(configuredOrigins(settings)).toHaveLength(5);
    expect(authorizedOrigin(settings, "http://10.0.0.3:5173")).toBeNull();
  });
  it("preserves HTTPS production and refuses local exceptions there", () => {
    const APP_ORIGIN = "https://sales.example.com";
    expect(configuredOrigins({ APP_ORIGIN })).toEqual([APP_ORIGIN]);
    expect(configuredOrigins({ ...env, APP_ORIGIN })).toBeNull();
    expect(
      configuredOrigins({ APP_ORIGIN, APP_LOCAL_ORIGINS: "[]" }),
    ).toBeNull();
    expect(configuredOrigins({ APP_ORIGIN: lan })).toBeNull();
    expect(configuredOrigins({ APP_ORIGIN: primary + "/" })).toBeNull();
  });
});
