import { describe, expect, it } from "vitest";
import {
  renderSitePreview,
  renderPreviewError,
  previewHeaders,
  validatePreviewDocument,
  InvalidPreviewDocument,
} from "../server/studio-preview-renderer";
import { previewFixture } from "./fixtures/studio-preview";
import { siteDocumentSchema } from "../shared/studio-sites";

describe("trusted document renderer", () => {
  it("renders the existing identity/pages and all five allowed components", () => {
    const doc = previewFixture(),
      { html } = renderSitePreview(doc);
    expect(siteDocumentSchema.safeParse(doc).success).toBe(true);
    for (const text of [
      doc.identity.business_name,
      doc.identity.tagline!,
      "Uma presença digital com personalidade.",
      "Sobre a demonstração",
      "Construída em cada detalhe.",
      "Identidade",
      "Conteúdo",
      "Experiência",
    ])
      expect(html).toContain(text);
    for (const type of ["hero", "text", "cards", "cta", "contact"])
      expect(html).toContain(`type-${type}`);
    expect(html).toContain('id="p-about"');
    expect(html).toContain('href="#p-about"');
    expect(html).toContain('href="#p-home--s-services"');
    expect(html).toContain("--primary:#438BFF");
    expect(html).toContain("--heading-font:system-ui");
    expect(html).toContain("--body-font:Georgia");
    expect(html).toContain("--radius:8px");
  });
  it("escapes entity-looking text and quotes without interpreting markup", () => {
    const doc = previewFixture();
    doc.pages[0].title = 'Aspas " & &lt;script&gt;';
    doc.pages[0].sections[0].heading = "&lt;img src=x onerror=alert(1)&gt;";
    const { html } = renderSitePreview(doc);
    expect(html).toContain("Aspas &quot; &amp; &amp;lt;script&amp;gt;");
    expect(html).toContain("&amp;lt;img src=x onerror=alert(1)&amp;gt;");
    expect(html).not.toMatch(/<(script|img|iframe|object|embed|form|input)\b/i);
  });
  it("does not emit external/contact destinations or network resources", () => {
    const { html, csp } = renderSitePreview(previewFixture());
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Página de referência");
    expect(html).toContain("E-mail");
    for (const value of [
      "https://example.com",
      "mailto:",
      "tel:",
      "<img",
      "<script",
      "<iframe",
      "<link",
      "<base",
      "url(",
      "@import",
    ])
      expect(html).not.toContain(value);
    for (const href of html.matchAll(/\bhref="([^"]*)"/g))
      expect(href[1]).toMatch(/^#p-[a-z0-9-]+$/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("; sandbox");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });
  it("uses a fresh nonce for only the trusted stylesheet and sets restrictive headers", () => {
    const a = renderSitePreview(previewFixture()),
      b = renderSitePreview(previewFixture());
    const nonce = a.html.match(/<style nonce="([A-Za-z0-9+/=]+)">/)?.[1];
    expect(nonce).toHaveLength(32);
    expect(a.csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(b.csp).not.toBe(a.csp);
    expect(previewHeaders(a.csp)).toMatchObject({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
  });
  it.each(["minimal", "editorial", "bold", "classic"] as const)(
    "maps %s to fixed authored styles, not arbitrary CSS",
    (style) => {
      const doc = previewFixture();
      doc.identity.style = style;
      expect(renderSitePreview(doc).html).toContain(`class="style-${style}"`);
    },
  );
  it("preserves original approved/stored strings after validating instead of substituting Zod transformations", () => {
    const doc = previewFixture();
    doc.pages[0].sections[0].heading = "  Texto original  ";
    expect(validatePreviewDocument(doc)).toBe(doc);
    expect(renderSitePreview(doc).html).toContain(
      "<h1>  Texto original  </h1>",
    );
  });
  it.each(["html", "css", "javascript", "image", "onload"])(
    "rejects unsupported %s fields without weakening the existing schema",
    (key) => {
      expect(() =>
        renderSitePreview({ ...previewFixture(), [key]: "UNTRUSTED" }),
      ).toThrow(InvalidPreviewDocument);
    },
  );
  it("rejects unsafe links/colors, unsupported components and invalid references", () => {
    const bad: unknown[] = [];
    let d = previewFixture();
    d.identity.palette.primary =
      "red; background:url(https://evil.example.com)";
    bad.push(d);
    d = previewFixture();
    const hero = d.pages[0].sections[0];
    if (hero.type === "hero") hero.buttons[0].href = "javascript:alert(1)";
    bad.push(d);
    d = previewFixture();
    d.pages[0].sections[0].heading = "<script>alert(1)</script>";
    bad.push(d);
    d = previewFixture();
    d.pages[0].sections[0].id = 'bad-id" onclick="x';
    bad.push(d);
    bad.push({ ...previewFixture(), pages: [] });
    for (const value of bad)
      expect(() => renderSitePreview(value)).toThrow(InvalidPreviewDocument);
  });
  it("bounds the raw document before validation, including whitespace and cycles", () => {
    const d = previewFixture();
    d.pages[0].sections[0].heading =
      " ".repeat(128 * 1024) + "valid after trim";
    expect(() => renderSitePreview(d)).toThrow(InvalidPreviewDocument);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => renderSitePreview(cyclic)).toThrow(InvalidPreviewDocument);
  });
  it("has responsive layouts and a safe error document without dynamic details", () => {
    const html = renderSitePreview(previewFixture()).html;
    expect(html).toContain("@media(max-width:900px)");
    expect(html).toContain("@media(max-width:600px)");
    expect(html).toContain("prefers-reduced-motion");
    expect(renderPreviewError(422).html).toContain(
      "O documento salvo não é compatível",
    );
    expect(renderPreviewError(401).html).toContain("Entre novamente");
    expect(renderPreviewError(503).html).not.toContain("<script");
  });
});
