// Backend-only deterministic fingerprints; no credentials or model input.
export const bytesSha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
export const textSha256 = (value: string) =>
  bytesSha256(new TextEncoder().encode(value));
