import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canVerifySiteExport,
  downloadSiteExport,
  secureExportMessage,
} from "../src/studio/export-api";
import type { SiteExportStatus } from "../shared/studio-export";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("export integrity capability guard", () => {
  it.each([undefined, {}, { getRandomValues: () => {} }])(
    "blocks export before networking when SHA-256 is unavailable %#",
    async (crypto) => {
      vi.stubGlobal("crypto", crypto);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(canVerifySiteExport()).toBe(false);
      await expect(
        downloadSiteExport("project", "version", 1, {} as SiteExportStatus),
      ).rejects.toMatchObject({
        message: secureExportMessage,
        code: "secure_context_required",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("recognizes native SHA-256 support", () => {
    expect(canVerifySiteExport()).toBe(true);
  });
});
