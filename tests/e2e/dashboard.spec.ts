import { test, expect, type Page } from "@playwright/test";
import type { Lead, LeadEvent } from "../../shared/leads";
// Browser tests use a simulated HTTP API; PostgreSQL behavior is covered separately by database.test.ts.
const fixture = (): Lead => ({
  id: "11111111-1111-4111-8111-111111111111",
  legacy_id: null,
  company: "Empresa de teste",
  city: "Cidade de teste",
  sector: "Serviços",
  contact: "",
  site: "unknown",
  status: "Novo",
  notes: "Fixture exclusiva de teste.",
  source: "manual",
  created_at: "2026-10-29T12:00:00Z",
  updated_at: "2026-10-29T12:00:00Z",
  deleted_at: null,
  version: 1,
});
async function mockApi(
  page: Page,
  initial: Lead[] = [],
  initiallyAuthenticated = true,
) {
  let leads = [...initial];
  let authenticated = initiallyAuthenticated;
  const events: LeadEvent[] = [];
  const imports: boolean[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    let payload: unknown = {};
    let status = 200;
    if (path === "/api/session")
      payload = {
        configured: true,
        user: authenticated
          ? { id: "test-user", email: "test@example.test" }
          : null,
      };
    else if (path === "/api/login") {
      if (req.postDataJSON().password === "valid-test-password") {
        authenticated = true;
        payload = { user: { id: "test-user", email: "test@example.test" } };
      } else {
        status = 401;
        payload = { message: "Credenciais de teste inválidas." };
      }
    } else if (path === "/api/logout") {
      authenticated = false;
      payload = { message: "Sessão encerrada." };
    } else if (path === "/api/leads" && method === "GET")
      payload = {
        leads: leads.slice(
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("offset") ?? 0) + 200,
        ),
      };
    else if (path === "/api/leads" && method === "POST") {
      const lead = { ...fixture(), ...req.postDataJSON() };
      leads.push(lead);
      payload = { lead };
      status = 201;
    } else if (path === "/api/leads/import") {
      const input = req.postDataJSON();
      imports.push(input.commit);
      if (input.commit && !leads.length)
        leads.push({
          ...fixture(),
          id: "22222222-2222-4222-8222-222222222222",
          legacy_id: input.records[0].id,
          source: "v1_import",
        });
      payload = {
        summary: {
          total: 2,
          created: 1,
          duplicates: 1,
          conflicts: 0,
          conflict_rows: [],
          committed: input.commit,
        },
      };
    } else if (path.endsWith("/history")) payload = { events };
    else if (method === "PATCH") {
      const input = req.postDataJSON();
      leads = leads.map((lead) =>
        lead.id === path.split("/")[3]
          ? {
              ...lead,
              ...input.values,
              version: lead.version + 1,
              deleted_at:
                input.archived === true
                  ? "2026-10-29T13:00:00Z"
                  : input.archived === false
                    ? null
                    : lead.deleted_at,
            }
          : lead,
      );
      const current = leads.find((lead) => lead.id === path.split("/")[3])!;
      events.push({
        id: String(events.length),
        lead_id: current.id,
        action:
          input.archived === true
            ? "archived"
            : input.archived === false
              ? "restored"
              : "updated",
        occurred_at: "2026-10-29T13:00:00Z",
        before_data: null,
        after_data: { ...current },
      });
      payload = { ok: true };
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
  return { imports };
}
test("renders honest setup state and preserves original local data on recovery", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: false, user: null }),
    }),
  );
  const raw =
    '[{"id":"old","company":"  Empresa de teste  ","city":"Cidade de teste","status":"Novo","extra":true}]';
  await page.addInitScript(
    (data) => localStorage.setItem("black_sales_ai_leads_v1", data),
    raw,
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Seu workspace começa aqui" }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Recuperar cópia local da v1" })
    .click();
  await downloadPromise;
  expect(
    await page.evaluate(() => localStorage.getItem("black_sales_ai_leads_v1")),
  ).toBe(raw);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("creates, edits, confirms exclusion and restores a lead", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sua próxima oportunidade começa aqui" }),
  ).toBeVisible();
  await page.screenshot({
    path: `work/dashboard-${test.info().project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Nome da empresa").fill("Empresa de teste");
  await page.getByLabel(/^Cidade/).fill("Cidade de teste");
  await expect(page.getByLabel("Presença digital")).toHaveValue("unknown");
  await page.getByRole("button", { name: "Salvar oportunidade" }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Editar / etapa" }).click();
  await page.getByLabel("Etapa comercial").selectOption("Fechado");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Fechado");
  await page.getByRole("button", { name: "Excluir Empresa de teste" }).click();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Excluir Empresa de teste" }).click();
  await page.getByRole("button", { name: "Confirmar exclusão" }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Lixeira/ }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restaurar", exact: true }).click();
  await page
    .getByRole("button", { name: "Oportunidades", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Oportunidade restaurada",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("requires review to copy a draft and never sends it", async ({ page }) => {
  await mockApi(page, [fixture()]);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Preparar abordagem", exact: true })
    .click();
  const copy = page.getByRole("button", { name: "Copiar mensagem" });
  await expect(copy).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Revisei o texto e os dados antes de copiar.",
    })
    .check();
  await expect(copy).toBeEnabled();
  await page.getByLabel("Mensagem comercial").fill("Texto revisado de teste.");
  await expect(copy).toBeDisabled();
  await page.getByRole("button", { name: "Fechar janela" }).click();
  await expect(page.locator(".status-pill")).toHaveText("Novo");
});
test("previews duplicates and imports only after explicit confirmation", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Importar backup" }).click();
  const data = {
    id: "legacy-test",
    company: "Empresa de teste",
    city: "Cidade de teste",
    status: "Novo",
  };
  await page.getByLabel("Selecionar arquivo JSON").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([data, data])),
  });
  await expect(page.getByText("Duplicidades ignoradas")).toBeVisible();
  expect(state.imports).toEqual([false]);
  const confirm = page.getByRole("button", { name: "Confirmar importação" });
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Revisei a prévia e autorizo adicionar os registros novos.",
    })
    .check();
  await confirm.click();
  await expect(page.getByText("Importação concluída")).toBeVisible();
  expect(state.imports).toEqual([false, true]);
  await page.getByRole("button", { name: "Fechar janela" }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
});
test("rejects invalid backup without sending it and retains existing records", async ({
  page,
}) => {
  const state = await mockApi(page, [fixture()]);
  await page.goto("/");
  await page.getByRole("button", { name: "Importar backup" }).click();
  await page.getByLabel("Selecionar arquivo JSON").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('[{"company":22}]'),
  });
  await expect(page.getByRole("alert")).toContainText("Backup inválido");
  expect(state.imports).toEqual([]);
  await page.getByRole("button", { name: "Fechar janela" }).click();
  await expect(
    page.getByRole("heading", { name: "Empresa de teste", exact: true }),
  ).toBeVisible();
});

test("login errors are visible and logout removes the workspace", async ({
  page,
}) => {
  await mockApi(page, [], false);
  await page.goto("/");
  await page.getByLabel("E-mail", { exact: true }).fill("test@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("invalid-test-password");
  await page.getByRole("button", { name: "Entrar no workspace" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Credenciais de teste inválidas",
  );
  await page.getByLabel("Senha", { exact: true }).fill("valid-test-password");
  await page.getByRole("button", { name: "Entrar no workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Visão geral." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await expect(
    page.getByRole("heading", { name: "Entre no seu workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pipeline de prospecção" }),
  ).toHaveCount(0);
});

test("development server never serves credential files or backend source", async ({
  request,
}) => {
  for (const path of [
    "/.dev.vars.example",
    "/server/index.ts",
    "/supabase/migrations/202610290001_foundation.sql",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain("YOUR_PUBLISHABLE_OR_ANON_KEY");
  }
});
