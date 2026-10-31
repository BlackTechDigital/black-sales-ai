import type { BriefFields } from "../../shared/studio";
import type { SiteDocument } from "../../shared/studio-sites";

// Synthetic fixtures only. This module is also consumed by Node 24's native
// type stripping in the isolated PostgreSQL concurrency harness.
export const alice = "11111111-1111-4111-8111-111111111111";
export const bob = "22222222-2222-4222-8222-222222222222";
export function briefFixture(): BriefFields {
  const fields = Object.fromEntries(
    [
      "company",
      "sector",
      "city",
      "services",
      "audience",
      "differentiators",
      "visual_identity",
      "colors",
      "site_style",
      "visual_references",
      "features",
      "contacts",
      "creative_notes",
    ].map((key) => [
      key,
      { value: "", source: "", verification: "pending", public_use: false },
    ]),
  ) as BriefFields;
  for (const key of [
    "company",
    "sector",
    "city",
    "services",
    "audience",
  ] as const)
    fields[key] = {
      value:
        key === "company" ? "Empresa sintética de teste" : `Fixture: ${key}`,
      source: "Declaração sintética",
      verification: "verified",
      public_use: true,
    };
  fields.contacts = {
    value: "Contato privado sintético",
    source: "Documento interno",
    verification: "verified",
    public_use: false,
  };
  fields.creative_notes = {
    value: "Nota privada sintética",
    source: "Diretor",
    verification: "verified",
    public_use: false,
  };
  return fields;
}
export function documentFixture(): SiteDocument {
  const visual = {
    alignment: "left",
    width: "contained",
    spacing: "comfortable",
    surface: "base",
  } as const;
  return {
    schema_version: 1,
    identity: {
      business_name: "Empresa sintética de teste",
      palette: {
        background: "#080C14",
        foreground: "#EDF3FF",
        primary: "#438BFF",
        accent: "#72A7FF",
      },
      typography: { heading: "system-sans", body: "system-serif" },
      style: "editorial",
      corners: "subtle",
    },
    pages: [
      {
        id: "home",
        path: "/",
        title: "Título sintético",
        description: "Descrição sintética",
        sections: [
          {
            id: "intro",
            type: "hero",
            heading: "Empresa sintética de teste",
            body: "Apresentação sintética",
            buttons: [
              {
                label: "Ver serviços",
                href: "#services",
                appearance: "primary",
              },
            ],
            visual,
          },
          {
            id: "services",
            type: "text",
            heading: "Serviços de teste",
            paragraphs: ["Conteúdo sintético de teste"],
            visual,
          },
          {
            id: "cards",
            type: "cards",
            heading: "Itens sintéticos",
            columns: "two",
            items: [{ title: "Item", body: "Descrição de teste" }],
            visual,
          },
          {
            id: "cta",
            type: "cta",
            heading: "Chamada de teste",
            buttons: [
              {
                label: "Página de referência",
                href: "https://example.com",
                appearance: "secondary",
              },
            ],
            visual,
          },
          {
            id: "contact",
            type: "contact",
            heading: "Contato de teste",
            buttons: [
              {
                label: "E-mail",
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
export const persistenceMigration = "202610310004_site_persistence.sql";
export const previousMigrations = [
  "202610290001_foundation.sql",
  "202610290002_discovery.sql",
  "202610290003_studio.sql",
];
export const authBootstrap = `create role anon; create role authenticated; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`;
