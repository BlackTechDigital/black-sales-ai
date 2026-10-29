import { test, expect, type Page } from "@playwright/test";
const valid = {
  ready: true,
  email: "recovery@example.test",
  expiresAt: Math.floor(Date.now() / 1000) + 900,
};
const invalid = {
  code: "recovery_invalid",
  message:
    "Este link de recuperação é inválido, expirou ou já foi utilizado. Solicite um novo link.",
};
async function mock(
  page: Page,
  mode: "valid" | "expired" | "policy" | "outage" = "valid",
) {
  const calls: { path: string; body: unknown }[] = [];
  let saved = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : null;
    calls.push({ path, body });
    if (path === "/api/recovery/verify" || path === "/api/recovery/session") {
      if (mode === "expired")
        return route.fulfill({ status: 400, json: invalid });
      if (mode === "outage")
        return route.fulfill({
          status: 503,
          json: {
            code: "auth_unavailable",
            message:
              "Não foi possível acessar a autenticação agora. Tente novamente em instantes.",
          },
        });
      return route.fulfill({ json: valid });
    }
    if (path === "/api/recovery/password") {
      saved++;
      if (mode === "policy" && saved === 1)
        return route.fulfill({
          status: 400,
          json: {
            code: "password_policy",
            message:
              "A senha não atende à política de segurança da conta. Escolha uma senha mais forte.",
          },
        });
      return route.fulfill({
        json: {
          updated: true,
          message: "Senha atualizada. Entre novamente com a nova senha.",
        },
      });
    }
    if (path === "/api/recovery/request")
      return route.fulfill({
        json: {
          message:
            "Se houver uma conta para este e-mail, você receberá um link de recuperação.",
        },
      });
    if (path === "/api/session")
      return route.fulfill({ json: { configured: true, user: null } });
    return route.fulfill({
      status: 404,
      json: { message: "Operação não encontrada." },
    });
  });
  return calls;
}
test("validates one hash once in StrictMode, removes URL secrets and changes the password", async ({
  page,
}) => {
  const calls = await mock(page);
  const logs: string[] = [];
  page.on("console", (event) => logs.push(event.text()));
  await page.addInitScript(() =>
    localStorage.setItem("black_sales_ai_leads_v1", "original-data-fixture"),
  );
  await page.goto(
    "/reset-password#token_hash=private-hash-fixture&type=recovery",
  );
  await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://localhost:5173/reset-password");
  expect(calls.filter((c) => c.path === "/api/recovery/verify")).toHaveLength(
    1,
  );
  expect(calls.find((c) => c.path === "/api/recovery/verify")?.body).toEqual({
    kind: "tokenHash",
    tokenHash: "private-hash-fixture",
  });
  expect(calls.some((c) => c.path === "/api/session")).toBe(false);
  await page
    .getByLabel("Nova senha", { exact: true })
    .fill("Valid password fixture 123!");
  await page
    .getByLabel("Confirmar nova senha")
    .fill("Different password fixture 123!");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "As senhas precisam ser iguais",
  );
  expect(calls.filter((c) => c.path === "/api/recovery/password")).toHaveLength(
    0,
  );
  await page
    .getByLabel("Confirmar nova senha")
    .fill("Valid password fixture 123!");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(
    page.getByRole("heading", { name: "Senha atualizada" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nova senha", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("black_sales_ai_leads_v1")),
  ).toBe("original-data-fixture");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    "black_sales_ai_leads_v1",
  ]);
  expect(logs.join(" ")).not.toContain("private-hash-fixture");
  expect(logs.join(" ")).not.toContain("Valid password fixture 123!");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Voltar ao login" }).click();
  await expect(
    page.getByRole("button", { name: "Entrar no workspace" }),
  ).toBeVisible();
});
test("accepts default implicit links at the root without exposing tokens in storage", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto(
    "/#access_token=private-access&refresh_token=private-refresh&type=recovery",
  );
  await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://localhost:5173/reset-password");
  expect(calls.find((c) => c.path === "/api/recovery/verify")?.body).toEqual({
    kind: "session",
    accessToken: "private-access",
    refreshToken: "private-refresh",
  });
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});
test("cleans PKCE codes and resumes a verified page after reload", async ({
  page,
}) => {
  const calls = await mock(page);
  const flowId = "a".repeat(32);
  await page.goto(`/auth/callback?code=private-code&sb_flow_id=${flowId}`);
  await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://localhost:5173/reset-password");
  expect(calls.find((c) => c.path === "/api/recovery/verify")?.body).toEqual({
    kind: "code",
    code: "private-code",
    flowId,
  });
  await page.reload();
  await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
  expect(calls.filter((c) => c.path === "/api/recovery/verify")).toHaveLength(
    1,
  );
  expect(calls.some((c) => c.path === "/api/recovery/session")).toBe(true);
});
test("explains expired links and lets the user request another", async ({
  page,
}) => {
  const calls = await mock(page, "expired");
  await page.goto(
    "/reset-password#token_hash=expired-hash-fixture&type=recovery",
  );
  await expect(page.getByRole("alert")).toContainText("expirou");
  await expect(page.getByLabel("Nova senha", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Solicitar novo link" }).click();
  await page.getByLabel("E-mail de recuperação").fill("recovery@example.test");
  await page
    .getByRole("button", { name: "Enviar link de recuperação" })
    .click();
  await expect(page.getByRole("status")).toContainText("Se houver uma conta");
  expect(calls.find((c) => c.path === "/api/recovery/request")?.body).toEqual({
    email: "recovery@example.test",
  });
});
test("displays safe invalid-link feedback without rendering supplied error descriptions", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto(
    "/reset-password?error=access_denied&error_description=private-attacker-text",
  );
  await expect(page.getByRole("alert")).toContainText("inválido");
  await expect(page.locator("body")).not.toContainText("private-attacker-text");
  await expect(page).toHaveURL("http://localhost:5173/reset-password");
  expect(calls).toEqual([]);
});
test("keeps the password form available after a provider policy failure", async ({
  page,
}) => {
  await mock(page, "policy");
  await page.goto(
    "/reset-password#token_hash=private-hash-fixture&type=recovery",
  );
  await page
    .getByLabel("Nova senha", { exact: true })
    .fill("Valid password fixture 123!");
  await page
    .getByLabel("Confirmar nova senha")
    .fill("Valid password fixture 123!");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.getByRole("alert")).toContainText("política de segurança");
  await expect(page.getByLabel("Nova senha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(
    page.getByRole("heading", { name: "Senha atualizada" }),
  ).toBeVisible();
});
test("reports provider outages without enabling an unverified password form", async ({
  page,
}) => {
  await mock(page, "outage");
  await page.goto(
    "/reset-password#token_hash=private-hash-fixture&type=recovery",
  );
  await expect(page.getByRole("alert")).toContainText("Tente novamente");
  await expect(page.getByLabel("Nova senha", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Tentar validar novamente" }),
  ).toBeVisible();
});
test("offers recovery from the existing login without changing its sign-in behavior", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Esqueci minha senha" }).click();
  await page.getByLabel("E-mail de recuperação").fill("recovery@example.test");
  await page
    .getByRole("button", { name: "Enviar link de recuperação" })
    .click();
  await expect(page.getByRole("status")).toContainText("Se houver uma conta");
  await page.getByRole("button", { name: "Voltar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Entrar no workspace" }),
  ).toBeVisible();
  expect(calls.filter((c) => c.path === "/api/recovery/request")).toHaveLength(
    1,
  );
});
