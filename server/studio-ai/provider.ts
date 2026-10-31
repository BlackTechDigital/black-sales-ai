export interface SiteProviderRequest {
  messages: readonly { role: "system" | "user"; content: string }[];
  schema: Record<string, unknown>;
}
export interface SiteProviderOutput {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface SiteDocumentProvider {
  generate(
    request: SiteProviderRequest,
    signal: AbortSignal,
  ): Promise<SiteProviderOutput>;
}
