import { z } from "zod";
import {
  briefFieldDefinitions,
  type BriefKey,
  type ProjectMode,
} from "./studio";

export const SITE_LIMITS = {
  documentBytes: 128 * 1024,
  pages: 5,
  sectionsPerPage: 12,
  totalSections: 40,
  cardsPerSection: 12,
  paragraphsPerSection: 8,
  buttonsPerSection: 4,
  urlLength: 2048,
} as const;

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      "Use texto simples, sem HTML ou caracteres de controle.",
    );
const identifier = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const pathPattern =
  /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;
const pagePath = z.string().max(160).regex(pathPattern);
const domainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const privateSuffixes = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "test",
  "invalid",
  "onion",
];
function publicHost(host: string): boolean {
  return (
    domainPattern.test(host) &&
    !privateSuffixes.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  );
}
function safeLink(value: string): boolean {
  if (
    /[\s\\<>"'`\u0000-\u001f\u007f]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return false;
  if (value.startsWith("#")) return identifierPattern.test(value.slice(1));
  if (value.startsWith("/")) {
    const [path, anchor, extra] = value.split("#");
    return (
      path.length <= 160 &&
      pathPattern.test(path) &&
      extra === undefined &&
      (anchor === undefined || identifierPattern.test(anchor))
    );
  }
  if (value.startsWith("tel:")) return /^tel:\+?[0-9]{8,15}$/.test(value);
  if (value.startsWith("mailto:")) {
    const address = value.slice(7);
    return (
      !/[?%#]/.test(address) &&
      z.email().safeParse(address).success &&
      publicHost(address.split("@")[1])
    );
  }
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      publicHost(url.hostname)
    );
  } catch {
    return false;
  }
}
// URL validation is not authorization to fetch. Future network clients must
// independently defend against DNS rebinding, private addresses and redirects.
export const siteLinkSchema = z
  .string()
  .min(1)
  .max(SITE_LIMITS.urlLength)
  .refine(
    safeLink,
    "Use link interno, HTTPS público, mailto simples ou tel válido.",
  );
export const siteButtonSchema = z
  .object({
    label: plainText(80),
    href: siteLinkSchema,
    appearance: z.enum(["primary", "secondary", "text"]),
  })
  .strict();
export const siteVisualOptionsSchema = z
  .object({
    alignment: z.enum(["left", "center"]),
    width: z.enum(["contained", "wide"]),
    spacing: z.enum(["compact", "comfortable", "generous"]),
    surface: z.enum(["base", "muted", "primary"]),
  })
  .strict();
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor hexadecimal #RRGGBB.");
export const siteIdentitySchema = z
  .object({
    business_name: plainText(100),
    tagline: plainText(160).optional(),
    palette: z
      .object({
        background: color,
        foreground: color,
        primary: color,
        accent: color,
      })
      .strict(),
    typography: z
      .object({
        heading: z.enum(["system-sans", "system-serif"]),
        body: z.enum(["system-sans", "system-serif"]),
      })
      .strict(),
    style: z.enum(["minimal", "editorial", "bold", "classic"]),
    corners: z.enum(["square", "subtle", "rounded"]),
  })
  .strict();
const sectionBase = {
  id: identifier,
  heading: plainText(160),
  visual: siteVisualOptionsSchema,
};
export const siteSectionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sectionBase,
      type: z.literal("hero"),
      eyebrow: plainText(80).optional(),
      body: plainText(2000),
      buttons: z.array(siteButtonSchema).max(2),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal("text"),
      paragraphs: z
        .array(plainText(2000))
        .min(1)
        .max(SITE_LIMITS.paragraphsPerSection),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal("cards"),
      intro: plainText(1000).optional(),
      columns: z.enum(["two", "three", "four"]),
      items: z
        .array(
          z.object({ title: plainText(100), body: plainText(1000) }).strict(),
        )
        .min(1)
        .max(SITE_LIMITS.cardsPerSection),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal("cta"),
      body: plainText(1000).optional(),
      buttons: z.array(siteButtonSchema).min(1).max(2),
    })
    .strict(),
  z
    .object({
      ...sectionBase,
      type: z.literal("contact"),
      body: plainText(1000).optional(),
      buttons: z
        .array(siteButtonSchema)
        .min(1)
        .max(SITE_LIMITS.buttonsPerSection),
    })
    .strict(),
]);
export const sitePageSchema = z
  .object({
    id: identifier,
    path: pagePath,
    title: plainText(80),
    description: plainText(320),
    sections: z
      .array(siteSectionSchema)
      .min(1)
      .max(SITE_LIMITS.sectionsPerPage),
  })
  .strict()
  .superRefine((page, ctx) => {
    const seen = new Set<string>();
    page.sections.forEach((section, index) => {
      if (seen.has(section.id))
        ctx.addIssue({
          code: "custom",
          path: ["sections", index, "id"],
          message: "Identificador de seção repetido nesta página.",
        });
      seen.add(section.id);
    });
    if (
      page.sections[0]?.type !== "hero" ||
      page.sections.filter((section) => section.type === "hero").length !== 1
    )
      ctx.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Cada página deve começar com sua única seção hero.",
      });
  });
export const siteDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    identity: siteIdentitySchema,
    pages: z.array(sitePageSchema).min(1).max(SITE_LIMITS.pages),
  })
  .strict()
  .superRefine((document, ctx) => {
    const paths = new Set<string>();
    const ids = new Set<string>();
    document.pages.forEach((page, index) => {
      if (paths.has(page.path))
        ctx.addIssue({
          code: "custom",
          path: ["pages", index, "path"],
          message: "Caminho de página repetido.",
        });
      if (ids.has(page.id))
        ctx.addIssue({
          code: "custom",
          path: ["pages", index, "id"],
          message: "Identificador de página repetido.",
        });
      paths.add(page.path);
      ids.add(page.id);
      page.sections.forEach((section, sectionIndex) => {
        if (!("buttons" in section)) return;
        section.buttons.forEach((button, buttonIndex) => {
          if (!button.href.startsWith("#") && !button.href.startsWith("/"))
            return;
          const [path, anchor] = button.href.startsWith("#")
            ? [page.path, button.href.slice(1)]
            : button.href.split("#");
          const target = document.pages.find(
            (candidate) => candidate.path === path,
          );
          if (
            !target ||
            (anchor !== undefined &&
              !target.sections.some((candidate) => candidate.id === anchor))
          )
            ctx.addIssue({
              code: "custom",
              path: [
                "pages",
                index,
                "sections",
                sectionIndex,
                "buttons",
                buttonIndex,
                "href",
              ],
              message: "O destino interno não existe no documento.",
            });
        });
      });
    });
    if (!paths.has("/"))
      ctx.addIssue({
        code: "custom",
        path: ["pages"],
        message: "Inclua a página inicial /.",
      });
    if (
      document.pages.reduce((total, page) => total + page.sections.length, 0) >
      SITE_LIMITS.totalSections
    )
      ctx.addIssue({
        code: "custom",
        path: ["pages"],
        message: `O site aceita até ${SITE_LIMITS.totalSections} seções no total.`,
      });
    if (
      new TextEncoder().encode(JSON.stringify(document)).byteLength >
      SITE_LIMITS.documentBytes
    )
      ctx.addIssue({
        code: "custom",
        message: "O documento deve ter no máximo 128 KB.",
      });
  });
export type SiteDocument = z.infer<typeof siteDocumentSchema>;
export type SitePage = z.infer<typeof sitePageSchema>;
export type SiteSection = z.infer<typeof siteSectionSchema>;
export type SiteButton = z.infer<typeof siteButtonSchema>;
export function parseSiteDocumentText(raw: string): SiteDocument {
  if (new TextEncoder().encode(raw).byteLength > SITE_LIMITS.documentBytes)
    throw new Error("O documento deve ter no máximo 128 KB.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("O documento não contém JSON válido.");
  }
  return siteDocumentSchema.parse(value);
}

// Identifiers from the caller are concurrency expectations, never approval proof.
export const siteGenerationRequestSchema = z
  .object({
    project_id: z.uuid(),
    brief_version_id: z.uuid(),
    brief_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SiteGenerationRequest = z.infer<typeof siteGenerationRequestSchema>;
export const REQUIRED_SITE_PUBLIC_FIELDS = briefFieldDefinitions
  .filter((field) => field.required)
  .map((field) => field.key);
export type SitePublicKey = Exclude<BriefKey, "creative_notes">;
export interface EligibleSiteBrief {
  project_id: string;
  brief_version_id: string;
  approval_id: string;
  brief_hash: string;
  mode: ProjectMode;
  public_information: Partial<Record<SitePublicKey, string>>;
}
export type SiteEligibilityCode =
  | "authentication_required"
  | "invalid_request"
  | "project_unavailable"
  | "brief_changed"
  | "brief_not_approved"
  | "invalid_brief"
  | "insufficient_public_information"
  | "read_unavailable";
export type SiteGenerationEligibility =
  | { eligible: true; context: EligibleSiteBrief }
  | {
      eligible: false;
      code: SiteEligibilityCode;
      message: string;
      missing_fields?: SitePublicKey[];
    };
