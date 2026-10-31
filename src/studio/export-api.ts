import { api, ApiError } from "../api";
import {
  siteExportStatusSchema,
  SITE_EXPORT_MAX_BYTES,
  type SiteReviewRequest,
  type SiteExportStatus,
} from "../../shared/studio-export";
const base = (project: string, version: string) =>
  `/studio/projects/${encodeURIComponent(project)}/site-preview/versions/${encodeURIComponent(version)}/export`;
function status(value: unknown) {
  const parsed = siteExportStatusSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      "Não foi possível validar a autorização de exportação.",
      503,
      "read_unavailable",
    );
  return parsed.data;
}
export const siteExportStatus = async (
  project: string,
  version: string,
  hash: string,
  signal?: AbortSignal,
) =>
  status(
    await api(
      `${base(project, version)}/status?${new URLSearchParams({ document_hash: hash })}`,
      { signal },
    ),
  );
export const reviewSiteExport = async (
  project: string,
  version: string,
  input: SiteReviewRequest,
) =>
  status(
    await api(`${base(project, version)}/reviews`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
export async function downloadSiteExport(
  project: string,
  version: string,
  number: number,
  current: SiteExportStatus,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    !current.can_export ||
    !current.review ||
    !current.artifact_hash ||
    !current.visual_hash ||
    current.version_id !== version
  )
    throw new ApiError(
      "Revise esta versão antes de baixar.",
      409,
      "review_required",
    );
  const response = await fetch(`/api${base(project, version)}`, {
    method: "POST",
    signal,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_hash: current.document_hash,
      artifact_hash: current.artifact_hash,
      visual_hash: current.visual_hash,
      review_id: current.review.id,
      confirm: true,
    }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      message?: unknown;
      code?: unknown;
    } | null;
    throw new ApiError(
      typeof data?.message === "string"
        ? data.message
        : "Não foi possível baixar o projeto.",
      response.status,
      typeof data?.code === "string" ? data.code : undefined,
    );
  }
  const archiveHash = response.headers.get("X-Studio-Archive-SHA256"),
    declared = response.headers.get("Content-Length");
  if (
    response.headers.get("Content-Type")?.split(";")[0] !== "application/zip" ||
    response.headers.get("X-Studio-Document-Hash") !== current.document_hash ||
    response.headers.get("X-Studio-Artifact-Hash") !== current.artifact_hash ||
    response.headers.get("X-Studio-Visual-SHA256") !== current.visual_hash ||
    !archiveHash ||
    !/^[a-f0-9]{64}$/.test(archiveHash) ||
    (declared &&
      (!/^\d+$/.test(declared) || Number(declared) > SITE_EXPORT_MAX_BYTES))
  )
    throw new ApiError(
      "O arquivo recebido não corresponde à exportação autorizada.",
      503,
      "invalid_archive",
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError("O arquivo não foi recebido.", 503, "invalid_archive");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SITE_EXPORT_MAX_BYTES)
        throw new ApiError(
          "O arquivo excedeu o limite permitido.",
          503,
          "invalid_archive",
        );
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actual = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  signal?.throwIfAborted();
  if (
    actual !== archiveHash ||
    (declared !== null && Number(declared) !== size)
  )
    throw new ApiError(
      "A integridade do ZIP não foi confirmada. Nenhum download foi iniciado.",
      503,
      "invalid_archive",
    );
  const url = URL.createObjectURL(
      new Blob([bytes.buffer], { type: "application/zip" }),
    ),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `black-sales-site-v${number}-${current.document_hash.slice(0, 12)}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
