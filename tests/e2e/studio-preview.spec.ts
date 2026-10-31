import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { briefFixture } from "../fixtures/site-persistence";
import { previewFixture } from "../fixtures/studio-preview";
import {
  renderSitePreview,
  previewHeaders,
} from "../../server/studio-preview-renderer";

const owner = "11111111-1111-4111-8111-111111111111",
  project = "22222222-2222-4222-8222-222222222222",
  brief = "33333333-3333-4333-8333-333333333333",
  v1 = "44444444-4444-4444-8444-444444444444",
  v2 = "55555555-5555-4555-8555-555555555555";
const version = (id: string, number: number) => ({
  id,
  job_id: crypto.randomUUID(),
  number,
  brief_version_id:
    number === 1 ? "66666666-6666-4666-8666-666666666666" : brief,
  brief_hash: "a".repeat(64),
  document_hash: (number === 1 ? "b" : "c").repeat(64),
  created_at: `2026-10-31T12:0${number}:00Z`,
});
const appPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
async function mock(page: Page) {
  // Serve the actual built application under the production-style CSP. Vite's
  // inline HMR preamble/styles would require weaker rules and hide regressions.
  await page.route("http://localhost:5173/studio", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "Content-Security-Policy": appPolicy },
      body: await readFile(
        new URL("../../dist/index.html", import.meta.url),
        "utf8",
      ),
    }),
  );
  await page.route("**/assets/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (!/^[a-zA-Z0-9_-]+\.(js|css)$/.test(name))
      throw new Error("Unexpected built asset");
    await route.fulfill({
      status: 200,
      contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
      body: await readFile(
        new URL(`../../dist/assets/${name}`, import.meta.url),
      ),
    });
  });
  await page.context().addCookies([
    {
      name: "preview-cookie",
      value: "synthetic-only",
      url: "http://localhost:5173",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const p = {
    id: project,
    title: "Projeto sintético de prévia",
    mode: "demo",
    lead_id: null,
    lead_snapshot: null,
    head_id: brief,
    created_at: "2026-10-31T12:00:00Z",
    head_approved: true,
  };
  const briefing = {
    id: brief,
    project_id: project,
    number: 2,
    parent_id: null,
    fields: briefFixture(),
    content_hash: "a".repeat(64),
    created_at: p.created_at,
    created_by: owner,
    approval: {
      id: crypto.randomUUID(),
      version_id: brief,
      content_hash: "a".repeat(64),
      actor_id: owner,
      created_at: p.created_at,
    },
  };
  const versions = [version(v2, 2), version(v1, 1)];
  const state = {
    empty: false,
    missing: false,
    invalid: new Set<string>(),
    forbidden: false,
    metadataMismatch: false,
    unsafeFrame: false,
    delayId: "",
    delayRelease: () => {},
    delayed: false,
    frameRequests: [] as string[],
    frameCookieSent: false,
    posts: 0,
    unexpected: [] as string[],
    blockedNetwork: 0,
  };
  await page.route("https://evil.example.com/**", async (route) => {
    state.blockedNetwork++;
    await route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (req.method() !== "GET") state.posts++;
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
    } else if (path === "/api/studio/projects") data = { projects: [p] };
    else if (path === `/api/studio/projects/${project}`)
      data = { project: p, version: briefing };
    else if (path === `/api/studio/projects/${project}/versions`)
      data = { versions: [{ ...briefing, fields: undefined }] };
    else if (path.includes("/site-generation/"))
      data = path.endsWith("/eligibility")
        ? {
            eligible: true,
            code: "eligible",
            message: "Briefing autorizado.",
            missing_fields: [],
            availability: {
              available: false,
              code: "disabled",
              message: "A geração por IA está desativada.",
            },
          }
        : { jobs: [], versions: [], has_more: false };
    else if (path.endsWith("/site-preview/versions")) {
      if (state.missing) {
        status = 503;
        data = {
          code: "migration_missing",
          message: "A persistência de sites ainda não está disponível.",
        };
      } else
        data = {
          versions: state.empty ? [] : versions,
          current_version_id: state.empty ? null : v2,
          current_brief_version_id: brief,
          has_more: false,
        };
    } else if (path.includes("/site-preview/versions/")) {
      const id = path.split("/")[7],
        meta = versions.find((v) => v.id === id)!;
      if (path.endsWith("/export/status")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version_id: id,
            document_hash: meta.document_hash,
            artifact_hash: null,
            enabled: false,
            can_review: false,
            can_export: false,
            code: "export_disabled",
            message: "A exportação ainda não foi habilitada no servidor.",
            review: null,
          }),
        });
        return;
      }
      if (path.endsWith("/frame")) {
        state.frameRequests.push(id);
        state.frameCookieSent =
          (await req.allHeaders()).cookie?.includes(
            "preview-cookie=synthetic-only",
          ) ?? false;
        const doc = previewFixture();
        doc.pages[0].sections[0].heading = `Versão ${meta.number} · Experiência sintética`;
        if (meta.number === 1) {
          doc.identity.palette.primary = "#BE8C63";
          doc.identity.style = "classic";
        }
        const rendered = renderSitePreview(doc);
        const body = state.unsafeFrame
          ? rendered.html.replace(
              "</body>",
              `<script>document.body.dataset.previewAttack='ran';parent.postMessage('preview-attack','*');fetch('https://evil.example.com/script');</script><img src="https://evil.example.com/pixel" onerror="document.body.dataset.imageAttack='ran'"></body>`,
            )
          : rendered.html;
        await route.fulfill({
          status: 200,
          headers: previewHeaders(rendered.csp),
          body,
        });
        return;
      }
      if (state.delayId === id) {
        state.delayed = true;
        await new Promise<void>((resolve) => {
          state.delayRelease = resolve;
        });
      }
      if (state.invalid.has(id)) {
        status = 422;
        data = {
          code: "invalid_document",
          message: "O documento salvo não é compatível com a prévia segura.",
        };
      } else
        data = {
          version: state.metadataMismatch
            ? versions.find((v) => v.id !== id)
            : meta,
          current_version_id: v2,
          current_brief_version_id: brief,
        };
    } else {
      status = 404;
      data = { message: "Unexpected fixture request" };
      state.unexpected.push(path);
    }
    try {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    } catch {
      /* A deliberate aborted late response may have lost its page. */
    }
  });
  await page.goto("/studio");
  await page
    .getByRole("button", { name: /Projeto sintético de prévia/ })
    .click();
  return state;
}
const iframeSelector = 'iframe[title="Prévia do site — versão 2"]';
async function open(page: Page) {
  await page.getByRole("button", { name: "Abrir prévia", exact: true }).click();
}
async function previewClick(page: Page, target: Locator, touch: boolean) {
  // Playwright's cross-origin locator bounds omit the iframe's CSS transform.
  // Send actual mouse/touch input mapped from frame CSS pixels to the screen.
  await target.scrollIntoViewIfNeeded();
  const iframe = page.locator(iframeSelector),
    box = await iframe.boundingBox();
  const rect = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) throw new Error("Preview frame is not visible");
  const scale = box.width / Number(await iframe.getAttribute("width"));
  const x = box.x + (rect.x + rect.width / 2) * scale,
    y = box.y + (rect.y + rect.height / 2) * scale;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
test("renders all allowed components with responsive viewports, navigation and inert external links", async ({
  page,
}, testInfo) => {
  const state = await mock(page);
  expect(state.frameRequests).toHaveLength(0);
  await open(page);
  const frame = page.frameLocator(iframeSelector);
  await expect(
    frame.getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.frameCookieSent).toBe(true);
  expect(
    await frame
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(8, 12, 20)");
  for (const [name, width] of [
    ["Desktop", 1280],
    ["Tablet", 768],
    ["Celular", 390],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(iframeSelector)).toHaveAttribute(
      "width",
      String(width),
    );
    await expect
      .poll(() => frame.locator("body").evaluate(() => window.innerWidth))
      .toBe(width);
    const grid = await frame
      .locator(".cards")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      );
    expect(grid).toBe(name === "Celular" ? 1 : 3);
    expect(
      await frame
        .locator("html")
        .evaluate((el) => el.scrollWidth > window.innerWidth),
    ).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.locator(".site-preview").screenshot({
      path: testInfo.outputPath(`preview-${name.toLowerCase()}.png`),
    });
  }
  await previewClick(
    page,
    frame
      .getByRole("navigation", { name: "Páginas do site" })
      .getByRole("link", { name: "Sobre", exact: true }),
    Boolean(testInfo.project.use.hasTouch),
  );
  await expect(
    frame.getByRole("heading", { name: "Sobre a demonstração", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeHidden();
  await previewClick(
    page,
    frame.getByRole("link", { name: "Voltar aos serviços", exact: true }),
    Boolean(testInfo.project.use.hasTouch),
  );
  await expect(
    frame.getByRole("heading", { name: "Serviços de teste", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("link", { name: /Página de referência/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await frame
    .getByRole("link", { name: /Página de referência/ })
    .dispatchEvent("click");
  expect(state.frameRequests).toEqual([v2]);
  expect(state.blockedNetwork).toBe(0);
  expect(state.posts).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});
test("selects the exact older immutable document and labels its old site/briefing provenance", async ({
  page,
}) => {
  const state = await mock(page);
  await open(page);
  await expect(
    page.frameLocator(iframeSelector).getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Versão do site", { exact: true }).selectOption(v1);
  const frame = page.frameLocator('iframe[title="Prévia do site — versão 1"]');
  await expect(
    frame.getByRole("heading", {
      name: "Versão 1 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(iframeSelector)).toHaveCount(0);
  await expect(page.getByText("Versão antiga", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Esta versão foi gerada a partir de um briefing anterior/),
  ).toBeVisible();
  expect(
    await frame
      .locator("body")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--primary")),
  ).toBe("#BE8C63");
  expect(state.frameRequests).toEqual([v2, v1]);
});
test("rejects invalid documents and handles empty/missing persistence without mounting an iframe", async ({
  page,
}) => {
  const state = await mock(page);
  state.empty = true;
  await open(page);
  await expect(
    page.getByText(/Ainda não há versões de site salvas/),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  state.empty = false;
  state.missing = true;
  await page
    .getByRole("button", { name: "Atualizar versões da prévia" })
    .click();
  await expect(
    page.getByText("A persistência de sites ainda não está disponível.", {
      exact: true,
    }),
  ).toBeVisible();
  state.missing = false;
  state.invalid.add(v2);
  await page
    .getByRole("button", { name: "Atualizar versões da prévia" })
    .click();
  await expect(
    page.getByText(/O documento salvo não é compatível com a prévia segura/),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(state.frameRequests).toHaveLength(0);
  expect(state.posts).toBe(0);
});
test("clears old previews during selection and ignores aborted late responses", async ({
  page,
}) => {
  const state = await mock(page);
  await open(page);
  await expect(
    page.frameLocator(iframeSelector).getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  state.delayId = v1;
  await page.getByLabel("Versão do site", { exact: true }).selectOption(v1);
  await expect.poll(() => state.delayed).toBe(true);
  await expect(
    page.getByText("Validando o documento da versão selecionada…"),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByLabel("Versão do site", { exact: true }).selectOption(v2);
  await expect(
    page.frameLocator(iframeSelector).getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  state.delayRelease();
  await expect(
    page.locator('iframe[title="Prévia do site — versão 1"]'),
  ).toHaveCount(0);
});
test("blocks scripts, images and origin access even if the test transport is deliberately corrupted", async ({
  page,
}) => {
  const state = await mock(page);
  state.unsafeFrame = true;
  await open(page);
  const frame = page.frameLocator(iframeSelector);
  await expect(
    frame.getByRole("heading", {
      name: "Versão 2 · Experiência sintética",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(iframeSelector)).toHaveAttribute("sandbox", "");
  await expect(page.locator(iframeSelector)).toHaveAttribute(
    "referrerpolicy",
    "no-referrer",
  );
  expect(
    await page
      .locator(iframeSelector)
      .evaluate((el) => (el as HTMLIFrameElement).contentDocument === null),
  ).toBe(true);
  expect(
    await frame.locator("body").getAttribute("data-preview-attack"),
  ).toBeNull();
  expect(
    await frame.locator("body").getAttribute("data-image-attack"),
  ).toBeNull();
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        void parent.document;
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        void document.cookie;
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  expect(state.blockedNetwork).toBe(0);
  expect(state.posts).toBe(0);
});
test("rejects mismatched version metadata and closes a revoked session", async ({
  page,
}) => {
  const state = await mock(page);
  state.metadataMismatch = true;
  await open(page);
  await expect(
    page.getByText(/A versão recebida não corresponde à seleção/),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(state.frameRequests).toHaveLength(0);
  state.metadataMismatch = false;
  state.forbidden = true;
  await page
    .getByRole("button", { name: "Atualizar versões da prévia" })
    .click();
  await expect(page.getByLabel("E-mail", { exact: true })).toBeVisible();
});
