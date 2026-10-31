import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../server/types";
import { getSiteGenerationEligibility } from "../server/studio-site-eligibility";
import { emptyBrief } from "../shared/studio";
import { REQUIRED_SITE_PUBLIC_FIELDS } from "../shared/studio-sites";

const user = "11111111-1111-4111-8111-111111111111",
  project = "22222222-2222-4222-8222-222222222222",
  version = "33333333-3333-4333-8333-333333333333",
  approval = "44444444-4444-4444-8444-444444444444",
  other = "55555555-5555-4555-8555-555555555555";
const hash = "a".repeat(64);
const request = {
  project_id: project,
  brief_version_id: version,
  brief_hash: hash,
};
function persisted() {
  const fields = emptyBrief();
  for (const key of REQUIRED_SITE_PUBLIC_FIELDS)
    fields[key] = {
      value: `${key}: conteúdo sintético autorizado`,
      source: "Origem privada da fixture",
      verification: "verified",
      public_use: true,
    };
  fields.contacts = {
    value: "Contato PRIVADO da fixture",
    source: "Documento confidencial",
    verification: "verified",
    public_use: false,
  };
  fields.creative_notes = {
    value: "Direção criativa PRIVADA",
    source: "Diretor",
    verification: "verified",
    public_use: false,
  };
  return {
    project: {
      id: project,
      head_id: version,
      mode: "opportunity",
      title: "Título interno privado",
      lead_snapshot: { contact: "Snapshot privado" },
    },
    version: {
      id: version,
      project_id: project,
      content_hash: hash,
      fields,
      approval: {
        id: approval,
        project_id: project,
        version_id: version,
        actor_id: user,
        content_hash: hash,
      } as Record<string, string> | null,
    },
  };
}
let record = persisted();
const rpc = vi.fn();
function authenticated(id: string | null = user, withDb = true) {
  return {
    get: (key: string) =>
      key === "user" ? (id ? { id } : undefined) : withDb ? { rpc } : undefined,
  } as unknown as Pick<Context<ApiEnv>, "get">;
}
beforeEach(() => {
  record = persisted();
  rpc.mockReset();
  rpc.mockImplementation(async () => ({ data: record, error: null }));
});
describe("server-side site generation eligibility (read only)", () => {
  it("reads the current database version and returns only publicly authorized information", async () => {
    const result = await getSiteGenerationEligibility(authenticated(), request);
    expect(result).toMatchObject({
      eligible: true,
      context: {
        project_id: project,
        brief_version_id: version,
        approval_id: approval,
        brief_hash: hash,
        mode: "opportunity",
      },
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("studio_project_detail", {
      p_id: project,
      p_version_id: null,
    });
    if (result.eligible)
      expect(Object.keys(result.context.public_information)).toEqual(
        REQUIRED_SITE_PUBLIC_FIELDS,
      );
    for (const privateText of [
      "PRIVADO",
      "PRIVADA",
      "Origem privada",
      "Documento confidencial",
      "Título interno",
      "Snapshot privado",
    ])
      expect(JSON.stringify(result)).not.toContain(privateText);
    expect(record.version.fields.contacts.value).toContain("PRIVADO");
  });
  it.each([null, "forged-id"])(
    "requires an authenticated backend context: %s",
    async (id) => {
      expect(
        await getSiteGenerationEligibility(authenticated(id), request),
      ).toMatchObject({ eligible: false, code: "authentication_required" });
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("does not read records without the middleware's scoped database client", async () => {
    expect(
      await getSiteGenerationEligibility(authenticated(user, false), request),
    ).toMatchObject({ eligible: false, code: "authentication_required" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { approved: true },
    { approval: { version_id: version, content_hash: hash } },
    { fields: emptyBrief() },
    { user_id: user },
    { mode: "demo" },
  ])("rejects frontend approval and context injection %j", async (extra) => {
    expect(
      await getSiteGenerationEligibility(authenticated(), {
        ...request,
        ...extra,
      }),
    ).toMatchObject({ eligible: false, code: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not accept a valid-looking request as proof of database approval", async () => {
    record.version.approval = null;
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "brief_not_approved" });
  });
  it.each([{ brief_version_id: other }, { brief_hash: "b".repeat(64) }])(
    "rejects stale expected version or hash %j",
    async (patch) => {
      expect(
        await getSiteGenerationEligibility(authenticated(), {
          ...request,
          ...patch,
        }),
      ).toMatchObject({ eligible: false, code: "brief_changed" });
    },
  );
  it("rejects historical data returned as the current project head", async () => {
    record.project.head_id = other;
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "brief_changed" });
  });
  it.each([
    { version_id: other },
    { content_hash: "b".repeat(64) },
    { project_id: other },
    { actor_id: other },
  ])(
    "requires exact approval bindings from persisted data %j",
    async (patch) => {
      Object.assign(record.version.approval!, patch);
      expect(
        await getSiteGenerationEligibility(authenticated(), request),
      ).toMatchObject({ eligible: false, code: "brief_not_approved" });
    },
  );
  it("rejects project/version mismatches and does not disclose inaccessible projects", async () => {
    record.version.project_id = other;
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "project_unavailable" });
    record = persisted();
    record.project.id = other;
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "project_unavailable" });
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "42501",
        message: "Private project exists / secret detail",
      },
    });
    const result = await getSiteGenerationEligibility(authenticated(), request);
    expect(result).toMatchObject({
      eligible: false,
      code: "project_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("reports missing public permissions by field key without leaking private values", async () => {
    for (const key of REQUIRED_SITE_PUBLIC_FIELDS)
      record.version.fields[key].public_use = false;
    const result = await getSiteGenerationEligibility(authenticated(), request);
    expect(result).toMatchObject({
      eligible: false,
      code: "insufficient_public_information",
      missing_fields: REQUIRED_SITE_PUBLIC_FIELDS,
    });
    expect(JSON.stringify(result)).not.toContain("conteúdo sintético");
    expect(result).not.toHaveProperty("context");
  });
  it.each(REQUIRED_SITE_PUBLIC_FIELDS)(
    "requires eligible public content for %s",
    async (key) => {
      record.version.fields[key].value = "";
      record.version.fields[key].source = "";
      record.version.fields[key].verification = "pending";
      record.version.fields[key].public_use = false;
      expect(
        await getSiteGenerationEligibility(authenticated(), request),
      ).toMatchObject({
        eligible: false,
        code: "insufficient_public_information",
        missing_fields: [key],
      });
    },
  );
  it("fails closed on unverified public content or malformed persisted records", async () => {
    record.version.fields.company.verification = "pending";
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "invalid_brief" });
    rpc.mockResolvedValue({
      data: { ...record, version: { ...record.version, fields: {} } },
      error: null,
    });
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "invalid_brief" });
    rpc.mockResolvedValue({ data: null, error: null });
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "read_unavailable" });
  });
  it("supports explicit fictional demo data and rejects it for opportunity projects", async () => {
    for (const key of REQUIRED_SITE_PUBLIC_FIELDS)
      record.version.fields[key].verification = "fictional";
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: false, code: "invalid_brief" });
    record.project.mode = "demo";
    expect(
      await getSiteGenerationEligibility(authenticated(), request),
    ).toMatchObject({ eligible: true, context: { mode: "demo" } });
  });
  it("preserves the original persisted strings used by the approved JSONB version", async () => {
    record.version.fields.company.value =
      "  Conteúdo sintético com espaços aprovados  ";
    const result = await getSiteGenerationEligibility(authenticated(), request);
    if (!result.eligible) throw new Error("Expected eligible fixture");
    expect(result.context.public_information.company).toBe(
      record.version.fields.company.value,
    );
  });
  it("sanitizes returned errors and thrown failures without logging payloads", async () => {
    const spies = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "log"),
    ];
    try {
      rpc.mockResolvedValue({
        data: null,
        error: { code: "PGRST999", message: "secret database detail" },
      });
      const result = await getSiteGenerationEligibility(
        authenticated(),
        request,
      );
      expect(result).toMatchObject({
        eligible: false,
        code: "read_unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      rpc.mockRejectedValue(new Error("secret thrown detail"));
      expect(
        await getSiteGenerationEligibility(authenticated(), request),
      ).toMatchObject({ eligible: false, code: "read_unavailable" });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
