import { describe, expect, it } from "vitest";
import {
  approvalIssues,
  briefChanges,
  briefFieldsSchema,
  changeBriefField,
  createStudioProjectSchema,
  emptyBrief,
  type BriefVersion,
} from "../shared/studio";
import { publicBriefContext } from "../shared/studio-ai";
describe("studio validation and future AI boundary", () => {
  it("starts empty, requires project identity and never fills a fictional company", () => {
    const fields = emptyBrief();
    expect(Object.keys(fields)).toHaveLength(13);
    expect(
      Object.values(fields).every(
        (f) => f.value === "" && !f.public_use && f.verification === "pending",
      ),
    ).toBe(true);
    expect(
      createStudioProjectSchema.safeParse({
        title: "Demo",
        mode: "demo",
        lead_id: null,
        request_id: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      createStudioProjectSchema.safeParse({
        title: "Demo",
        mode: "opportunity",
        lead_id: null,
        request_id: crypto.randomUUID(),
      }).success,
    ).toBe(false);
  });
  it.each([
    {
      company: {
        value: "x",
        source: "",
        verification: "verified",
        public_use: false,
      },
    },
    {
      company: {
        value: "x",
        source: "source",
        verification: "pending",
        public_use: true,
      },
    },
    {
      creative_notes: {
        value: "internal",
        source: "author",
        verification: "verified",
        public_use: true,
      },
    },
  ])("rejects invalid verification and public permissions %j", (patch) => {
    expect(
      briefFieldsSchema.safeParse({ ...emptyBrief(), ...patch }).success,
    ).toBe(false);
  });
  it("bounds text, rejects unknown fields, non-text and control characters", () => {
    for (const value of [100, "a".repeat(101), "a\u0000b"]) {
      const fields = emptyBrief();
      expect(
        briefFieldsSchema.safeParse({
          ...fields,
          company: { ...fields.company, value },
        }).success,
      ).toBe(false);
    }
    expect(
      briefFieldsSchema.safeParse({ ...emptyBrief(), owner_id: "injected" })
        .success,
    ).toBe(false);
    const fields = emptyBrief();
    expect(
      briefFieldsSchema.safeParse({
        ...fields,
        company: { ...fields.company, actor_id: "injected" },
      }).success,
    ).toBe(false);
    const { contacts: _, ...missing } = fields;
    expect(briefFieldsSchema.safeParse(missing).success).toBe(false);
  });
  it("resets verification and permission when content or its source changes", () => {
    const f = {
      value: "Verified synthetic data",
      source: "Synthetic source",
      verification: "verified" as const,
      public_use: true,
    };
    expect(changeBriefField(f, { value: "changed" })).toMatchObject({
      verification: "pending",
      public_use: false,
    });
    expect(changeBriefField(f, { source: "changed" })).toMatchObject({
      verification: "pending",
      public_use: false,
    });
    expect(changeBriefField(f, { verification: "pending" })).toMatchObject({
      public_use: false,
    });
    expect(changeBriefField(f, { value: f.value })).toEqual(f);
  });
  it("distinguishes incomplete drafts, verified briefings and explicitly fictional demos", () => {
    const fields = emptyBrief();
    expect(approvalIssues(fields, "demo")).toHaveLength(5);
    for (const key of [
      "company",
      "sector",
      "city",
      "services",
      "audience",
    ] as const)
      fields[key] = {
        value: "Synthetic test only",
        source: "Test fixture",
        verification: "fictional",
        public_use: false,
      };
    expect(approvalIssues(fields, "demo")).toEqual([]);
    expect(approvalIssues(fields, "opportunity")).toHaveLength(5);
    const after = structuredClone(fields);
    after.company.public_use = true;
    expect(briefChanges(fields, after)).toEqual(["company"]);
  });
  it("future context requires exact approval and excludes private or unverified information", () => {
    const fields = emptyBrief();
    fields.company = {
      value: "Synthetic demo",
      source: "Author",
      verification: "fictional",
      public_use: true,
    };
    fields.contacts = {
      value: "Private contact",
      source: "Owner",
      verification: "verified",
      public_use: false,
    };
    fields.services = {
      value: "Unverified",
      source: "",
      verification: "pending",
      public_use: true,
    };
    fields.creative_notes = {
      value: "Internal",
      source: "Author",
      verification: "verified",
      public_use: true,
    };
    const version = {
      id: "version",
      content_hash: "hash",
      fields,
      approval: { version_id: "version", content_hash: "hash" },
    } as BriefVersion;
    expect(publicBriefContext(version, "demo").publicInformation).toEqual({
      company: "Synthetic demo",
    });
    expect(
      publicBriefContext(version, "opportunity").publicInformation,
    ).toEqual({});
    expect(() =>
      publicBriefContext({ ...version, approval: null }, "demo"),
    ).toThrow("aprovação");
    expect(() =>
      publicBriefContext({ ...version, content_hash: "other" }, "demo"),
    ).toThrow("versão exata");
  });
});
