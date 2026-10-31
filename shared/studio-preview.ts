import { z } from "zod";
import { siteVersionSummarySchema } from "./studio-generation";

export const previewVersionsSchema = z
  .object({
    versions: z.array(siteVersionSummarySchema).max(20),
    current_version_id: z.uuid().nullable(),
    current_brief_version_id: z.uuid().nullable(),
    has_more: z.boolean(),
  })
  .strict();
export const previewVersionSchema = z
  .object({
    version: siteVersionSummarySchema,
    // Optional for compatibility with the previous preview API. Export requires
    // this fingerprint to bind the displayed renderer to the reviewed artifact.
    visual_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    current_version_id: z.uuid().nullable(),
    current_brief_version_id: z.uuid().nullable(),
  })
  .strict();
export type PreviewVersions = z.infer<typeof previewVersionsSchema>;
export type PreviewVersion = z.infer<typeof previewVersionSchema>;
export const PREVIEW_VIEWPORTS = {
  desktop: { label: "Desktop", width: 1280, height: 900 },
  tablet: { label: "Tablet", width: 768, height: 1024 },
  mobile: { label: "Celular", width: 390, height: 844 },
} as const;
