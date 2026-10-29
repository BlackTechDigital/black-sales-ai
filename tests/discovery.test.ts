import { describe, expect, it } from "vitest";
import {
  discoveryImportSchema,
  discoveryQuerySchema,
  discoveryRecordSchema,
  discoverySourceSchema,
  parseDiscoveryFile,
} from "../shared/discovery";

// Synthetic fixtures, never seeded into the application or a remote database.
const record = {
  company: "Empresa sintética de teste",
  city: "Passos",
  state: "MG",
  sector: "Serviços",
};
const source = {
  name: "Arquivo sintético de testes",
  url: "https://source.example.test",
  collected_at: "2026-01-01T12:00:00-03:00",
};
describe("discovery validation", () => {
  it("requires real user input and never supplies a company or diagnosis", () => {
    expect(discoveryRecordSchema.safeParse({}).success).toBe(false);
    expect(discoveryRecordSchema.parse(record)).toEqual({
      ...record,
      contact: "",
      website: "",
    });
  });
  it.each([
    { company: "" },
    { city: 22 },
    { state: "XX" },
    { sector: "" },
    { contact: "a\nsecret" },
    { owner_id: "injected" },
    { site: "good" },
    { website: "javascript:alert(1)" },
    { website: "https://user:secret@example.test" },
  ])("rejects invalid or injected fields %j", (patch) => {
    expect(
      discoveryRecordSchema.safeParse({ ...record, ...patch }).success,
    ).toBe(false);
  });
  it("requires a valid collection date with timezone and a named source", () => {
    expect(discoverySourceSchema.parse(source)).toEqual(source);
    for (const patch of [
      { name: "" },
      { collected_at: "2026-02-30T00:00:00Z" },
      { collected_at: "2026-01-01" },
      { collected_at: "2999-01-01T00:00:00Z" },
      { url: "data:text/html,test" },
      { key: "secret" },
    ])
      expect(
        discoverySourceSchema.safeParse({ ...source, ...patch }).success,
      ).toBe(false);
  });
  it("bounds files, record counts, JSON structure, and all rows", () => {
    expect(() => parseDiscoveryFile("{")).toThrow("JSON válido");
    expect(() => parseDiscoveryFile(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(
      "2 MB",
    );
    expect(() => parseDiscoveryFile("[]")).toThrow("Importação inválida");
    expect(() =>
      parseDiscoveryFile(JSON.stringify({ records: [record] })),
    ).toThrow();
    expect(() =>
      parseDiscoveryFile(JSON.stringify([record, { ...record, state: "bad" }])),
    ).toThrow("Linha 2, campo state");
    expect(() =>
      parseDiscoveryFile(JSON.stringify(Array(501).fill(record))),
    ).toThrow();
    expect(parseDiscoveryFile(JSON.stringify([record]))).toHaveLength(1);
  });
  it("rejects ownership injection at source and import boundaries", () => {
    expect(
      discoveryImportSchema.safeParse({
        source,
        records: [record],
        commit: false,
        owner_id: "other",
      }).success,
    ).toBe(false);
    expect(
      discoveryImportSchema.safeParse({ source, records: [record] }).success,
    ).toBe(false);
  });
  it("validates filters and pagination without treating segment as SQL", () => {
    expect(
      discoveryQuerySchema.parse({
        city: " Passos ",
        state: "MG",
        sector: "%",
        offset: "100",
      }),
    ).toEqual({ city: "Passos", state: "MG", sector: "%", offset: 100 });
    for (const query of [
      { offset: -1 },
      { offset: "1.5" },
      { state: "ZZ" },
      { owner_id: "other" },
    ])
      expect(discoveryQuerySchema.safeParse(query).success).toBe(false);
  });
});
