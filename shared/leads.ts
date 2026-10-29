import { z } from "zod";
import type { DiscoveryOrigin } from "./discovery";
export const LEGACY_STORAGE_KEY = "black_sales_ai_leads_v1";
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 5000;
export const statuses = [
  "Novo",
  "Contato preparado",
  "Em negociação",
  "Fechado",
] as const;
export const sites = ["unknown", "none", "basic", "good"] as const;
export const siteLabels: Record<(typeof sites)[number], string> = {
  unknown: "Ainda não analisado",
  none: "Sem site identificado",
  basic: "Site básico / desatualizado",
  good: "Site aparentemente bom",
};
export const sectors = [
  "Marcenaria",
  "Serralheria",
  "Indústria",
  "Manutenção",
  "Loja",
  "Serviços",
  "Outro",
];
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v),
      "Texto contém caracteres inválidos.",
    );
export const leadInputSchema = z
  .object({
    company: text(100).min(1, "Informe a empresa."),
    city: text(80).min(1, "Informe a cidade."),
    sector: text(80),
    contact: text(160),
    site: z.enum(sites),
    status: z.enum(statuses),
    notes: text(600),
  })
  .strict();
export type LeadInput = z.infer<typeof leadInputSchema>;
export const legacyLeadSchema = leadInputSchema
  .extend({
    id: text(200).min(1),
    sector: text(80).default(""),
    contact: text(160).default(""),
    site: z.enum(sites).default("unknown"),
    notes: text(600).default(""),
  })
  .passthrough();
export type LegacyLead = z.infer<typeof legacyLeadSchema>;
export interface Lead extends LeadInput {
  id: string;
  legacy_id: string | null;
  source: "manual" | "v1_import";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  discovery_origin?: DiscoveryOrigin | null;
}
export interface LeadEvent {
  id: string;
  lead_id: string;
  action: "created" | "imported" | "updated" | "archived" | "restored";
  occurred_at: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown>;
}
export interface ImportSummary {
  total: number;
  created: number;
  duplicates: number;
  conflicts: number;
  conflict_rows: number[];
  committed: boolean;
}
export const emptyLead: LeadInput = {
  company: "",
  city: "",
  sector: "Outro",
  contact: "",
  site: "unknown",
  status: "Novo",
  notes: "",
};
export function parseLegacyBackup(input: unknown): LegacyLead[] {
  const result = z
    .array(legacyLeadSchema)
    .min(1)
    .max(MAX_IMPORT_RECORDS)
    .safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const row =
      typeof issue.path[0] === "number"
        ? ` Registro ${issue.path[0] + 1}, campo ${String(issue.path[1] ?? "registro")}.`
        : "";
    throw new Error(
      `Backup inválido. Use um array JSON da versão 1.0, com até ${MAX_IMPORT_RECORDS} registros válidos.${row}`,
    );
  }
  // Keep the original object, including unknown fields and whitespace, as provenance.
  return input as LegacyLead[];
}
export function parseBackupText(raw: string): LegacyLead[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES)
    throw new Error("O backup deve ter no máximo 2 MB.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("O arquivo não contém JSON válido.");
  }
  return parseLegacyBackup(data);
}
export function makeDraft(lead: LeadInput): string {
  // Template only: no AI call, invented observations, automatic stage change, or send action.
  return `Olá! Tudo bem? Sou da Black Tech. Desenvolvemos sites profissionais, soluções de inteligência artificial e automações.\n\nGostaria de entender se alguma dessas soluções pode ajudar a ${lead.company}. Posso apresentar nosso trabalho?\n\nObrigado!`;
}
export function toLegacyExport(leads: Lead[]): LegacyLead[] {
  return leads.map((lead) => ({
    id: lead.legacy_id ?? lead.id,
    company: lead.company,
    city: lead.city,
    sector: lead.sector,
    contact: lead.contact,
    site: lead.site,
    status: lead.status,
    notes: lead.notes,
  }));
}

export function pickLeadValues(lead: LeadInput): LeadInput {
  const { company, city, sector, contact, site, status, notes } = lead;
  return { company, city, sector, contact, site, status, notes };
}
