import type { z } from "zod";
import { api, ApiError } from "../api";
import {
  previewVersionsSchema,
  previewVersionSchema,
} from "../../shared/studio-preview";
const base = (project: string) =>
  `/studio/projects/${encodeURIComponent(project)}/site-preview/versions`;
async function checked<T>(
  schema: z.ZodType<T>,
  path: string,
  signal?: AbortSignal,
) {
  const parsed = schema.safeParse(await api<unknown>(path, { signal }));
  if (!parsed.success)
    throw new ApiError(
      "Não foi possível validar a identificação da prévia. Atualize a lista.",
      503,
      "read_unavailable",
    );
  return parsed.data;
}
export const previewVersions = (
  project: string,
  offset = 0,
  signal?: AbortSignal,
) =>
  checked(previewVersionsSchema, `${base(project)}?offset=${offset}`, signal);
export const previewVersion = (
  project: string,
  id: string,
  hash: string,
  signal?: AbortSignal,
) =>
  checked(
    previewVersionSchema,
    `${base(project)}/${encodeURIComponent(id)}?${new URLSearchParams({ document_hash: hash })}`,
    signal,
  );
export const previewFramePath = (
  project: string,
  id: string,
  hash: string,
  visualHash?: string,
) =>
  `/api${base(project)}/${encodeURIComponent(id)}/frame?${new URLSearchParams({ document_hash: hash, ...(visualHash ? { visual_hash: visualHash } : {}) })}`;
