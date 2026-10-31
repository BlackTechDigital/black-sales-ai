// Client idempotency/request IDs only. Authentication tokens, authorization
// and database identities remain owned and validated by the backend.
export function createRequestId(): string {
  const source = globalThis.crypto;
  if (typeof source?.getRandomValues !== "function")
    throw new Error(
      "O navegador não oferece geração segura de identificadores. Atualize-o ou use um navegador compatível.",
    );
  const bytes = new Uint8Array(16);
  try {
    // Unlike randomUUID/subtle, getRandomValues is available in HTTP contexts.
    source.getRandomValues(bytes);
  } catch {
    throw new Error(
      "Não foi possível gerar um identificador seguro. Tente novamente em um navegador compatível.",
    );
  }
  // UUID v4: 122 random bits, fixed version and variant (RFC 9562).
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
