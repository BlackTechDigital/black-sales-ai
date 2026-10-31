import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "./types";
import { loadStudioPreviewVersion } from "./studio-preview";
import { getSiteGenerationEligibility } from "./studio-site-eligibility";
import {
  buildSiteArtifact,
  createArtifactZip,
  EXPORT_PROFILE,
} from "./studio-site-artifact";
import {
  siteReviewRequestSchema,
  siteExportRequestSchema,
  type SiteExportStatus,
} from "../shared/studio-export";

type Ctx = Context<ApiEnv>;
const messages = {
  ready: "Versão revisada e autorizada para baixar este pacote estático.",
  export_disabled: "A exportação ainda não foi habilitada no servidor.",
  review_required:
    "Revise e aprove esta versão exata do site antes de exportar. A aprovação do briefing não aprova o site.",
  review_changed:
    "A revisão ou os arquivos do pacote mudaram. Atualize e revise a versão antes de baixar.",
  brief_changed:
    "O briefing ou suas permissões mudaram. A exportação exige o mesmo briefing atual, aprovado e autorizado usado nesta versão.",
  historical_unreviewed:
    "Esta versão antiga não possui revisão válida para este pacote. A revisão de novas versões não é transferida; somente a versão atual pode receber uma nova revisão.",
  invalid_document:
    "O pacote contém conteúdo incompatível com a exportação segura.",
  read_unavailable:
    "Não foi possível confirmar a revisão. Atualize antes de tentar novamente.",
  migration_missing:
    "A persistência de revisões de sites ainda não está disponível. Solicite a revisão da configuração ao administrador.",
  forbidden: "Projeto, versão ou revisão indisponível para esta conta.",
} as const;
export class StudioExportError extends Error {
  constructor(
    public readonly code: keyof typeof messages,
    public readonly status: 400 | 403 | 404 | 409 | 422 | 503,
  ) {
    super(messages[code]);
    this.name = "StudioExportError";
  }
}
function database(e: { code?: string } | null) {
  if (!e) return;
  if (
    ["42P01", "42883", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(
      e.code ?? "",
    )
  )
    throw new StudioExportError("migration_missing", 503);
  if (e.code === "42501") throw new StudioExportError("forbidden", 403);
  if (["40001", "23505", "22023"].includes(e.code ?? ""))
    throw new StudioExportError("review_changed", 409);
  throw new StudioExportError("read_unavailable", 503);
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reviewSchema = z
  .object({
    id: z.uuid(),
    version_id: z.uuid(),
    document_hash: digest,
    decision: z.enum(["approved", "changes_requested"]),
    created_at: z.iso.datetime({ offset: true }),
    notes: z.string().max(1000),
  })
  .strip();
const note = (artifact: string) =>
  `export-review-v1:${EXPORT_PROFILE}:${artifact}`;
async function latestReview(c: Ctx, project: string, id: string) {
  const r = await c
    .get("db")
    .from("studio_site_reviews")
    .select("id,version_id,document_hash,decision,created_at,notes")
    .eq("owner_id", c.get("user").id)
    .eq("project_id", project)
    .eq("version_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  database(r.error);
  if (!r.data?.length) return null;
  const parsed = reviewSchema.safeParse(r.data[0]);
  if (!parsed.success || parsed.data.version_id !== id)
    throw new StudioExportError("read_unavailable", 503);
  return parsed.data;
}
async function prepare(c: Ctx, project: string, id: string, hash: string) {
  const selected = await loadStudioPreviewVersion(c, project, id, hash);
  let artifact;
  try {
    artifact = await buildSiteArtifact(selected.document, selected.version);
  } catch {
    throw new StudioExportError("invalid_document", 422);
  }
  // Only rendered public output is exported, never the raw JSON, private brief,
  // notes, actor, tokens, request headers, provider config or external hrefs.
  const publicText = new TextDecoder().decode(artifact.files.get("index.html"));
  const forbidden = [
    c.env.STUDIO_AI_API_KEY,
    c.env.SUPABASE_PUBLISHABLE_KEY,
    c.env.SUPABASE_URL,
  ].filter((s): s is string => Boolean(s && s.length >= 12));
  if (
    forbidden.some((secret) => publicText.includes(secret)) ||
    /BLACK_SALES_STUDIO_SYSTEM_V1|\b(?:sk-|sb_secret_)[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(
      publicText,
    )
  )
    throw new StudioExportError("invalid_document", 422);
  const eligibility = await getSiteGenerationEligibility(c, {
    project_id: project,
    brief_version_id: selected.version.brief_version_id,
    brief_hash: selected.version.brief_hash,
  });
  if (
    !eligibility.eligible &&
    [
      "read_unavailable",
      "authentication_required",
      "project_unavailable",
    ].includes(eligibility.code)
  )
    throw new StudioExportError("read_unavailable", 503);
  const review = await latestReview(c, project, id);
  const enabled = c.env.STUDIO_SITE_EXPORT_ENABLED === "true",
    eligible = eligibility.eligible;
  const reviewed =
    review?.decision === "approved" &&
    review.document_hash === hash &&
    review.notes === note(artifact.artifactHash);
  const current = selected.current_version_id === id;
  const code: SiteExportStatus["code"] = !enabled
    ? "export_disabled"
    : !eligible
      ? "brief_changed"
      : reviewed
        ? "ready"
        : !current
          ? "historical_unreviewed"
          : review
            ? "review_changed"
            : "review_required";
  const status: SiteExportStatus = {
    version_id: id,
    document_hash: hash,
    artifact_hash: artifact.artifactHash,
    visual_hash: artifact.visualHash,
    enabled,
    can_review: enabled && eligible && current,
    can_export: enabled && eligible && Boolean(reviewed),
    code,
    message: messages[code],
    review: review
      ? {
          id: review.id,
          decision: review.decision,
          created_at: review.created_at,
        }
      : null,
  };
  return { selected, artifact, status, review };
}
export function registerStudioExportRoutes(
  app: Hono<ApiEnv>,
  deps: { readJson(c: Ctx): Promise<unknown> },
) {
  const base =
    "/api/studio/projects/:id/site-preview/versions/:versionId/export";
  const ids = (c: Ctx) => ({
    project: z.uuid().parse(c.req.param("id")),
    version: z.uuid().parse(c.req.param("versionId")),
  });
  app.get(`${base}/status`, async (c) => {
    const id = ids(c);
    return c.json(
      (
        await prepare(
          c,
          id.project,
          id.version,
          digest.parse(c.req.query("document_hash")),
        )
      ).status,
    );
  });
  app.post(`${base}/reviews`, async (c) => {
    const id = ids(c),
      input = siteReviewRequestSchema.parse(await deps.readJson(c));
    const state = await prepare(c, id.project, id.version, input.document_hash);
    if (!state.status.enabled)
      throw new StudioExportError("export_disabled", 503);
    if (
      input.artifact_hash !== state.artifact.artifactHash ||
      input.visual_hash !== state.artifact.visualHash
    )
      throw new StudioExportError("review_changed", 409);
    if (state.selected.current_version_id !== id.version)
      throw new StudioExportError("historical_unreviewed", 409);
    if (input.decision === "approved" && !state.status.can_review)
      throw new StudioExportError("brief_changed", 409);
    const r = await c.get("db").rpc("studio_review_site_version", {
      p_version_id: id.version,
      p_document_hash: input.document_hash,
      p_decision: input.decision,
      p_notes: note(state.artifact.artifactHash),
      p_request_id: input.request_id,
    });
    database(r.error);
    return c.json(
      (await prepare(c, id.project, id.version, input.document_hash)).status,
    );
  });
  app.post(base, async (c) => {
    const id = ids(c),
      input = siteExportRequestSchema.parse(await deps.readJson(c));
    const state = await prepare(c, id.project, id.version, input.document_hash);
    if (!state.status.enabled)
      throw new StudioExportError("export_disabled", 503);
    if (!state.status.can_export)
      throw new StudioExportError(state.status.code, 409);
    if (
      state.status.review?.id !== input.review_id ||
      state.artifact.artifactHash !== input.artifact_hash ||
      state.artifact.visualHash !== input.visual_hash
    )
      throw new StudioExportError("review_changed", 409);
    const archive = await createArtifactZip(state.artifact);
    // Recheck persisted authorization after building, before releasing bytes.
    // Download authorization is a point-in-time check, not a permanent grant.
    const current = await prepare(
      c,
      id.project,
      id.version,
      input.document_hash,
    );
    if (
      !current.status.can_export ||
      current.status.review?.id !== input.review_id ||
      current.artifact.artifactHash !== input.artifact_hash
    )
      throw new StudioExportError("review_changed", 409);
    c.header(
      "Content-Disposition",
      `attachment; filename="black-sales-site-v${state.selected.version.number}-${input.document_hash.slice(0, 12)}.zip"`,
    );
    c.header("Content-Type", "application/zip");
    c.header("Content-Length", String(archive.zip.length));
    c.header("X-Studio-Document-Hash", input.document_hash);
    c.header("X-Studio-Artifact-Hash", state.artifact.artifactHash);
    c.header("X-Studio-Visual-SHA256", state.artifact.visualHash);
    c.header("X-Studio-Archive-SHA256", archive.archiveHash);
    return c.body(archive.zip.slice().buffer, 200);
  });
}
