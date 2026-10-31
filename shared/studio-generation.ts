import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const requestSiteGenerationSchema = z
  .object({
    request_id: z.uuid(),
    brief_version_id: z.uuid(),
    brief_hash: hash,
  })
  .strict();
export type RequestSiteGeneration = z.infer<typeof requestSiteGenerationSchema>;
export const generationStatusLabels = {
  pending: "Pendente",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
} as const;
export const generationFailureMessages = {
  cancelled:
    "Trabalho encerrado por solicitação humana. Uma chamada já enviada pode ter consumido cota.",
  timeout:
    "A geração excedeu o tempo disponível. Não haverá repetição automática.",
  provider_unavailable:
    "Não foi possível concluir com o provedor. Verifique disponibilidade, autenticação e cotas no servidor.",
  invalid_response:
    "O resultado não passou pela validação do documento ou pela persistência segura.",
  brief_changed:
    "O briefing mudou. Revise e aprove a versão atual antes de solicitar outro trabalho.",
  internal_error:
    "A geração não pôde ser concluída com segurança. Confira o histórico antes de tentar novamente.",
} as const;
export const generationFailureSchema = z.enum([
  "cancelled",
  "timeout",
  "provider_unavailable",
  "invalid_response",
  "brief_changed",
  "internal_error",
]);
export type GenerationFailure = z.infer<typeof generationFailureSchema>;
export const generationJobSchema = z
  .object({
    id: z.uuid(),
    project_id: z.uuid(),
    request_id: z.uuid(),
    brief_version_id: z.uuid(),
    brief_hash: hash,
    status: z.enum(["pending", "processing", "completed", "failed"]),
    error_code: generationFailureSchema.nullable(),
    created_at: z.iso.datetime({ offset: true }),
    started_at: z.iso.datetime({ offset: true }).nullable(),
    finished_at: z.iso.datetime({ offset: true }).nullable(),
    stalled: z.boolean(),
  })
  .strict();
export type GenerationJob = z.infer<typeof generationJobSchema>;
export const siteVersionSummarySchema = z
  .object({
    id: z.uuid(),
    job_id: z.uuid(),
    number: z.number().int().positive(),
    brief_version_id: z.uuid(),
    brief_hash: hash,
    document_hash: hash,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SiteVersionSummary = z.infer<typeof siteVersionSummarySchema>;
export const generationHistorySchema = z
  .object({
    jobs: z.array(generationJobSchema).max(20),
    versions: z.array(siteVersionSummarySchema).max(20),
    has_more: z.boolean(),
  })
  .strict();
export type GenerationHistory = z.infer<typeof generationHistorySchema>;
export const generationJobResponseSchema = z
  .object({
    job: generationJobSchema,
    version: siteVersionSummarySchema.nullable(),
  })
  .strict();
export const generationAvailabilitySchema = z
  .object({
    available: z.boolean(),
    code: z.enum([
      "ready",
      "disabled",
      "configuration_invalid",
      "guard_unavailable",
      "quota_exceeded",
      "migration_missing",
      "read_unavailable",
      "execution_unavailable",
    ]),
    message: z.string().max(500),
  })
  .strict();
export type GenerationAvailability = z.infer<
  typeof generationAvailabilitySchema
>;
export const generationEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    code: z.string().max(80),
    message: z.string().max(500),
    missing_fields: z.array(z.string().max(40)).max(13),
    availability: generationAvailabilitySchema,
  })
  .strict();
export type GenerationEligibility = z.infer<typeof generationEligibilitySchema>;
