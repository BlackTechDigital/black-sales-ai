import {
  SITE_LIMITS,
  siteDocumentSchema,
  type SiteDocument,
  type SiteSection,
  type SiteButton,
  type SitePage,
} from "../shared/studio-sites";
import { textSha256 } from "./studio-digests";

export class InvalidPreviewDocument extends Error {
  constructor() {
    super("O documento salvo não é compatível com a prévia segura.");
    this.name = "InvalidPreviewDocument";
  }
}
export function validatePreviewDocument(value: unknown): SiteDocument {
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
        SITE_LIMITS.documentBytes ||
      !siteDocumentSchema.safeParse(value).success
    )
      throw new InvalidPreviewDocument();
    // Preserve the original JSONB values bound to document_hash. Zod may trim
    // text when validating; do not substitute that transformed copy here.
    return value as SiteDocument;
  } catch {
    throw new InvalidPreviewDocument();
  }
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const pageId = (page: SitePage) => `p-${page.id}`;
const sectionId = (page: SitePage, id: string) => `${pageId(page)}--s-${id}`;
function button(b: SiteButton, page: SitePage, document: SiteDocument) {
  const classes = `button button-${b.appearance}`;
  if (!b.href.startsWith("#") && !b.href.startsWith("/"))
    return `<span class="${classes} disabled-link" role="link" aria-disabled="true" title="Link externo desativado nesta prévia">${escape(b.label)}<span class="sr-only"> — link externo desativado na prévia</span></span>`;
  const [path, anchor] = b.href.startsWith("#")
    ? [page.path, b.href.slice(1)]
    : b.href.split("#");
  const target = document.pages.find((p) => p.path === path)!;
  return `<a class="${classes}" href="#${anchor ? sectionId(target, anchor) : pageId(target)}">${escape(b.label)}</a>`;
}
function section(s: SiteSection, page: SitePage, document: SiteDocument) {
  const v = s.visual;
  let content: string;
  const text = (value: string) => `<p>${escape(value)}</p>`;
  const buttons = (values: SiteButton[]) =>
    `<div class="buttons">${values.map((b) => button(b, page, document)).join("")}</div>`;
  switch (s.type) {
    case "hero":
      content = `${s.eyebrow ? `<p class="eyebrow">${escape(s.eyebrow)}</p>` : ""}<h1>${escape(s.heading)}</h1>${text(s.body)}${buttons(s.buttons)}`;
      break;
    case "text":
      content = `<h2>${escape(s.heading)}</h2>${s.paragraphs.map(text).join("")}`;
      break;
    case "cards":
      content = `<h2>${escape(s.heading)}</h2>${s.intro ? text(s.intro) : ""}<div class="cards columns-${s.columns}">${s.items.map((item, i) => `<article class="card"><span class="card-number" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><h3>${escape(item.title)}</h3>${text(item.body)}</article>`).join("")}</div>`;
      break;
    case "cta":
    case "contact":
      content = `<h2>${escape(s.heading)}</h2>${s.body ? text(s.body) : ""}${buttons(s.buttons)}`;
      break;
    default: {
      s satisfies never;
      throw new InvalidPreviewDocument();
    }
  }
  return `<section id="${sectionId(page, s.id)}" class="section type-${s.type} align-${v.alignment} width-${v.width} spacing-${v.spacing} surface-${v.surface}"><div class="section-inner">${content}</div></section>`;
}

// All CSS is authored here. Model values may select enums/hex colors only;
// no model text, URL, selector, CSS declaration, markup or event is interpolated.
const CSS = `
*{box-sizing:border-box}html{scroll-behavior:auto}body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--body-font);line-height:1.65}h1,h2,h3,.brand{font-family:var(--heading-font)}h1,h2,h3,p{overflow-wrap:anywhere;white-space:pre-wrap}h1,h2,h3{line-height:1.12;letter-spacing:-.045em}h1{font-size:clamp(2.4rem,6.5vw,6rem);max-width:1000px;margin:20px 0 30px}h2{font-size:clamp(1.9rem,4vw,3.6rem);margin:0 0 30px}h3{font-size:1.4rem;margin:20px 0 14px}p{max-width:720px;margin:0 0 24px}a{color:inherit}a:focus-visible{outline:3px solid var(--accent);outline-offset:6px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.skip:focus{position:fixed;top:10px;left:10px;width:auto;height:auto;clip-path:none;background:var(--foreground);color:var(--background);padding:12px;z-index:10}
.header{border-bottom:1px solid color-mix(in srgb,var(--foreground) 20%,transparent)}.header-inner{max-width:1280px;margin:auto;padding:26px 42px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:24px}.brand{font-size:1.2rem;font-weight:750;text-decoration:none;max-width:100%;overflow-wrap:anywhere}.tagline{display:block;font-size:.75rem;font-family:var(--body-font);font-weight:400;opacity:.75;max-width:420px;white-space:pre-wrap}.nav{display:flex;flex-wrap:wrap;gap:12px 24px}.nav a{font-size:.9rem;text-decoration:none;border-bottom:1px solid transparent;max-width:280px;overflow-wrap:anywhere}.nav a:hover{border-color:var(--accent)}.page-label{max-width:1280px;margin:auto;padding:30px 42px 0;font-size:.75rem;letter-spacing:.15em;text-transform:uppercase;overflow-wrap:anywhere}.site-page{display:none}.site-page.initial{display:block}body:has(.site-page:target,.site-page :target) .site-page.initial:not(:target):not(:has(:target)){display:none}.site-page:target,.site-page:has(:target){display:block}
.section{scroll-margin-top:24px}.section-inner{max-width:1160px;margin:auto;padding-left:42px;padding-right:42px}.width-wide .section-inner{max-width:1440px}.spacing-compact .section-inner{padding-top:42px;padding-bottom:42px}.spacing-comfortable .section-inner{padding-top:78px;padding-bottom:78px}.spacing-generous .section-inner{padding-top:120px;padding-bottom:120px}.type-hero .section-inner{min-height:540px;display:flex;flex-direction:column;justify-content:center}.type-hero{position:relative;isolation:isolate;overflow:hidden}.type-hero:before{content:"";position:absolute;z-index:-1;width:55%;height:100%;right:0;top:0;background:radial-gradient(ellipse at 70% 30%,color-mix(in srgb,var(--accent) 16%,transparent),transparent 72%)}.eyebrow{color:var(--accent);font-size:.75rem;text-transform:uppercase;letter-spacing:.2em}.align-center{text-align:center}.align-center p,.align-center h1{margin-left:auto;margin-right:auto}.align-center .buttons{justify-content:center}.surface-muted{background:color-mix(in srgb,var(--foreground) 6%,var(--background))}.surface-primary{background:var(--primary);color:var(--background)}.surface-primary .eyebrow{color:inherit}.buttons{display:flex;flex-wrap:wrap;gap:14px;margin-top:22px}.button{display:inline-flex;align-items:center;justify-content:center;text-align:center;max-width:100%;padding:14px 22px;border:1px solid transparent;border-radius:var(--radius);text-decoration:none;font-size:.9rem;font-weight:650;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}.button-primary{background:var(--primary);color:var(--background)}.button-secondary{border-color:currentColor}.button-text{padding-left:0;padding-right:0;text-decoration:underline;text-underline-offset:5px}.surface-primary .button-primary{background:var(--background);color:var(--foreground)}.disabled-link{cursor:default}.cards{display:grid;gap:24px;margin-top:36px}.columns-two{grid-template-columns:repeat(2,minmax(0,1fr))}.columns-three{grid-template-columns:repeat(3,minmax(0,1fr))}.columns-four{grid-template-columns:repeat(4,minmax(0,1fr))}.card{padding:30px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:var(--radius);text-align:left}.card-number{font-size:.8rem;color:var(--accent)}.card p{font-size:.95rem;margin:0}.type-cta,.type-contact{border-top:1px solid color-mix(in srgb,currentColor 18%,transparent)}.footer{max-width:1280px;margin:auto;padding:32px 42px;border-top:1px solid color-mix(in srgb,var(--foreground) 18%,transparent);font-size:.8rem;overflow-wrap:anywhere}
.style-minimal .type-hero:before{display:none}.style-minimal .card{border-width:0;border-top-width:1px;border-radius:0;padding-left:0}.style-editorial h1{font-weight:550;letter-spacing:-.06em}.style-editorial .type-text .section-inner{max-width:900px}.style-bold h1{text-transform:uppercase;font-weight:850}.style-bold .card{border-width:2px}.style-classic h1,.style-classic h2{letter-spacing:-.025em;font-weight:500}.style-classic .header{border-bottom-width:2px}
@media(max-width:900px){.columns-four{grid-template-columns:repeat(2,minmax(0,1fr))}.header-inner,.section-inner{padding-left:30px;padding-right:30px}.page-label,.footer{padding-left:30px;padding-right:30px}.spacing-generous .section-inner{padding-top:88px;padding-bottom:88px}.card{padding:24px}}
@media(max-width:600px){.header-inner{padding:22px;gap:18px}.header-inner>*{width:100%}.nav{gap:10px 18px}.nav a{font-size:.82rem}.section-inner,.page-label,.footer{padding-left:22px;padding-right:22px}.spacing-compact .section-inner{padding-top:32px;padding-bottom:32px}.spacing-comfortable .section-inner{padding-top:52px;padding-bottom:52px}.spacing-generous .section-inner{padding-top:68px;padding-bottom:68px}.type-hero .section-inner{min-height:460px}.cards{grid-template-columns:minmax(0,1fr)}.buttons{gap:12px}.button{padding:13px 18px}.tagline{max-width:100%}h1{margin-top:14px}.card{padding:24px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
function nonce() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
}
function policy(n: string) {
  return `default-src 'none'; script-src 'none'; style-src 'nonce-${n}'; style-src-attr 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox`;
}
export function previewHeaders(csp: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
  };
}
// Shared deterministic visual source for preview and export. Only the trusted
// style delivery/CSP wrapper differs; body and CSS come from this same function.
export function renderSiteVisual(value: unknown) {
  const doc = validatePreviewDocument(value),
    identity = doc.identity;
  const font = {
    "system-sans":
      "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "system-serif": "Georgia,'Times New Roman',serif",
  };
  const radius = { square: "0px", subtle: "8px", rounded: "24px" };
  const variables = `:root{--background:${identity.palette.background};--foreground:${identity.palette.foreground};--primary:${identity.palette.primary};--accent:${identity.palette.accent};--heading-font:${font[identity.typography.heading]};--body-font:${font[identity.typography.body]};--radius:${radius[identity.corners]}}`;
  const home = doc.pages.find((p) => p.path === "/")!;
  const head = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(identity.business_name)} · Prévia</title>`;
  const body = `<body class="style-${identity.style}"><a class="sr-only skip" href="#${pageId(home)}">Pular para o conteúdo</a><header class="header"><div class="header-inner"><a class="brand" href="#${pageId(home)}">${escape(identity.business_name)}${identity.tagline ? `<span class="tagline">${escape(identity.tagline)}</span>` : ""}</a><nav class="nav" aria-label="Páginas do site">${doc.pages.map((p) => `<a href="#${pageId(p)}">${escape(p.title)}</a>`).join("")}</nav></div></header><main>${doc.pages.map((p) => `<article id="${pageId(p)}" class="site-page${p.path === "/" ? " initial" : ""}" aria-label="${escape(p.title)}"><div class="page-label">${escape(p.title)}</div>${p.sections.map((s) => section(s, p, doc)).join("")}</article>`).join("")}</main><footer class="footer">${escape(identity.business_name)}</footer></body>`;
  return { head, body, css: variables + CSS };
}
export function renderSitePreview(value: unknown) {
  const visual = renderSiteVisual(value),
    n = nonce();
  const html =
    visual.head +
    `<style nonce="${n}">${visual.css}</style></head>` +
    visual.body +
    "</html>";
  return { html, csp: policy(n) };
}
export const siteVisualHash = (visual: ReturnType<typeof renderSiteVisual>) =>
  textSha256(JSON.stringify([visual.head, visual.body, visual.css]));
export function renderPreviewError(status: number) {
  const n = nonce();
  const message =
    status === 401 || status === 403
      ? "Entre novamente e reabra a prévia."
      : status === 422
        ? "O documento salvo não é compatível com a prévia segura."
        : "Não foi possível carregar esta versão. Atualize a consulta no Studio.";
  return {
    html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia indisponível</title><style nonce="${n}">body{margin:0;padding:32px;background:#0c1421;color:#edf3ff;font:16px/1.7 system-ui}h1{font-size:24px}</style></head><body><h1>Prévia indisponível</h1><p>${message}</p></body></html>`,
    csp: policy(n),
  };
}
