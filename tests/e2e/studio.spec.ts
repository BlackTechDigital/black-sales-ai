import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  emptyBrief,
  type BriefFields,
  type BriefVersion,
  type StudioProject,
} from "../../shared/studio";
import type { Lead } from "../../shared/leads";
// Synthetic fixtures and simulated HTTP only; no company is seeded into the app.
const user = "22222222-2222-4222-8222-222222222222";
const lead: Lead = {
  id: "11111111-1111-4111-8111-111111111111",
  company: "Oportunidade sintética de teste",
  city: "Passos",
  sector: "Serviços",
  contact: "Contato sintético",
  site: "unknown",
  status: "Novo",
  notes: "Fixture",
  source: "manual",
  legacy_id: null,
  created_at: "2026-01-01T12:00:00Z",
  updated_at: "2026-01-01T12:00:00Z",
  deleted_at: null,
  version: 1,
};
function version(
  project: string,
  number: number,
  fields = emptyBrief(),
  parent: string | null = null,
): BriefVersion {
  return {
    id: crypto.randomUUID(),
    project_id: project,
    number,
    parent_id: parent,
    fields: structuredClone(fields),
    content_hash: createHash("sha256")
      .update(JSON.stringify(fields))
      .digest("hex"),
    created_at: "2026-10-29T12:00:00Z",
    created_by: user,
    approval: null,
  };
}
async function mock(page: Page) {
  const state = {
    projects: [] as StudioProject[],
    versions: {} as Record<string, BriefVersion[]>,
    creates: [] as Record<string, unknown>[],
    saves: [] as {
      expected_head_id: string;
      fields: BriefFields;
      request_id: string;
    }[],
    approvals: [] as {
      version_id: string;
      content_hash: string;
      confirm: boolean;
    }[],
    stale: false,
    readOutage: false,
    forbidden: false,
    unexpected: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    let data: unknown = {};
    let status = 200;
    if (path === "/api/session")
      data = {
        configured: true,
        user: { id: user, email: "test@example.test" },
      };
    else if (path === "/api/leads") data = { leads: [lead] };
    else if (path.startsWith("/api/studio") && state.forbidden) {
      status = 403;
      data = { message: "Acesso revogado." };
    } else if (
      path.startsWith("/api/studio") &&
      method === "GET" &&
      state.readOutage
    ) {
      status = 503;
      data = { message: "Leitura temporariamente indisponível." };
    } else if (path === "/api/studio/projects" && method === "GET")
      data = {
        projects: state.projects.map((p) => ({
          ...p,
          head_approved: Boolean(state.versions[p.id].at(-1)?.approval),
        })),
      };
    else if (path === "/api/studio/projects" && method === "POST") {
      const body = req.postDataJSON();
      state.creates.push(body);
      const fields = emptyBrief();
      const id = crypto.randomUUID();
      if (body.mode === "opportunity")
        for (const key of ["company", "sector", "city", "contacts"] as const)
          fields[key] = {
            value: key === "contacts" ? lead.contact : lead[key],
            source: "Snapshot sintético da oportunidade",
            verification: "pending",
            public_use: false,
          };
      const v = version(id, 1, fields);
      state.versions[id] = [v];
      state.projects.push({
        id,
        title: body.title,
        mode: body.mode,
        lead_id: body.lead_id,
        lead_snapshot: body.mode === "opportunity" ? { ...lead } : null,
        head_id: v.id,
        created_at: v.created_at,
      });
      data = { project_id: id, version_id: v.id };
      status = 201;
    } else if (path.startsWith("/api/studio/projects/")) {
      const parts = path.split("/"),
        id = parts[4],
        action = parts[5];
      const project = state.projects.find((p) => p.id === id)!;
      const versions = state.versions[id];
      if (method === "GET" && action === "versions" && !parts[6])
        data = {
          versions: [...versions]
            .reverse()
            .slice(
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("offset") ?? 0) + 50,
            )
            .map(({ fields: _, ...meta }) => meta),
        };
      else if (method === "GET")
        data = {
          project,
          version: parts[6]
            ? versions.find((v) => v.id === parts[6])
            : versions.at(-1),
        };
      else if (action === "briefs") {
        const body = req.postDataJSON();
        state.saves.push(body);
        if (state.stale || body.expected_head_id !== project.head_id) {
          status = 409;
          data = {
            message:
              "O briefing mudou em outra sessão. Atualize antes de salvar.",
          };
        } else {
          const v = version(
            id,
            versions.length + 1,
            body.fields,
            project.head_id,
          );
          versions.push(v);
          project.head_id = v.id;
          data = { version_id: v.id, number: v.number };
          status = 201;
        }
      } else if (action === "approvals") {
        const body = req.postDataJSON();
        state.approvals.push(body);
        const v = versions.at(-1)!;
        if (v.id !== body.version_id || v.content_hash !== body.content_hash) {
          status = 409;
          data = { message: "Versão alterada." };
        } else {
          v.approval = {
            id: crypto.randomUUID(),
            version_id: v.id,
            content_hash: v.content_hash,
            actor_id: user,
            created_at: v.created_at,
          };
          data = v.approval;
        }
      } else {
        status = 404;
        state.unexpected.push(path);
      }
    } else {
      status = 404;
      state.unexpected.push(path);
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  return state;
}
async function createDemo(page: Page) {
  await page.getByRole("button", { name: "Novo projeto", exact: true }).click();
  await page.getByLabel("Tipo de projeto").selectOption("demo");
  await page
    .getByLabel("Título do projeto")
    .fill("Demonstração sintética de teste");
  await page
    .getByRole("button", { name: "Criar projeto", exact: true })
    .click();
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toBeVisible();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Revisar e salvar rascunho" }).click();
  await page
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Atualizar briefing" }),
  ).toBeEnabled();
}
test("opens Studio from responsive navigation with empty state and creates a labelled blank demo", async ({
  page,
}, testInfo) => {
  const state = await mock(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "Creative Studio", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(
    page.getByRole("heading", { name: "Creative Studio." }),
  ).toBeVisible();
  await expect(page.getByText("Nenhum projeto nesta página.")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("studio.png"),
    fullPage: true,
  });
  expect(state.projects).toHaveLength(0);
  await createDemo(page);
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByText("Projeto de demonstração.", { exact: false }),
  ).toBeVisible();
  expect(state.creates[0]).toMatchObject({ mode: "demo", lead_id: null });
  await expect(
    page.getByRole("button", { name: "Aprovar versão 1" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.unexpected).toEqual([]);
});
test("creates from an opportunity, saves a reviewed draft, and preserves historical versions", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/studio");
  await page.getByRole("button", { name: "Novo projeto", exact: true }).click();
  await page.getByLabel("Oportunidade existente").selectOption(lead.id);
  await page
    .getByRole("button", { name: "Criar projeto", exact: true })
    .click();
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveValue(lead.company);
  await expect(page.getByLabel("Verificação — Nome da empresa")).toHaveValue(
    "pending",
  );
  await expect(
    page.getByLabel("Uso público — Nome da empresa"),
  ).not.toBeChecked();
  const project = state.projects[0],
    initial = state.versions[project.id][0].id;
  await page
    .getByLabel("Serviços *", { exact: true })
    .fill("Serviço informado exclusivamente para teste");
  await page.getByRole("button", { name: "Revisar e salvar rascunho" }).click();
  expect(state.saves).toHaveLength(0);
  await expect(page.getByRole("dialog")).toContainText(
    "Serviço informado exclusivamente para teste",
  );
  await page
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Histórico do briefing")).toHaveValue(
    state.versions[project.id].at(-1)!.id,
  );
  expect(state.versions[project.id]).toHaveLength(2);
  expect(state.versions[project.id][0].fields.services.value).toBe("");
  await page.getByLabel("Histórico do briefing").selectOption(initial);
  await expect(page.getByLabel("Serviços *", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Serviços *", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Usar como novo rascunho" }).click();
  await expect(page.getByLabel("Serviços *", { exact: true })).toBeEnabled();
  await save(page);
  expect(state.versions[project.id]).toHaveLength(3);
  expect(state.versions[project.id][1].fields.services.value).toContain(
    "exclusivamente para teste",
  );
  expect(lead.version).toBe(1);
});
test("verifies field provenance and binds human approval to exactly one saved version", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/studio");
  await createDemo(page);
  for (const label of [
    "Nome da empresa",
    "Segmento",
    "Cidade",
    "Serviços",
    "Público-alvo",
  ]) {
    await page
      .getByLabel(`${label} *`, { exact: true })
      .fill(`Informação sintética: ${label}`);
    await page
      .getByLabel(`Origem — ${label}`, { exact: true })
      .fill("Declaração fictícia de teste");
    await page
      .getByLabel(`Verificação — ${label}`, { exact: true })
      .selectOption("fictional");
  }
  await page
    .getByLabel("Uso público — Nome da empresa", { exact: true })
    .check();
  await save(page);
  await page
    .getByRole("button", { name: "Aprovar versão 2", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirmar aprovação" }),
  ).toBeDisabled();
  expect(state.approvals).toHaveLength(0);
  await page
    .getByLabel("Revisei esta versão exata e aprovo o briefing.")
    .check();
  await page.getByRole("button", { name: "Confirmar aprovação" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Aprovar versão 2", exact: true }),
  ).toBeDisabled();
  const p = state.projects[0],
    v2 = state.versions[p.id][1];
  expect(state.approvals[0]).toEqual({
    version_id: v2.id,
    content_hash: v2.content_hash,
    confirm: true,
  });
  await page
    .getByLabel("Preferências de cores", { exact: true })
    .fill("Preferência informada pelo responsável de teste");
  await save(page);
  expect(state.versions[p.id][2].approval).toBeNull();
  expect(v2.approval).not.toBeNull();
  await page.reload();
  await page
    .getByRole("button", { name: /Demonstração sintética de teste/ })
    .click();
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveValue("Informação sintética: Nome da empresa");
  await expect(
    page.getByLabel("Uso público — Nome da empresa", { exact: true }),
  ).toBeChecked();
  await page
    .getByLabel("Nome da empresa *", { exact: true })
    .fill("Informação sintética alterada");
  await expect(
    page.getByLabel("Verificação — Nome da empresa", { exact: true }),
  ).toHaveValue("pending");
  await expect(
    page.getByLabel("Uso público — Nome da empresa", { exact: true }),
  ).not.toBeChecked();
  expect(state.unexpected).toEqual([]);
});
test("keeps a conflicting draft available and retries the same mutation without overwriting history", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/studio");
  await createDemo(page);
  await page
    .getByLabel("Nome da empresa *", { exact: true })
    .fill("Rascunho sintético local");
  state.stale = true;
  await page.getByRole("button", { name: "Revisar e salvar rascunho" }).click();
  await page
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "outra sessão",
  );
  expect(state.versions[state.projects[0].id]).toHaveLength(1);
  state.stale = false;
  await page
    .getByRole("button", { name: "Salvar nova versão", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveValue("Rascunho sintético local");
  expect(state.saves[0].request_id).toBe(state.saves[1].request_id);
  expect(state.versions[state.projects[0].id]).toHaveLength(2);
});
test("preserves local edits on read failure, warns before navigation and removes a revoked session", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/studio");
  await createDemo(page);
  await page
    .getByLabel("Nome da empresa *", { exact: true })
    .fill("Não perder rascunho sintético");
  state.readOutage = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Atualizar briefing" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Leitura temporariamente",
  );
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveValue("Não perder rascunho sintético");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("link", { name: "Descobrir empresas", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/studio$/);
  state.readOutage = false;
  state.forbidden = true;
  await page.getByRole("button", { name: "Atualizar projetos" }).click();
  await expect(
    page.getByRole("heading", { name: "Entre no seu workspace" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Nome da empresa *", { exact: true }),
  ).toHaveCount(0);
});
