import { test, expect, type Page } from "@playwright/test";
import { builtBrowserApp } from "../fixtures/built-browser-app";
test.beforeEach(async ({ page }) => {
  await builtBrowserApp(page);
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
});
import { briefFixture } from "../fixtures/site-persistence";
import type {
  GenerationJob,
  SiteVersionSummary,
} from "../../shared/studio-generation";

const owner = "11111111-1111-4111-8111-111111111111",
  projectId = "22222222-2222-4222-8222-222222222222",
  briefId = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
async function mock(page: Page) {
  const fields = briefFixture();
  const project = {
    id: projectId,
    title: "Projeto sintético de geração",
    mode: "demo",
    lead_id: null,
    lead_snapshot: null,
    head_id: briefId,
    created_at: "2026-10-31T12:00:00Z",
    head_approved: true,
  };
  const version = {
    id: briefId,
    project_id: projectId,
    number: 2,
    parent_id: null,
    fields,
    content_hash: hash,
    created_at: project.created_at,
    created_by: owner,
    approval: {
      id: "44444444-4444-4444-8444-444444444444",
      version_id: briefId,
      content_hash: hash,
      actor_id: owner,
      created_at: project.created_at,
    },
  };
  const state = {
    available: true,
    eligible: true,
    migrationMissing: false,
    forbidden: false,
    failSubmitOnce: false,
    historyOutage: false,
    polls: 0,
    posts: [] as Record<string, unknown>[],
    jobs: [] as GenerationJob[],
    versions: [] as SiteVersionSummary[],
    unexpected: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    let status = 200,
      data: unknown;
    if (path === "/api/session")
      data = {
        configured: true,
        user: { id: owner, email: "fixture@example.test" },
      };
    else if (path === "/api/leads") data = { leads: [] };
    else if (path.startsWith("/api/studio/") && state.forbidden) {
      status = 403;
      data = { message: "Acesso revogado." };
    } else if (path === "/api/studio/projects") data = { projects: [project] };
    else if (path === `/api/studio/projects/${projectId}`)
      data = { project, version };
    else if (path === `/api/studio/projects/${projectId}/versions`)
      data = { versions: [{ ...version, fields: undefined }] };
    else if (path.endsWith("/site-generation/eligibility"))
      data = {
        eligible: state.eligible,
        code: state.eligible ? "eligible" : "insufficient_public_information",
        message: state.eligible
          ? "Briefing aprovado e autorizado."
          : "Autorize os campos públicos essenciais para preparar a geração.",
        missing_fields: state.eligible ? [] : ["services"],
        availability: {
          available: state.available && !state.migrationMissing,
          code: state.migrationMissing
            ? "migration_missing"
            : state.available
              ? "ready"
              : "disabled",
          message: state.migrationMissing
            ? "A persistência de sites ainda não está disponível. Revise a migração da Etapa 2."
            : state.available
              ? "Geração disponível."
              : "A geração por IA está desativada.",
        },
      };
    else if (path.endsWith("/site-generation/history")) {
      if (state.historyOutage || state.migrationMissing) {
        status = 503;
        data = {
          message: state.migrationMissing
            ? "Persistência ainda não disponível."
            : "Histórico indisponível.",
          code: state.migrationMissing
            ? "migration_missing"
            : "read_unavailable",
        };
      } else
        data = { jobs: state.jobs, versions: state.versions, has_more: false };
    } else if (
      path.endsWith("/site-generation/jobs") &&
      req.method() === "POST"
    ) {
      const body = req.postDataJSON();
      state.posts.push(body);
      let job = state.jobs.find((j) => j.request_id === body.request_id);
      if (!job) {
        job = {
          id: crypto.randomUUID(),
          project_id: projectId,
          request_id: body.request_id,
          brief_version_id: briefId,
          brief_hash: hash,
          status: "processing",
          error_code: null,
          created_at: "2026-10-31T12:00:00Z",
          started_at: "2026-10-31T12:00:00Z",
          finished_at: null,
          stalled: false,
        };
        state.jobs.unshift(job);
      }
      if (state.failSubmitOnce) {
        state.failSubmitOnce = false;
        await route.abort("failed");
        return;
      }
      status = 202;
      data = { job, version: null };
    } else if (path.includes("/site-generation/jobs/")) {
      const parts = path.split("/"),
        id = parts[7],
        job = state.jobs.find((j) => j.id === id);
      if (!job) {
        status = 404;
        data = { message: "Trabalho indisponível." };
      } else if (path.endsWith("/cancel") && req.method() === "POST") {
        job.status = "failed";
        job.error_code = "cancelled";
        job.finished_at = "2026-10-31T12:01:00Z";
        data = { job, version: null };
      } else {
        state.polls++;
        data = {
          job,
          version: state.versions.find((v) => v.job_id === job.id) ?? null,
        };
      }
    } else {
      status = 404;
      data = { message: "Unexpected fixture request" };
      state.unexpected.push(`${req.method()} ${path}`);
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/studio");
  await page
    .getByRole("button", { name: /Projeto sintético de geração/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Geração de site", exact: true }),
  ).toBeVisible();
  return state;
}
async function generate(page: Page) {
  await page.getByRole("button", { name: "Gerar site", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Confirmar e gerar", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel(
      "Confirmo esta solicitação e revisarei o resultado antes de qualquer publicação.",
    )
    .check();
  await page
    .getByRole("button", { name: "Confirmar e gerar", exact: true })
    .click();
}
test("requires human confirmation, follows asynchronous completion and restores history after reload", async ({
  page,
}, testInfo) => {
  const state = await mock(page);
  expect(state.posts).toHaveLength(0);
  await generate(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  expect(state.posts).toHaveLength(1);
  expect(Object.keys(state.posts[0]).sort()).toEqual([
    "brief_hash",
    "brief_version_id",
    "request_id",
  ]);
  await expect.poll(() => state.polls).toBeGreaterThan(0);
  state.jobs[0].status = "completed";
  state.jobs[0].finished_at = "2026-10-31T12:01:00Z";
  state.versions.push({
    id: crypto.randomUUID(),
    job_id: state.jobs[0].id,
    number: 1,
    brief_version_id: briefId,
    brief_hash: hash,
    document_hash: "b".repeat(64),
    created_at: "2026-10-31T12:01:00Z",
  });
  await expect(
    page.getByText(
      "Documento salvo. Aguarda revisão humana; nenhum site foi publicado.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gerar nova versão", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("studio-generation-completed.png"),
    fullPage: true,
  });
  await page
    .locator(".site-generation")
    .screenshot({ path: testInfo.outputPath("studio-generation-panel.png") });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.reload();
  await page
    .getByRole("button", { name: /Projeto sintético de geração/ })
    .click();
  await expect(
    page.getByText("Site · versão 1", { exact: true }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});
test("explains absent AI configuration, missing migration and insufficient public content", async ({
  page,
}) => {
  const state = await mock(page);
  state.available = false;
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(
    page.getByText("A geração por IA está desativada."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  state.available = true;
  state.migrationMissing = true;
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(
    page.getByText(/A persistência de sites ainda não está disponível/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  state.migrationMissing = false;
  state.eligible = false;
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(
    page.getByText(
      "Autorize os campos públicos essenciais para preparar a geração.",
    ),
  ).toBeVisible();
  expect(state.posts).toHaveLength(0);
});
test("blocks unsaved drafts and unavailable history, and preserves the same request after a lost response", async ({
  page,
}) => {
  const state = await mock(page);
  await page
    .getByLabel("Nome da empresa *", { exact: true })
    .fill("Rascunho sintético alterado");
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Há alterações não salvas/)).toBeVisible();
  await page
    .getByLabel("Nome da empresa *", { exact: true })
    .fill(briefFixture().company.value);
  // Changing a field invalidates provenance/public-use approval even when its
  // text is restored. Explicitly discard the draft instead of bypassing that rule.
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: /Projeto sintético de geração/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeEnabled();
  state.historyOutage = true;
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(page.getByText("Histórico indisponível.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  state.historyOutage = false;
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeEnabled();
  state.failSubmitOnce = true;
  await generate(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Encerrar trabalho", exact: true }),
  ).toBeVisible();
  expect(state.jobs).toHaveLength(1);
  expect(state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "Atualizar geração" }).click();
  await expect(
    page.getByRole("button", { name: "Gerar site", exact: true }),
  ).toBeDisabled();
  expect(state.posts).toHaveLength(1);
});
test("requires explicit cancellation and preserves failure history without rerunning AI", async ({
  page,
}) => {
  const state = await mock(page);
  await generate(page);
  await expect(
    page.getByRole("button", { name: "Encerrar trabalho", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Encerrar trabalho", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Encerrar trabalho de geração" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirmar encerramento", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText(/Trabalho encerrado por solicitação humana/),
  ).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.versions).toHaveLength(0);
});
test("closes a revoked session during generation status polling", async ({
  page,
}) => {
  const state = await mock(page);
  await generate(page);
  await expect(
    page.getByRole("button", { name: "Encerrar trabalho", exact: true }),
  ).toBeVisible();
  state.forbidden = true;
  await expect(page.getByLabel("E-mail", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  expect(state.posts).toHaveLength(1);
});
test("retries an unconfirmed submission with the exact same idempotency key", async ({
  page,
}) => {
  const state = await mock(page);
  let first = true;
  await page.route(
    `**/api/studio/projects/${projectId}/site-generation/jobs`,
    async (route) => {
      if (first && route.request().method() === "POST") {
        first = false;
        state.posts.push(route.request().postDataJSON());
        await route.abort("failed");
        return;
      }
      await route.fallback();
    },
  );
  await generate(page);
  await expect(
    page.getByRole("button", {
      name: "Repetir mesma solicitação",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Repetir mesma solicitação", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Encerrar trabalho", exact: true }),
  ).toBeVisible();
  expect(state.jobs).toHaveLength(1);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]).toEqual(state.posts[1]);
});
