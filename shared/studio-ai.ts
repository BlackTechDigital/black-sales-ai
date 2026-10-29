import type { BriefKey, BriefVersion, ProjectMode } from "./studio";
// Future contracts only. No provider, network call, generated output or executor.
export interface StudioAIProvider {
  id: string;
  capabilities: readonly ("visual_concepts" | "site_code" | "code_patch")[];
  generate(
    request: StudioAIRequest,
    signal: AbortSignal,
  ): Promise<StudioAIProposal>;
}
export interface StudioAIRequest {
  projectId: string;
  approvedVersionId: string;
  contentHash: string;
  mode: ProjectMode;
  publicInformation: Partial<Record<BriefKey, string>>;
}
export interface StudioAIProposal {
  baseVersionId: string;
  requiresHumanReview: true;
  content: unknown;
}
// Call only with data reloaded by the server under verified project ownership.
// A browser-supplied object is not evidence of authorization or approval.
export function publicBriefContext(
  version: BriefVersion,
  mode: ProjectMode,
): Pick<
  StudioAIRequest,
  "approvedVersionId" | "contentHash" | "mode" | "publicInformation"
> {
  if (
    !version.approval ||
    version.approval.version_id !== version.id ||
    version.approval.content_hash !== version.content_hash
  )
    throw new Error("O briefing precisa de aprovação da versão exata.");
  const publicInformation = Object.fromEntries(
    Object.entries(version.fields)
      .filter(
        ([key, f]) =>
          key !== "creative_notes" &&
          f.public_use &&
          f.value &&
          (f.verification === "verified" ||
            (mode === "demo" && f.verification === "fictional")),
      )
      .map(([key, f]) => [key, f.value]),
  );
  return {
    approvedVersionId: version.id,
    contentHash: version.content_hash,
    mode,
    publicInformation,
  };
}
