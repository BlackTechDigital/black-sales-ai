import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRequestId } from "../src/request-id";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("cryptographic frontend request UUIDs", () => {
  it("works without randomUUID and sets the UUID v4 version/variant correctly", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => {
      bytes.set(Array.from({ length: 16 }, (_, i) => i));
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(createRequestId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });
  it("does not depend on randomUUID even when it exists, or on Math.random/time", () => {
    const randomUUID = vi.fn(() => {
      throw new Error("This API must not be called");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Predictable fallback forbidden");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Timestamp fallback forbidden");
    });
    vi.stubGlobal("crypto", {
      randomUUID,
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) =>
        webcrypto.getRandomValues(bytes),
    });
    const id = createRequestId();
    expect(id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(randomUUID).not.toHaveBeenCalled();
  });
  it("preserves random bits apart from version and variant", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => bytes.fill(255),
    });
    expect(createRequestId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });
  it("creates independent valid IDs with the actual CSPRNG", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) =>
        webcrypto.getRandomValues(bytes),
    });
    const ids = Array.from({ length: 256 }, () => createRequestId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => z.uuid().safeParse(id).success)).toBe(true);
  });
  it.each([undefined, {}, { randomUUID: () => "not-a-secure-fallback" }])(
    "fails closed when the CSPRNG is absent %#",
    (value) => {
      vi.stubGlobal("crypto", value);
      expect(createRequestId).toThrow("geração segura de identificadores");
    },
  );
  it("sanitizes source failures rather than leaking internal errors", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw new Error("PRIVATE_RNG_ERROR_FIXTURE");
      },
    });
    try {
      createRequestId();
      throw new Error("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("identificador seguro");
      expect(String(error)).not.toContain("PRIVATE_RNG_ERROR_FIXTURE");
    }
  });
});
