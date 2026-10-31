import type { Context } from "hono";
import { z } from "zod";
import type { ApiEnv } from "./types";
import {
  briefFieldDefinitions,
  briefFieldsSchema,
  type BriefFields,
} from "../shared/studio";
import {
  REQUIRED_SITE_PUBLIC_FIELDS,
  siteGenerationRequestSchema,
  type SiteGenerationEligibility,
  type SitePublicKey,
} from "../shared/studio-sites";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
// The existing RPC includes additional server metadata. Select only identifiers
// and validated fields needed here; no snapshot, sources or private text leaves.
const persistedDetailSchema = z.object({
  project: z.object({
    id: z.uuid(),
    head_id: z.uuid(),
    mode: z.enum(["opportunity", "demo"]),
  }),
  version: z.object({
    id: z.uuid(),
    project_id: z.uuid(),
    content_hash: hash,
    fields: z.unknown(),
    approval: z
      .object({
        id: z.uuid(),
        project_id: z.uuid(),
        version_id: z.uuid(),
        actor_id: z.uuid(),
        content_hash: hash,
      })
      .nullable(),
  }),
});

/** Backend-only, read-only preparation. The context must come from the existing
 * authenticate middleware (verified user + user-scoped Supabase client).
 * No route is registered. Never construct this context from request JSON or use
 * a service-role client. Eligibility is not a durable generation authorization;
 * future job admission must revalidate it atomically with its usage reservation.
 */
export async function getSiteGenerationEligibility(
  context: Pick<Context<ApiEnv>, "get">,
  input: unknown,
): Promise<SiteGenerationEligibility> {
  const user = context.get("user"),
    db = context.get("db");
  if (!user || !z.uuid().safeParse(user.id).success || !db)
    return {
      eligible: false,
      code: "authentication_required",
      message: "Entre com uma conta autorizada para verificar o briefing.",
    };
  const request = siteGenerationRequestSchema.safeParse(input);
  if (!request.success)
    return {
      eligible: false,
      code: "invalid_request",
      message: "Informe somente projeto, versão e hash esperados.",
    };
  let response;
  try {
    // This RPC checks active membership and RLS, and reads the CURRENT version
    // in one database statement. Client-supplied approval data is never used.
    response = await db.rpc("studio_project_detail", {
      p_id: request.data.project_id,
      p_version_id: null,
    });
  } catch {
    return {
      eligible: false,
      code: "read_unavailable",
      message: "Não foi possível consultar o briefing. Tente novamente.",
    };
  }
  if (response.error) {
    if (response.error.code === "42501")
      return {
        eligible: false,
        code: "project_unavailable",
        message: "Projeto indisponível para esta conta.",
      };
    return {
      eligible: false,
      code: "read_unavailable",
      message: "Não foi possível consultar o briefing. Tente novamente.",
    };
  }
  const record = persistedDetailSchema.safeParse(response.data);
  if (!record.success)
    return {
      eligible: false,
      code: "read_unavailable",
      message: "Não foi possível validar o registro do briefing.",
    };
  const { project, version } = record.data;
  if (
    project.id !== request.data.project_id ||
    version.project_id !== project.id
  )
    return {
      eligible: false,
      code: "project_unavailable",
      message: "Projeto indisponível para esta conta.",
    };
  if (
    project.head_id !== version.id ||
    version.id !== request.data.brief_version_id ||
    version.content_hash !== request.data.brief_hash
  )
    return {
      eligible: false,
      code: "brief_changed",
      message: "O briefing mudou. Confira a versão atual antes de continuar.",
    };
  const approval = version.approval;
  if (
    !approval ||
    approval.project_id !== project.id ||
    approval.version_id !== version.id ||
    approval.content_hash !== version.content_hash ||
    approval.actor_id !== user.id
  )
    return {
      eligible: false,
      code: "brief_not_approved",
      message: "A versão atual precisa de aprovação válida para este conteúdo.",
    };
  if (!briefFieldsSchema.safeParse(version.fields).success)
    return {
      eligible: false,
      code: "invalid_brief",
      message: "O conteúdo do briefing precisa ser revisado.",
    };
  // Validation may trim strings. Use the original persisted values, since the
  // database hash and approval refer to the original JSONB, not a transformed copy.
  const fields = version.fields as BriefFields;
  if (
    project.mode === "opportunity" &&
    Object.values(fields).some((field) => field.verification === "fictional")
  )
    return {
      eligible: false,
      code: "invalid_brief",
      message: "Conteúdo fictício é permitido somente em demonstrações.",
    };
  const publicInformation: Partial<Record<SitePublicKey, string>> = {};
  for (const { key } of briefFieldDefinitions) {
    const field = fields[key];
    if (
      key !== "creative_notes" &&
      field.public_use &&
      field.value.trim() &&
      field.source.trim() &&
      (field.verification === "verified" ||
        (project.mode === "demo" && field.verification === "fictional"))
    )
      publicInformation[key] = field.value;
  }
  const missing = REQUIRED_SITE_PUBLIC_FIELDS.filter(
    (key) => !publicInformation[key],
  );
  if (missing.length)
    return {
      eligible: false,
      code: "insufficient_public_information",
      message:
        "Autorize os campos públicos essenciais para preparar a geração.",
      missing_fields: missing,
    };
  return {
    eligible: true,
    context: {
      project_id: project.id,
      brief_version_id: version.id,
      approval_id: approval.id,
      brief_hash: version.content_hash,
      mode: project.mode,
      public_information: publicInformation,
    },
  };
}
