import type {
  SiteDocumentProvider,
  SiteProviderRequest,
  SiteProviderOutput,
} from "./provider";
// Explicit test dependency only. No auto-generated companies, network, API key,
// env switch or fallback. Tests must supply their own clearly synthetic fixture.
export class MockSiteDocumentProvider implements SiteDocumentProvider {
  #respond: (
    request: SiteProviderRequest,
    signal: AbortSignal,
  ) => SiteProviderOutput | Promise<SiteProviderOutput>;
  constructor(
    respond: (
      request: SiteProviderRequest,
      signal: AbortSignal,
    ) => SiteProviderOutput | Promise<SiteProviderOutput>,
  ) {
    this.#respond = respond;
  }
  async generate(request: SiteProviderRequest, signal: AbortSignal) {
    return this.#respond(request, signal);
  }
}
