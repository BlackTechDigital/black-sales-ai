import { z } from "zod";
import { MAX_BACKUP_BYTES } from "./leads";

export const states = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
] as const;
export const MAX_DISCOVERY_RECORDS = 500;
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (v) => !/[\u0000-\u001f\u007f]/u.test(v),
      "Remova os caracteres de controle.",
    );
export const publicUrl = text(1000).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}, "Use uma URL http ou https, sem credenciais.");
export const discoveryRecordSchema = z
  .object({
    company: text(100).min(1, "Informe a empresa."),
    city: text(70).min(1, "Informe a cidade."),
    state: z.enum(states),
    sector: text(80).min(1, "Informe o segmento."),
    contact: text(160).default(""),
    website: publicUrl.default(""),
  })
  .strict();
export const discoverySourceSchema = z
  .object({
    name: text(160).min(1, "Informe a fonte dos dados."),
    url: publicUrl.default(""),
    collected_at: z.iso
      .datetime({ offset: true })
      .refine(
        (value) => new Date(value).getTime() <= Date.now() + 5 * 60_000,
        "A data de coleta não pode estar no futuro.",
      ),
  })
  .strict();
export const discoveryRecordsSchema = z
  .array(discoveryRecordSchema)
  .min(1)
  .max(MAX_DISCOVERY_RECORDS);
export const discoveryImportSchema = z
  .object({
    source: discoverySourceSchema,
    records: discoveryRecordsSchema,
    commit: z.boolean(),
  })
  .strict();
export const discoveryQuerySchema = z
  .object({
    city: text(70).default(""),
    state: z.union([z.enum(states), z.literal("")]).default(""),
    sector: text(80).default(""),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>;
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
export interface PipelineMatch {
  lead_id: string;
  archived: boolean;
  linked: boolean;
}
export interface DiscoveryResult extends DiscoveryRecord {
  id: string;
  source_name: string;
  source_url: string;
  source_kind: "manual";
  collected_at: string;
  created_at: string;
  pipeline_match: PipelineMatch | null;
}
export interface DiscoverySummary {
  total: number;
  created: number;
  duplicates: number;
  committed: boolean;
}
export interface DiscoveryOrigin {
  discovery_result_id: string;
  result: Pick<
    DiscoveryResult,
    "source_name" | "source_url" | "collected_at" | "state" | "website"
  >;
}
export interface DiscoverySources {
  providers: { id: string; name: string }[];
  manual: true;
}
export interface PromotionResult {
  outcome: "added" | "duplicate" | "already_added";
  lead_id: string;
  archived: boolean;
}
export const initialDiscoveryQuery: DiscoveryQuery = {
  city: "Passos",
  state: "MG",
  sector: "",
  offset: 0,
};
export function parseDiscoveryFile(raw: string): DiscoveryRecord[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES)
    throw new Error("O arquivo deve ter no máximo 2 MB.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("O arquivo não contém JSON válido.");
  }
  const result = discoveryRecordsSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const row =
      typeof issue.path[0] === "number"
        ? ` Linha ${issue.path[0] + 1}, campo ${String(issue.path[1] ?? "registro")}.`
        : "";
    throw new Error(
      `Importação inválida. Use de 1 a ${MAX_DISCOVERY_RECORDS} empresas com cidade, UF e segmento.${row}`,
    );
  }
  return result.data;
}
