import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "./types";
import { siteVersionSummarySchema } from "../shared/studio-generation";
import {
  InvalidPreviewDocument,
  validatePreviewDocument,
  renderSitePreview,
  renderPreviewError,
  previewHeaders,
  renderSiteVisual,
  siteVisualHash,
} from "./studio-preview-renderer";

type Ctx = Context<ApiEnv>;
type PreviewStatus = 400 | 401 | 403 | 404 | 409 | 422 | 503;
const messages = {
  invalid_document: "O documento salvo não é compatível com a prévia segura.",
  version_unavailable: "Projeto ou versão indisponível para esta conta.",
  preview_changed:
    "A identificação da versão não confere. Atualize a lista antes de visualizar.",
  migration_missing:
    "A persistência de sites ainda não está disponível. Solicite a revisão da configuração ao administrador.",
  read_unavailable:
    "Não foi possível consultar a prévia. Atualize para tentar novamente.",
} as const;
export class StudioPreviewError extends Error {
  constructor(
    public readonly code: keyof typeof messages,
    public readonly status: PreviewStatus,
  ) {
    super(messages[code]);
    this.name = "StudioPreviewError";
  }
}
function database(e: { code?: string } | null) {
  if (!e) return;
  if (
    ["42P01", "42883", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(
      e.code ?? "",
    )
  )
    throw new StudioPreviewError("migration_missing", 503);
  if (e.code === "42501")
    throw new StudioPreviewError("version_unavailable", 403);
  throw new StudioPreviewError("read_unavailable", 503);
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const internalVersion = siteVersionSummarySchema
  .extend({
    owner_id: z.uuid(),
    project_id: z.uuid(),
    site_id: z.uuid(),
    document: z.unknown(),
  })
  .strip();
const versionColumns =
  "id,job_id,number,brief_version_id,brief_hash,document_hash,created_at";
const scoped = (c: Ctx, table: string, columns: string, project: string) =>
  c
    .get("db")
    .from(table)
    .select(columns)
    .eq("owner_id", c.get("user").id)
    .eq("project_id", project);
async function context(c: Ctx, project: string) {
  const r = await c
    .get("db")
    .from("studio_projects")
    .select("id,head_id")
    .eq("owner_id", c.get("user").id)
    .eq("id", project)
    .maybeSingle();
  database(r.error);
  if (!r.data) throw new StudioPreviewError("version_unavailable", 404);
  const p = z
    .object({ id: z.uuid(), head_id: z.uuid().nullable() })
    .safeParse(r.data);
  if (!p.success || p.data.id !== project)
    throw new StudioPreviewError("read_unavailable", 503);
  const site = await scoped(
    c,
    "studio_sites",
    "id,head_version_id",
    project,
  ).maybeSingle();
  database(site.error);
  const s = z
    .object({ id: z.uuid(), head_version_id: z.uuid().nullable() })
    .nullable()
    .safeParse(site.data);
  if (!s.success) throw new StudioPreviewError("read_unavailable", 503);
  return {
    site_id: s.data?.id ?? null,
    current_version_id: s.data?.head_version_id ?? null,
    current_brief_version_id: p.data.head_id,
  };
}
export async function loadStudioPreviewVersion(
  c: Ctx,
  project: string,
  id: string,
  expected: string,
) {
  const current = await context(c, project);
  const r = await scoped(
    c,
    "studio_site_versions",
    `${versionColumns},owner_id,project_id,site_id,document`,
    project,
  )
    .eq("id", id)
    .maybeSingle();
  database(r.error);
  if (!r.data) throw new StudioPreviewError("version_unavailable", 404);
  const parsed = internalVersion.safeParse(r.data);
  if (!parsed.success) throw new StudioPreviewError("invalid_document", 422);
  const row = parsed.data;
  if (
    row.id !== id ||
    row.owner_id !== c.get("user").id ||
    row.project_id !== project ||
    row.site_id !== current.site_id
  )
    throw new StudioPreviewError("version_unavailable", 404);
  if (row.document_hash !== expected)
    throw new StudioPreviewError("preview_changed", 409);
  // The existing immutable JSONB/hash CHECK and composite FKs are authoritative.
  // Do not recalculate a PostgreSQL JSONB hash with JSON.stringify in JS.
  let document;
  try {
    document = validatePreviewDocument(row.document);
  } catch (e) {
    if (e instanceof InvalidPreviewDocument)
      throw new StudioPreviewError("invalid_document", 422);
    throw e;
  }
  return {
    document,
    version: siteVersionSummarySchema.strip().parse(row),
    current_version_id: current.current_version_id,
    current_brief_version_id: current.current_brief_version_id,
  };
}
export const isStudioPreviewFramePath = (path: string) =>
  /^\/api\/studio\/projects\/[^/]+\/site-preview\/versions\/[^/]+\/frame$/.test(
    path,
  );
function send(
  c: Ctx,
  rendered: ReturnType<typeof renderSitePreview>,
  status: PreviewStatus | 200,
) {
  // The API defaults to X-Frame-Options: DENY. Only this controlled HTML route
  // permits framing, restricted to same-origin ancestors by its own CSP.
  c.header("X-Frame-Options", undefined);
  for (const [key, value] of Object.entries(previewHeaders(rendered.csp)))
    c.header(key, value);
  return c.html(rendered.html, status);
}
export function previewFrameError(c: Ctx, status: number) {
  const safe: PreviewStatus = [400, 401, 403, 404, 409, 422].includes(status)
    ? (status as PreviewStatus)
    : 503;
  return send(c, renderPreviewError(safe), safe);
}
export function registerStudioPreviewRoutes(app: Hono<ApiEnv>) {
  // Existing /api/studio/* middleware verifies Auth and active membership.
  const base = "/api/studio/projects/:id/site-preview";
  app.get(`${base}/versions`, async (c) => {
    const project = z.uuid().parse(c.req.param("id")),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .parse(c.req.query("offset") ?? 0);
    const current = await context(c, project);
    const r = await scoped(c, "studio_site_versions", versionColumns, project)
      .order("number", { ascending: false })
      .range(offset, offset + 20);
    database(r.error);
    const parsed = z
      .array(siteVersionSummarySchema)
      .safeParse((r.data ?? []).slice(0, 20));
    if (!parsed.success) throw new StudioPreviewError("read_unavailable", 503);
    return c.json({
      versions: parsed.data,
      current_version_id: current.current_version_id,
      current_brief_version_id: current.current_brief_version_id,
      has_more: (r.data ?? []).length > 20,
    });
  });
  const selected = async (c: Ctx) =>
    loadStudioPreviewVersion(
      c,
      z.uuid().parse(c.req.param("id")),
      z.uuid().parse(c.req.param("versionId")),
      hash.parse(c.req.query("document_hash")),
    );
  app.get(`${base}/versions/:versionId`, async (c) => {
    const { document, ...metadata } = await selected(c);
    return c.json({
      ...metadata,
      visual_hash: await siteVisualHash(renderSiteVisual(document)),
    });
  });
  app.get(`${base}/versions/:versionId/frame`, async (c) => {
    const selectedVersion = await selected(c);
    const visualHash = await siteVisualHash(
      renderSiteVisual(selectedVersion.document),
    );
    const expectedVisual = c.req.query("visual_hash");
    if (
      expectedVisual !== undefined &&
      hash.parse(expectedVisual) !== visualHash
    )
      throw new StudioPreviewError("preview_changed", 409);
    c.header("X-Studio-Visual-SHA256", visualHash);
    c.header("X-Studio-Site-Version", selectedVersion.version.id);
    c.header("X-Studio-Document-Hash", selectedVersion.version.document_hash);
    return send(c, renderSitePreview(selectedVersion.document), 200);
  });
}
