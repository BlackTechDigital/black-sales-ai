import { z } from "zod";
export const briefFieldDefinitions = [
  {
    key: "company",
    label: "Nome da empresa",
    group: "Empresa",
    max: 100,
    required: true,
  },
  {
    key: "sector",
    label: "Segmento",
    group: "Empresa",
    max: 80,
    required: true,
  },
  { key: "city", label: "Cidade", group: "Empresa", max: 80, required: true },
  {
    key: "services",
    label: "Serviços",
    group: "Estratégia",
    max: 4000,
    required: true,
  },
  {
    key: "audience",
    label: "Público-alvo",
    group: "Estratégia",
    max: 4000,
    required: true,
  },
  {
    key: "differentiators",
    label: "Diferenciais",
    group: "Estratégia",
    max: 4000,
    required: false,
  },
  {
    key: "visual_identity",
    label: "Identidade visual",
    group: "Direção criativa",
    max: 4000,
    required: false,
  },
  {
    key: "colors",
    label: "Preferências de cores",
    group: "Direção criativa",
    max: 4000,
    required: false,
  },
  {
    key: "site_style",
    label: "Estilo do site",
    group: "Direção criativa",
    max: 4000,
    required: false,
  },
  {
    key: "visual_references",
    label: "Referências visuais",
    group: "Direção criativa",
    max: 4000,
    required: false,
  },
  {
    key: "features",
    label: "Funcionalidades desejadas",
    group: "Funcionalidades e contatos",
    max: 4000,
    required: false,
  },
  {
    key: "contacts",
    label: "Contatos comerciais",
    group: "Funcionalidades e contatos",
    max: 2000,
    required: false,
  },
  {
    key: "creative_notes",
    label: "Observações do diretor criativo",
    group: "Direção criativa",
    max: 4000,
    required: false,
  },
] as const;
export type BriefKey = (typeof briefFieldDefinitions)[number]["key"];
export const verificationLabels = {
  pending: "Pendente de verificação",
  verified: "Confirmado pelo responsável",
  fictional: "Fictício / demonstração",
} as const;
export type ProjectMode = "opportunity" | "demo";
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v),
      "Remova os caracteres de controle.",
    );
export const briefFieldSchema = z
  .object({
    value: text(4000),
    source: text(500),
    verification: z.enum(["pending", "verified", "fictional"]),
    public_use: z.boolean(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.verification !== "pending" && (!field.value || !field.source))
      ctx.addIssue({
        code: "custom",
        message: "Uma informação confirmada precisa de conteúdo e origem.",
      });
    if (field.public_use && (!field.value || field.verification === "pending"))
      ctx.addIssue({
        code: "custom",
        message: "Verifique a informação antes de autorizar uso público.",
      });
  });
export type BriefField = z.infer<typeof briefFieldSchema>;
export type BriefFields = Record<BriefKey, BriefField>;
export const briefFieldsSchema = z
  .object(
    Object.fromEntries(
      briefFieldDefinitions.map((d) => [d.key, briefFieldSchema]),
    ) as Record<BriefKey, typeof briefFieldSchema>,
  )
  .strict()
  .superRefine((fields, ctx) => {
    for (const d of briefFieldDefinitions)
      if (fields[d.key].value.length > d.max)
        ctx.addIssue({
          code: "custom",
          path: [d.key, "value"],
          message: `${d.label}: máximo de ${d.max} caracteres.`,
        });
    if (fields.creative_notes.public_use)
      ctx.addIssue({
        code: "custom",
        path: ["creative_notes"],
        message: "Observações do diretor são internas.",
      });
    if (
      new TextEncoder().encode(JSON.stringify(fields)).byteLength >
      128 * 1024
    )
      ctx.addIssue({
        code: "custom",
        message: "O briefing deve ter no máximo 128 KB.",
      });
  });
export function emptyBrief(): BriefFields {
  return Object.fromEntries(
    briefFieldDefinitions.map((d) => [
      d.key,
      { value: "", source: "", verification: "pending", public_use: false },
    ]),
  ) as BriefFields;
}
export function changeBriefField(
  field: BriefField,
  patch: Partial<BriefField>,
): BriefField {
  const changed =
    (patch.value !== undefined && patch.value !== field.value) ||
    (patch.source !== undefined && patch.source !== field.source);
  const next = { ...field, ...patch };
  if (changed) {
    next.verification = "pending";
    next.public_use = false;
  }
  if (next.verification === "pending") next.public_use = false;
  return next;
}
export function approvalIssues(
  fields: BriefFields,
  mode: ProjectMode,
): string[] {
  return briefFieldDefinitions.flatMap((d) => {
    const f = fields[d.key];
    if (d.required && !f.value.trim())
      return [`${d.label}: preencha a informação obrigatória.`];
    if (
      f.value &&
      (!f.source.trim() ||
        f.verification === "pending" ||
        (f.verification === "fictional" && mode !== "demo"))
    )
      return [`${d.label}: informe a origem e conclua a verificação.`];
    return [];
  });
}
export const createStudioProjectSchema = z
  .object({
    title: text(120).min(1),
    mode: z.enum(["opportunity", "demo"]),
    lead_id: z.uuid().nullable(),
    request_id: z.uuid(),
  })
  .strict()
  .refine(
    (v) => (v.mode === "opportunity" ? v.lead_id !== null : v.lead_id === null),
    { message: "Escolha uma oportunidade ou um projeto de demonstração." },
  );
export const saveStudioBriefSchema = z
  .object({
    expected_head_id: z.uuid(),
    fields: briefFieldsSchema,
    request_id: z.uuid(),
  })
  .strict();
export const approveStudioBriefSchema = z
  .object({
    version_id: z.uuid(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
  })
  .strict();
export interface StudioProject {
  id: string;
  title: string;
  mode: ProjectMode;
  lead_id: string | null;
  lead_snapshot: Record<string, unknown> | null;
  head_id: string;
  created_at: string;
  head_approved?: boolean;
}
export interface BriefApproval {
  id: string;
  version_id: string;
  actor_id: string;
  content_hash: string;
  created_at: string;
}
export interface BriefVersionMeta {
  id: string;
  project_id: string;
  number: number;
  parent_id: string | null;
  content_hash: string;
  created_at: string;
  created_by: string;
  approval: BriefApproval | null;
}
export interface BriefVersion extends BriefVersionMeta {
  fields: BriefFields;
}
export interface StudioDetail {
  project: StudioProject;
  version: BriefVersion;
}
export function briefChanges(
  before: BriefFields,
  after: BriefFields,
): BriefKey[] {
  return briefFieldDefinitions
    .filter(
      ({ key }) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((d) => d.key);
}
