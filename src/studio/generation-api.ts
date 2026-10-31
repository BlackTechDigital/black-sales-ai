import type { z } from "zod";
import { api, ApiError } from "../api";
import {
  generationEligibilitySchema,
  generationHistorySchema,
  generationJobResponseSchema,
  type RequestSiteGeneration,
} from "../../shared/studio-generation";
const base = (project: string) => `/studio/projects/${project}/site-generation`;
async function checked<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const parsed = schema.safeParse(await api<unknown>(path, init));
  if (!parsed.success)
    throw new ApiError(
      "Não foi possível validar o estado da geração. Atualize para consultar novamente.",
      503,
      "read_unavailable",
    );
  return parsed.data;
}
export const generationEligibility = (
  project: string,
  version: string,
  hash: string,
  signal?: AbortSignal,
) =>
  checked(
    generationEligibilitySchema,
    `${base(project)}/eligibility?${new URLSearchParams({ brief_version_id: version, brief_hash: hash })}`,
    { signal },
  );
export const generationHistory = (
  project: string,
  offset = 0,
  signal?: AbortSignal,
) =>
  checked(
    generationHistorySchema,
    `${base(project)}/history?offset=${offset}`,
    { signal },
  );
export const generationJob = (
  project: string,
  id: string,
  signal?: AbortSignal,
) =>
  checked(generationJobResponseSchema, `${base(project)}/jobs/${id}`, {
    signal,
  });
export const requestGeneration = (
  project: string,
  input: RequestSiteGeneration,
) =>
  checked(generationJobResponseSchema, `${base(project)}/jobs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
export const cancelGeneration = (project: string, id: string) =>
  checked(generationJobResponseSchema, `${base(project)}/jobs/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
