import { describe, expect, it } from "vitest";
import {
  leadInputSchema,
  parseBackupText,
  parseLegacyBackup,
  makeDraft,
  emptyLead,
  MAX_BACKUP_BYTES,
} from "../shared/leads";
const fixture = {
  id: "legacy-id",
  company: "Empresa de teste",
  city: "Cidade de teste",
  status: "Novo",
};
describe("input boundaries", () => {
  it("preserves extra provenance without filling invented fields into the original", () => {
    const data = [{ ...fixture, extra: { original: true } }];
    expect(parseLegacyBackup(data)).toBe(data);
    expect(data[0]).not.toHaveProperty("site");
  });
  it.each([
    null,
    {},
    [],
    [{ ...fixture, company: "" }],
    [{ ...fixture, status: "inventado" }],
    [{ ...fixture, site: "inventado" }],
    [{ ...fixture, notes: "x".repeat(601) }],
    [{ ...fixture, contact: { value: "invalid" } }],
    [{ ...fixture, id: "" }],
  ])("rejects invalid backup %j", (input) => {
    expect(() => parseLegacyBackup(input)).toThrow("Backup inválido");
  });
  it("rejects malformed JSON and oversized UTF-8 without truncating", () => {
    expect(() => parseBackupText("not JSON")).toThrow("JSON válido");
    expect(() => parseBackupText("ç".repeat(MAX_BACKUP_BYTES))).toThrow("2 MB");
  });
  it("rejects owner or version injection on form writes", () => {
    expect(
      leadInputSchema.safeParse({
        ...emptyLead,
        company: "Teste",
        city: "Cidade",
        owner_id: "another-user",
      }).success,
    ).toBe(false);
  });
  it("does not claim to have analyzed the business or change a stage when drafting", () => {
    const lead = {
      ...emptyLead,
      company: "Empresa de teste",
      city: "Cidade de teste",
    };
    const draft = makeDraft(lead);
    expect(draft).toContain(lead.company);
    expect(draft).not.toContain("Vi a empresa");
    expect(lead.status).toBe("Novo");
    expect(lead.site).toBe("unknown");
  });
});
