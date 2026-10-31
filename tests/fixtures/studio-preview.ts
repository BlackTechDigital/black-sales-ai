import type { SiteDocument } from "../../shared/studio-sites";
import { documentFixture } from "./site-persistence";
// Explicitly synthetic, never seeded into the application or sent to an API.
export function previewFixture(): SiteDocument {
  const doc = documentFixture();
  doc.identity.tagline = "Demonstração visual — conteúdo sintético";
  const home = doc.pages[0];
  home.title = "Início";
  const hero = home.sections[0];
  if (hero.type === "hero") {
    hero.eyebrow = "Direção criativa · demonstração";
    hero.heading = "Uma presença digital com personalidade.";
    hero.body =
      "Uma composição de teste para revisar identidade, conteúdo e experiência em diferentes telas.";
    hero.visual.spacing = "generous";
    hero.buttons.push({
      label: "Conhecer a proposta",
      href: "/sobre",
      appearance: "secondary",
    });
  }
  const cards = home.sections[2];
  if (cards.type === "cards") {
    cards.columns = "three";
    cards.heading = "Construída em cada detalhe.";
    cards.intro =
      "Itens ilustrativos de uma demonstração, sem afirmações sobre empresas reais.";
    cards.items = [
      {
        title: "Identidade",
        body: "Cores, tipografia e composição coerentes com o documento.",
      },
      {
        title: "Conteúdo",
        body: "Textos organizados com hierarquia e clareza.",
      },
      {
        title: "Experiência",
        body: "Estrutura responsiva para diferentes tamanhos de tela.",
      },
    ];
    cards.visual.surface = "muted";
  }
  doc.pages.push({
    id: "about",
    path: "/sobre",
    title: "Sobre",
    description: "Página sintética adicional para testar navegação.",
    sections: [
      {
        id: "about-hero",
        type: "hero",
        heading: "Sobre a demonstração",
        body: "Esta página faz parte do mesmo documento sintético selecionado.",
        buttons: [
          {
            label: "Voltar aos serviços",
            href: "/#services",
            appearance: "primary",
          },
        ],
        visual: {
          alignment: "center",
          width: "contained",
          spacing: "comfortable",
          surface: "base",
        },
      },
    ],
  });
  return doc;
}
