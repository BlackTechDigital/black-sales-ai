import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { briefFixture } from "../fixtures/site-persistence";
import { previewFixture } from "../fixtures/studio-preview";
import {
  buildSiteArtifact,
  createArtifactZip,
} from "../../server/studio-site-artifact";
import {
  renderSitePreview,
  previewHeaders,
} from "../../server/studio-preview-renderer";

const project = "22222222-2222-4222-8222-222222222222",
  brief = "33333333-3333-4333-8333-333333333333",
  version = {
    id: "44444444-4444-4444-8444-444444444444",
    job_id: "55555555-5555-4555-8555-555555555555",
    number: 2,
    brief_version_id: brief,
    brief_hash: "a".repeat(64),
    document_hash: "b".repeat(64),
    created_at: "2026-10-31T12:00:00Z",
  },
  exec = promisify(execFile);
const appPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
async function mock(page: Page) {
  const doc = previewFixture(),
    artifact = await buildSiteArtifact(doc, version),
    archive = await createArtifactZip(artifact),
    p = {
      id: project,
      title: "Exportação sintética",
      mode: "demo",
      lead_id: null,
      lead_snapshot: null,
      head_id: brief,
      created_at: version.created_at,
      head_approved: true,
    };
  const state = {
    enabled: true,
    tamper: false,
    mismatch: false,
    revoked: false,
    delayDownload: false,
    downloading: false,
    release: () => {},
    review: null as null | { id: string; decision: string; created_at: string },
    reviews: [] as unknown[],
    downloads: 0,
    unexpected: [] as string[],
    artifact,
    archive,
  };
  function status() {
    const approved = state.review?.decision === "approved";
    return {
      version_id: version.id,
      document_hash: version.document_hash,
      artifact_hash: artifact.artifactHash,
      visual_hash: state.mismatch ? "f".repeat(64) : artifact.visualHash,
      enabled: state.enabled,
      can_review: state.enabled,
      can_export: state.enabled && approved,
      code: !state.enabled
        ? "export_disabled"
        : approved
          ? "ready"
          : "review_required",
      message: !state.enabled
        ? "A exportação ainda não foi habilitada no servidor."
        : approved
          ? "Versão revisada. O ZIP não publica o site."
          : "Revise o site antes de exportar.",
      review: state.review,
    };
  }
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
      throw new Error("Uncontrolled asset");
    await route.fulfill({
      status: 200,
      contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
      body: await readFile(
        new URL(`../../dist/assets/${name}`, import.meta.url),
      ),
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data: unknown,
      code = 200;
    if (path === "/api/session")
      data = {
        configured: true,
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "fixture@example.test",
        },
      };
    else if (path === "/api/leads") data = { leads: [] };
    else if (path === "/api/studio/projects") data = { projects: [p] };
    else if (path === `/api/studio/projects/${project}`)
      data = {
        project: p,
        version: {
          id: brief,
          project_id: project,
          number: 1,
          parent_id: null,
          fields: briefFixture(),
          content_hash: version.brief_hash,
          created_at: version.created_at,
          created_by: "11111111-1111-4111-8111-111111111111",
          approval: null,
        },
      };
    else if (path.endsWith("/versions") && !path.includes("site-"))
      data = { versions: [] };
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
              message: "IA desativada.",
            },
          }
        : { jobs: [], versions: [], has_more: false };
    else if (path.endsWith("/site-preview/versions"))
      data = {
        versions: [version],
        current_version_id: version.id,
        current_brief_version_id: brief,
        has_more: false,
      };
    else if (path.endsWith("/frame")) {
      const rendered = renderSitePreview(doc);
      await route.fulfill({
        status: 200,
        headers: previewHeaders(rendered.csp),
        body: rendered.html,
      });
      return;
    } else if (path.endsWith("/export/status")) data = status();
    else if (path.endsWith("/export/reviews")) {
      const input = request.postDataJSON();
      expect(input).toMatchObject({
        document_hash: version.document_hash,
        artifact_hash: artifact.artifactHash,
        visual_hash: artifact.visualHash,
        confirm_review: true,
      });
      expect(input.confirm_public_use).toBe(input.decision === "approved");
      state.reviews.push(input);
      state.review = {
        id: crypto.randomUUID(),
        decision: input.decision,
        created_at: version.created_at,
      };
      data = status();
    } else if (path.endsWith("/export") && request.method() === "POST") {
      state.downloads++;
      expect(request.postDataJSON()).toMatchObject({
        review_id: state.review?.id,
        artifact_hash: artifact.artifactHash,
        visual_hash: artifact.visualHash,
        document_hash: version.document_hash,
        confirm: true,
      });
      if (state.revoked) {
        state.review = {
          id: crypto.randomUUID(),
          decision: "changes_requested",
          created_at: version.created_at,
        };
        code = 409;
        data = {
          code: "review_changed",
          message: "A revisão foi revogada. Revise novamente.",
        };
      } else {
        if (state.delayDownload) {
          state.downloading = true;
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        }
        const bytes = archive.zip.slice();
        if (state.tamper) bytes[40] ^= 1;
        await route
          .fulfill({
            status: 200,
            headers: {
              "Content-Type": "application/zip",
              "Content-Length": String(bytes.length),
              "X-Studio-Document-Hash": version.document_hash,
              "X-Studio-Artifact-Hash": artifact.artifactHash,
              "X-Studio-Visual-SHA256": artifact.visualHash,
              "X-Studio-Archive-SHA256": archive.archiveHash,
            },
            body: Buffer.from(bytes),
          })
          .catch(() => {});
        return;
      }
    } else if (path.includes("/site-preview/versions/"))
      data = {
        version,
        visual_hash: artifact.visualHash,
        current_version_id: version.id,
        current_brief_version_id: brief,
      };
    else {
      code = 404;
      state.unexpected.push(path);
      data = { message: "Unexpected fixture request" };
    }
    await route.fulfill({
      status: code,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/studio");
  await page.getByRole("button", { name: /Exportação sintética/ }).click();
  await page.getByRole("button", { name: "Abrir prévia", exact: true }).click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", {
      name: "Uma presença digital com personalidade.",
    }),
  ).toBeVisible();
  return state;
}
async function approve(page: Page) {
  await page
    .getByRole("button", { name: "Revisar site para exportação", exact: true })
    .click();
  const confirm = page.getByRole("button", {
    name: "Aprovar site para exportação",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("Conferi a prévia e os textos desta versão do site.", {
      exact: true,
    })
    .check();
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Confirmo autorização de uso público/).check();
  await confirm.click();
  await expect(
    page.getByRole("button", { name: "Baixar projeto ZIP", exact: true }),
  ).toBeEnabled();
}

test("human review, verified ZIP and extracted site reproduce the selected responsive preview without APIs", async ({
  page,
}, info) => {
  const state = await mock(page),
    downloadButton = page.getByRole("button", {
      name: "Baixar projeto ZIP",
      exact: true,
    });
  await expect(downloadButton).toBeDisabled();
  await expect(
    page.getByText(/A aprovação do briefing não aprova o site/),
  ).toBeVisible();
  await approve(page);
  const downloaded = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloaded,
    zipPath = info.outputPath("site.zip"),
    folder = info.outputPath("site");
  expect(download.suggestedFilename()).toBe(
    `black-sales-site-v2-${version.document_hash.slice(0, 12)}.zip`,
  );
  await download.saveAs(zipPath);
  expect(await readFile(zipPath)).toEqual(Buffer.from(state.archive.zip));
  await mkdir(folder, { recursive: true });
  await exec("python", [
    "-c",
    "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert all('..' not in n and not n.startswith('/') for n in z.namelist())\n z.extractall(sys.argv[2])",
    zipPath,
    folder,
  ]);
  const verified = await exec(process.execPath, [
    join(folder, "scripts/verify.mjs"),
  ]);
  expect(verified.stdout).toContain("conferidos");
  const child = spawn(process.execPath, [join(folder, "scripts/serve.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const local = await page.context().newPage();
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Local server did not start")),
        5000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Local server exited ${code}`));
      });
      child.stdout.on("data", (bytes) => {
        if (String(bytes).includes("Site local:")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const response = await local.goto("http://127.0.0.1:4173");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'none'",
    );
    expect(await local.locator("body").innerHTML()).toBe(
      await page.frameLocator("iframe").locator("body").innerHTML(),
    );
    expect(
      await local
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(8, 12, 20)");
    for (const width of [1280, 768, 390]) {
      await local.setViewportSize({ width, height: 900 });
      expect(
        await local
          .locator("html")
          .evaluate((el) => el.scrollWidth > window.innerWidth),
      ).toBe(false);
      const count = await local
        .locator(".cards")
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
        );
      expect(count).toBe(width === 390 ? 1 : 3);
    }
    await local
      .getByRole("navigation")
      .getByRole("link", { name: "Sobre", exact: true })
      .click();
    await expect(
      local.getByRole("heading", { name: "Sobre a demonstração", exact: true }),
    ).toBeVisible();
    await expect(local.locator("script,img,iframe")).toHaveCount(0);
    expect(
      (await local.request.get("http://127.0.0.1:4173/manifest.json")).status(),
    ).toBe(404);
    expect((await local.request.post("http://127.0.0.1:4173/")).status()).toBe(
      405,
    );
    expect(state.reviews).toHaveLength(1);
    expect(state.downloads).toBe(1);
    expect(state.unexpected).toEqual([]);
  } finally {
    await local.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else child.once("exit", () => resolve());
    });
  }
});
test("blocks tampered ZIPs, stale reviews and mismatched preview fingerprints", async ({
  page,
}) => {
  const state = await mock(page),
    downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await approve(page);
  state.tamper = true;
  await page
    .getByRole("button", { name: "Baixar projeto ZIP", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /integridade do ZIP/ }),
  ).toBeVisible();
  expect(downloads).toEqual([]);
  state.tamper = false;
  state.revoked = true;
  await page
    .getByRole("button", { name: "Baixar projeto ZIP", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /revisão foi revogada/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Baixar projeto ZIP", exact: true }),
  ).toBeDisabled();
  state.mismatch = true;
  await page
    .getByRole("button", { name: "Atualizar revisão de exportação" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /prévia e os arquivos mudaram/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Revisar site para exportação",
      exact: true,
    }),
  ).toBeDisabled();
  expect(downloads).toEqual([]);
});
test("never downloads a delayed archive after closing the selected preview", async ({
  page,
}) => {
  const state = await mock(page),
    downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await approve(page);
  state.delayDownload = true;
  await page
    .getByRole("button", { name: "Baixar projeto ZIP", exact: true })
    .click();
  await expect.poll(() => state.downloading).toBe(true);
  await page
    .getByRole("button", { name: "Fechar prévia", exact: true })
    .click();
  state.release();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => downloads.length).toBe(0);
});
