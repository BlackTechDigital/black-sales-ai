import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SITE_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
export const siteReviewRequestSchema = z
  .object({
    document_hash: hash,
    artifact_hash: hash,
    visual_hash: hash,
    request_id: z.uuid(),
    decision: z.enum(["approved", "changes_requested"]),
    confirm_review: z.literal(true),
    confirm_public_use: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.decision !== "approved" || value.confirm_public_use,
    { message: "Confirme o uso público antes de aprovar." },
  );
export const siteExportRequestSchema = z
  .object({
    document_hash: hash,
    artifact_hash: hash,
    visual_hash: hash,
    review_id: z.uuid(),
    confirm: z.literal(true),
  })
  .strict();
export const siteExportStatusSchema = z
  .object({
    version_id: z.uuid(),
    document_hash: hash,
    artifact_hash: hash.nullable(),
    visual_hash: hash.nullable().optional(),
    enabled: z.boolean(),
    can_review: z.boolean(),
    can_export: z.boolean(),
    code: z.enum([
      "ready",
      "export_disabled",
      "review_required",
      "review_changed",
      "brief_changed",
      "historical_unreviewed",
      "read_unavailable",
      "invalid_document",
    ]),
    message: z.string().max(600),
    review: z
      .object({
        id: z.uuid(),
        decision: z.enum(["approved", "changes_requested"]),
        created_at: z.iso.datetime({ offset: true }),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SiteExportStatus = z.infer<typeof siteExportStatusSchema>;
export type SiteReviewRequest = z.infer<typeof siteReviewRequestSchema>;
