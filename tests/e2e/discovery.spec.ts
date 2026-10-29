import { test, expect, type Page } from "@playwright/test";
import type { DiscoveryResult } from "../../shared/discovery";
import type { Lead } from "../../shared/leads";
// All companies below are synthetic fixtures for a simulated HTTP API only.
const id = "11111111-1111-4111-8111-111111111111";
const fixture = (): DiscoveryResult => ({
  id,
  company: "Empresa sintética de teste",
  city: "Passos",
  state: "MG",
  sector: "Serviços",
  contact: "",
  website: "https://company.example.test",
  source_kind: "manual",
  source_name: "Fonte sintética de teste",
  source_url: "https://source.example.test",
  collected_at: "2026-01-01T12:00:00Z",
  created_at: "2026-10-29T12:00:00Z",
  pipeline_match: null,
});
async function mock(page: Page, initial: DiscoveryResult[] = []) {
  const state = {
    results: [...initial],
    leads: [] as Lead[],
    imports: [] as boolean[],
    promotions: 0,
    filters: [] as URLSearchParams[],
    forbidden: false,
    outage: false,
    duplicateOnPromote: false,
    promotionOutage: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    let payload: unknown = {};
    let status = 200;
    if (path === "/api/session")
      payload = {
        configured: true,
        user: { id: "test-user", email: "test@example.test" },
      };
    else if (path === "/api/leads") payload = { leads: state.leads };
    else if (state.forbidden) {
      status = 403;
      payload = { message: "Acesso revogado." };
    } else if (path === "/api/discovery/sources")
      payload = { providers: [], manual: true };
    else if (path === "/api/discovery") {
      state.filters.push(url.searchParams);
      if (state.outage) {
        status = 503;
        payload = { message: "Banco temporariamente indisponível." };
      } else
        payload = {
          results: state.results.filter(
            (row) =>
              (!url.searchParams.get("city") ||
                row.city === url.searchParams.get("city")) &&
              (!url.searchParams.get("state") ||
                row.state === url.searchParams.get("state")) &&
              (!url.searchParams.get("sector") ||
                row.sector.includes(url.searchParams.get("sector")!)),
          ),
        };
    } else if (path === "/api/discovery/import") {
      const input = request.postDataJSON();
      state.imports.push(input.commit);
      const exists = state.results.length > 0;
      if (input.commit && !exists)
        state.results.push({
          ...fixture(),
          ...input.records[0],
          source_name: input.source.name,
          source_url: input.source.url,
          collected_at: input.source.collected_at,
        });
      payload = {
        summary: {
          total: input.records.length,
          created: exists ? 0 : 1,
          duplicates: input.records.length - (exists ? 0 : 1),
          committed: input.commit,
        },
      };
    } else if (path.endsWith("/promote")) {
      state.promotions++;
      if (state.promotionOutage) {
        status = 503;
        payload = { message: "Adição temporariamente indisponível." };
      } else if (state.duplicateOnPromote) {
        payload = { outcome: "duplicate", lead_id: id, archived: true };
        state.results[0].pipeline_match = {
          lead_id: id,
          archived: true,
          linked: false,
        };
      } else {
        const result = state.results[0];
        result.pipeline_match = { lead_id: id, archived: false, linked: true };
        state.leads = [
          {
            id,
            company: result.company,
            city: `${result.city}, ${result.state}`,
            sector: result.sector,
            contact: result.contact,
            site: "unknown",
            status: "Novo",
            notes: "",
            source: "manual",
            legacy_id: null,
            version: 1,
            created_at: result.created_at,
            updated_at: result.created_at,
            deleted_at: null,
            discovery_origin: { discovery_result_id: id, result },
          },
        ];
        payload = { outcome: "added", lead_id: id, archived: false };
      }
    } else {
      status = 404;
      payload = { message: "not found" };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
  return state;
}
test("shows an honest empty page, filters and responsive navigation", async ({
  page,
}, testInfo) => {
  const state = await mock(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "Descobrir empresas", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(
    page.getByRole("heading", { name: "Descobrir empresas." }),
  ).toBeVisible();
  await expect(
    page.getByText("Nenhuma fonte externa configurada.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Cidade", { exact: true })).toHaveValue(
    "Passos",
  );
  await expect(page.getByLabel("Estado (UF)")).toHaveValue("MG");
  await page.screenshot({
    path: testInfo.outputPath("discovery.png"),
    fullPage: true,
  });
  await page.getByLabel("Cidade", { exact: true }).fill("Outra cidade");
  await page.getByLabel("Estado (UF)").selectOption("SP");
  await page.getByLabel("Segmento", { exact: true }).fill("Marcenaria");
  await page.getByRole("button", { name: "Filtrar resultados" }).click();
  await expect
    .poll(() => state.filters.at(-1)?.get("city"))
    .toBe("Outra cidade");
  expect(state.filters.at(-1)?.get("state")).toBe("SP");
  expect(state.filters.at(-1)?.get("sector")).toBe("Marcenaria");
  await expect(
    page.getByRole("heading", { name: "Nenhuma empresa nesta seleção" }),
  ).toBeVisible();
  expect(state.imports).toEqual([]);
  expect(state.promotions).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Ver pipeline" }).click();
  await expect(
    page.getByRole("heading", { name: "Pipeline de prospecção" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Descobrir empresas." }),
  ).toBeVisible();
});
test("imports only after preview and promotes only after explicit confirmation, retaining origin after reload", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/discover");
  await page
    .getByRole("button", { name: "Importar resultados", exact: true })
    .click();
  await page.getByLabel("Nome da empresa").fill(fixture().company);
  await page.getByLabel("Segmento da empresa").fill("Serviços");
  await page.getByLabel("Fonte dos dados").fill(fixture().source_name);
  await page
    .getByLabel("URL pública da fonte (opcional)")
    .fill(fixture().source_url);
  await page.getByLabel("Data e hora da coleta").fill("2026-01-01T12:00");
  await page.getByRole("button", { name: "Revisar importação" }).click();
  await expect(page.getByText("Revise antes de importar")).toBeVisible();
  expect(state.imports).toEqual([false]);
  expect(state.results).toHaveLength(0);
  await page.getByRole("button", { name: "Confirmar importação" }).click();
  await expect(page.getByText("Importação concluída")).toBeVisible();
  expect(state.imports).toEqual([false, true]);
  expect(state.leads).toHaveLength(0);
  await page.getByRole("button", { name: "Concluir", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: fixture().company, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Adicionar ao pipeline", exact: true })
    .click();
  expect(state.promotions).toBe(0);
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect(state.promotions).toBe(0);
  await page
    .getByRole("button", { name: "Adicionar ao pipeline", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirmar adição" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Oportunidade adicionada",
  );
  expect(state.promotions).toBe(1);
  await expect(
    page.getByRole("button", { name: "Registro já existente" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Ver pipeline" }).click();
  await expect(page.getByText(/Fonte: Fonte sintética de teste/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: fixture().company, exact: true }),
  ).toBeVisible();
  expect(state.leads[0]).toMatchObject({ site: "unknown", status: "Novo" });
});
test("validates JSON before preview and reports duplicates without replacing data", async ({
  page,
}) => {
  const state = await mock(page, [fixture()]);
  await page.goto("/discover");
  await page
    .getByRole("button", { name: "Importar resultados", exact: true })
    .click();
  await page.getByRole("button", { name: "Arquivo JSON", exact: true }).click();
  await page.getByLabel("Arquivo de resultados JSON").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('[{"company":22}]'),
  });
  await expect(page.getByRole("alert")).toContainText("Importação inválida");
  expect(state.imports).toEqual([]);
  const { company, city, sector, contact, website } = fixture();
  await page.getByLabel("Arquivo de resultados JSON").setInputFiles({
    name: "synthetic-test.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        { company, city, state: "MG", sector, contact, website },
      ]),
    ),
  });
  await page.getByLabel("Fonte dos dados").fill("Outra fonte de teste");
  await page.getByLabel("Data e hora da coleta").fill("2026-01-01T12:00");
  await page.getByRole("button", { name: "Revisar importação" }).click();
  await expect(page.getByText(/1 duplicata\(s\) ignorada/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar importação" }),
  ).toBeDisabled();
  expect(state.results[0].source_name).toBe(fixture().source_name);
  expect(state.imports).toEqual([false]);
});
test("rechecks a late duplicate and identifies archived opportunities without a false success", async ({
  page,
}) => {
  const state = await mock(page, [fixture()]);
  state.duplicateOnPromote = true;
  await page.goto("/discover");
  await page
    .getByRole("button", { name: "Adicionar ao pipeline", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirmar adição" }).click();
  await expect(page.getByRole("status")).toContainText("já existe na lixeira");
  await expect(
    page.getByText(
      "Possível duplicata na lixeira. Revise o cadastro existente.",
    ),
  ).toBeVisible();
  expect(state.leads).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Registro já existente" }),
  ).toBeDisabled();
});
test("shows unavailable data as a failure with retry and closes revoked sessions", async ({
  page,
}) => {
  const state = await mock(page);
  state.outage = true;
  await page.goto("/discover");
  await expect(
    page.getByRole("heading", {
      name: "Não foi possível carregar os resultados",
    }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("indisponível");
  await page.getByLabel("Cidade", { exact: true }).fill("Outra cidade");
  await page.getByRole("button", { name: "Filtrar resultados" }).click();
  await expect
    .poll(() => state.filters.at(-1)?.get("city"))
    .toBe("Outra cidade");
  await expect(
    page.getByRole("button", { name: "Atualizar descoberta" }),
  ).toBeEnabled();
  state.outage = false;
  await page.getByRole("button", { name: "Atualizar descoberta" }).click();
  await expect(
    page.getByRole("heading", { name: "Nenhuma empresa nesta seleção" }),
  ).toBeVisible();
  expect(state.filters.at(-1)?.get("city")).toBe("Outra cidade");
  state.forbidden = true;
  await page.getByRole("button", { name: "Atualizar descoberta" }).click();
  await expect(
    page.getByRole("heading", { name: "Entre no seu workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Descobrir empresas." }),
  ).toHaveCount(0);
});

test("displays promotion errors inside the confirmation and allows a safe retry", async ({
  page,
}) => {
  const state = await mock(page, [fixture()]);
  state.promotionOutage = true;
  await page.goto("/discover");
  await page
    .getByRole("button", { name: "Adicionar ao pipeline", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirmar adição" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Adição temporariamente indisponível",
  );
  expect(state.leads).toHaveLength(0);
  state.promotionOutage = false;
  await page.getByRole("button", { name: "Confirmar adição" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "Oportunidade adicionada",
  );
  expect(state.leads).toHaveLength(1);
});
