import { describe, expect, it } from "vitest";
import {
  parseSiteDocumentText,
  SITE_LIMITS,
  siteDocumentSchema,
  siteLinkSchema,
  sitePageSchema,
  type SiteDocument,
  type SitePage,
} from "../shared/studio-sites";

// Synthetic data for contract tests only. No companies are seeded or fetched.
const visual = {
  alignment: "left",
  width: "contained",
  spacing: "comfortable",
  surface: "base",
} as const;
const button = {
  label: "Conheça os serviços de teste",
  href: "#services",
  appearance: "primary",
} as const;
function fixture(): SiteDocument {
  return {
    schema_version: 1,
    identity: {
      business_name: "Empresa sintética de testes",
      tagline: "Conteúdo exclusivo dos testes",
      palette: {
        background: "#080C14",
        foreground: "#EDF3FF",
        primary: "#438BFF",
        accent: "#72A7FF",
      },
      typography: { heading: "system-serif", body: "system-sans" },
      style: "editorial",
      corners: "subtle",
    },
    pages: [
      {
        id: "home",
        path: "/",
        title: "Página de teste",
        description: "Descrição sintética para validar o contrato.",
        sections: [
          {
            id: "intro",
            type: "hero",
            heading: "Empresa sintética de testes",
            body: "Apresentação informada na fixture.",
            buttons: [button],
            visual,
          },
          {
            id: "services",
            type: "text",
            heading: "Serviços de teste",
            paragraphs: ["Informação sintética declarada no teste."],
            visual,
          },
          {
            id: "details",
            type: "cards",
            heading: "Detalhes informados",
            columns: "two",
            items: [
              {
                title: "Item de teste",
                body: "Descrição fornecida pela fixture.",
              },
            ],
            visual,
          },
          {
            id: "next-step",
            type: "cta",
            heading: "Próximo passo",
            buttons: [{ ...button, href: "#contact" }],
            visual,
          },
          {
            id: "contact",
            type: "contact",
            heading: "Contato de teste",
            buttons: [
              {
                label: "E-mail de teste",
                href: "mailto:test@example.com",
                appearance: "text",
              },
            ],
            visual,
          },
        ],
      },
    ],
  };
}
function simplePage(index: number, sections = 1): SitePage {
  return {
    id: `page-${index}`,
    path: index === 0 ? "/" : `/page-${index}`,
    title: "Página sintética",
    description: "Descrição de teste",
    sections: [
      {
        id: "intro",
        type: "hero",
        heading: "Cabeçalho de teste",
        body: "Texto de teste",
        buttons: [],
        visual,
      },
      ...Array.from({ length: sections - 1 }, (_, i) => ({
        id: `text-${i}`,
        type: "text" as const,
        heading: "Texto de teste",
        paragraphs: ["Parágrafo de teste"],
        visual,
      })),
    ],
  };
}
describe("structured site document", () => {
  it("accepts all five component types with constrained visual identity", () => {
    const document = fixture();
    expect(siteDocumentSchema.parse(document)).toEqual(document);
    expect(parseSiteDocumentText(JSON.stringify(document))).toEqual(document);
  });
  it("accepts multiple pages and resolves page and section links", () => {
    const document = fixture();
    document.pages.push({ ...simplePage(1), path: "/services" });
    document.pages[0].sections[0] = {
      ...document.pages[0].sections[0],
      type: "hero",
      body: "Texto",
      buttons: [{ ...button, href: "/services#intro" }],
    };
    expect(siteDocumentSchema.safeParse(document).success).toBe(true);
  });
  it.each([
    { javascript: "alert(1)" },
    { html: "<script>alert(1)</script>" },
    { approval: { approved: true } },
    { owner_id: "injected" },
    { css: "body {display:none}" },
  ])("rejects executable, authority and unknown root fields %j", (extra) => {
    expect(
      siteDocumentSchema.safeParse({ ...fixture(), ...extra }).success,
    ).toBe(false);
  });
  it("rejects code-like components, arbitrary CSS, attributes and external fonts at every nested boundary", () => {
    const document = fixture();
    for (const patch of [
      { type: "script" },
      { onClick: "alert(1)" },
      { html: "<b>html</b>" },
      { visual: { ...visual, style: "background:url(https://example.com)" } },
      { visual: { ...visual, spacing: "99999px" } },
    ]) {
      const changed = structuredClone(document);
      changed.pages[0].sections[0] = {
        ...changed.pages[0].sections[0],
        ...patch,
      } as (typeof changed.pages)[0]["sections"][number];
      expect(siteDocumentSchema.safeParse(changed).success).toBe(false);
    }
    for (const patch of [
      {
        palette: {
          ...document.identity.palette,
          primary: "red; background:url(x)",
        },
      },
      {
        typography: {
          heading: "https://example.com/font.woff2",
          body: "system-sans",
        },
      },
      { style: "arbitrary" },
    ])
      expect(
        siteDocumentSchema.safeParse({
          ...document,
          identity: { ...document.identity, ...patch },
        }).success,
      ).toBe(false);
  });
  it.each([
    "<script>run()</script>",
    "<img src=x onerror=alert(1)>",
    "Text\u0000hidden",
    " ",
    "x".repeat(101),
  ])(
    "bounds identity text and rejects HTML/control characters: %j",
    (business_name) => {
      const document = fixture();
      document.identity.business_name = business_name;
      expect(siteDocumentSchema.safeParse(document).success).toBe(false);
    },
  );
  it("requires the schema version and all structural identity fields", () => {
    expect(
      siteDocumentSchema.safeParse({ ...fixture(), schema_version: 2 }).success,
    ).toBe(false);
    expect(
      siteDocumentSchema.safeParse({ ...fixture(), identity: {} }).success,
    ).toBe(false);
    expect(
      siteDocumentSchema.safeParse({ ...fixture(), pages: [] }).success,
    ).toBe(false);
  });
  it("limits pages, sections per page and sections across the document", () => {
    const document = fixture();
    document.pages = Array.from({ length: SITE_LIMITS.pages }, (_, i) =>
      simplePage(i),
    );
    expect(siteDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      siteDocumentSchema.safeParse({
        ...document,
        pages: [...document.pages, simplePage(5)],
      }).success,
    ).toBe(false);
    expect(
      sitePageSchema.safeParse(simplePage(0, SITE_LIMITS.sectionsPerPage))
        .success,
    ).toBe(true);
    expect(
      sitePageSchema.safeParse(simplePage(0, SITE_LIMITS.sectionsPerPage + 1))
        .success,
    ).toBe(false);
    expect(
      siteDocumentSchema.safeParse({
        ...document,
        pages: Array.from({ length: 4 }, (_, i) => simplePage(i, 11)),
      }).success,
    ).toBe(false);
    expect(
      siteDocumentSchema.safeParse({
        ...document,
        pages: Array.from({ length: 4 }, (_, i) => simplePage(i, 10)),
      }).success,
    ).toBe(true);
  });
  it("limits paragraphs, cards, buttons and individual copy", () => {
    const document = fixture();
    for (const section of [
      {
        id: "text",
        type: "text",
        heading: "Test",
        visual,
        paragraphs: Array(9).fill("text"),
      },
      {
        id: "cards",
        type: "cards",
        heading: "Test",
        visual,
        columns: "two",
        items: Array(13).fill({ title: "Test", body: "Test" }),
      },
      {
        id: "contact",
        type: "contact",
        heading: "Test",
        visual,
        buttons: Array(5).fill({ ...button, href: "https://example.com" }),
      },
      {
        id: "text",
        type: "text",
        heading: "Test",
        visual,
        paragraphs: ["x".repeat(2001)],
      },
    ])
      expect(
        siteDocumentSchema.safeParse({
          ...document,
          pages: [
            {
              ...document.pages[0],
              sections: [document.pages[0].sections[0], section],
            },
          ],
        }).success,
      ).toBe(false);
  });
  it("rejects duplicate IDs, duplicate paths, unsafe paths and a missing home page", () => {
    const document = fixture();
    expect(
      siteDocumentSchema.safeParse({
        ...document,
        pages: [document.pages[0], document.pages[0]],
      }).success,
    ).toBe(false);
    const extra = simplePage(1);
    extra.id = "home";
    expect(
      siteDocumentSchema.safeParse({
        ...document,
        pages: [...document.pages, extra],
      }).success,
    ).toBe(false);
    document.pages[0].sections[1].id = "intro";
    expect(siteDocumentSchema.safeParse(document).success).toBe(false);
    for (const path of [
      "/../admin",
      "//example.com",
      "/a?key=secret",
      "/%2e%2e/admin",
      "/same/",
      "/HOME",
    ])
      expect(sitePageSchema.safeParse({ ...simplePage(0), path }).success).toBe(
        false,
      );
    expect(
      siteDocumentSchema.safeParse({ ...fixture(), pages: [simplePage(1)] })
        .success,
    ).toBe(false);
  });
  it("requires one hero at the start and valid internal destinations", () => {
    const document = fixture();
    expect(
      sitePageSchema.safeParse({
        ...document.pages[0],
        sections: document.pages[0].sections.slice(1),
      }).success,
    ).toBe(false);
    expect(
      sitePageSchema.safeParse({
        ...document.pages[0],
        sections: [
          ...document.pages[0].sections,
          { ...document.pages[0].sections[0], id: "duplicate-hero" },
        ],
      }).success,
    ).toBe(false);
    for (const href of ["#missing", "/missing", "/#missing"]) {
      const invalid = fixture();
      const hero = invalid.pages[0].sections[0];
      if (hero.type === "hero") hero.buttons[0].href = href;
      expect(siteDocumentSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("bounds UTF-8 bytes for object and JSON input, before parsing oversized JSON", () => {
    expect(() =>
      parseSiteDocumentText(" ".repeat(SITE_LIMITS.documentBytes + 1)),
    ).toThrow("128 KB");
    expect(() => parseSiteDocumentText("{")).toThrow("JSON válido");
    const document = fixture();
    const page = simplePage(0, 10);
    page.sections.forEach((section) => {
      if (section.type === "text")
        section.paragraphs = Array(8).fill("á".repeat(1000));
    });
    document.pages = [page];
    const result = siteDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some((issue) => issue.message.includes("128 KB")),
      ).toBe(true);
    expect(() => parseSiteDocumentText(JSON.stringify(document))).toThrow(
      "128 KB",
    );
  });
});
describe("safe site links", () => {
  it.each([
    "https://example.com",
    "https://www.example.com/path?q=value#part",
    "https://example.com:443",
    "#contact",
    "/",
    "/services",
    "/services#intro",
    "mailto:test+sales@example.com",
    "tel:+5535999999999",
  ])("accepts %s", (href) =>
    expect(siteLinkSchema.safeParse(href).success).toBe(true),
  );
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>x</script>",
    "blob:https://example.com/test",
    "file:///etc/passwd",
    "ftp://example.com",
    "http://example.com",
    "//example.com",
    "/\\evil.com",
    "https://user:secret@example.com",
    "https://example.com:8080",
    "https://localhost",
    "https://app.localhost",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
    "https://[::1]",
    "https://169.254.169.254",
    "https://example.local",
    "https://example.internal",
    "https://example.com\n",
    "https://example.com/%0D%0Aheader",
    'https://example.com/"><script>alert(1)</script>',
    "https://example.com/`code`",
    "mailto:test@example.com?bcc=other@example.com",
    "mailto:test@example.com%0abcc:other@example.com",
    "tel:+5535;ext=123",
    "tel:*123#",
    "#",
    "/x#y#z",
    "https://example.com/" + "x".repeat(2048),
  ])("rejects %s", (href) =>
    expect(siteLinkSchema.safeParse(href).success).toBe(false),
  );
});
