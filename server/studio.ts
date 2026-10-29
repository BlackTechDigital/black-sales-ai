import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "./types";
import {
  createStudioProjectSchema,
  saveStudioBriefSchema,
  approveStudioBriefSchema,
} from "../shared/studio";
export function registerStudioRoutes(
  app: Hono<ApiEnv>,
  deps: {
    authenticate(c: Context<ApiEnv>): Promise<void>;
    readJson(c: Context<ApiEnv>): Promise<unknown>;
    databaseError(error: { code?: string } | null): void;
  },
) {
  for (const path of ["/api/studio", "/api/studio/*"])
    app.use(path, async (c, next) => {
      await deps.authenticate(c);
      await next();
    });
  const offset = (value: string | undefined) =>
    z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .parse(value ?? 0);
  app.get("/api/studio/projects", async (c) => {
    const r = await c
      .get("db")
      .rpc("studio_list_projects", { p_offset: offset(c.req.query("offset")) });
    deps.databaseError(r.error);
    return c.json({ projects: r.data ?? [] });
  });
  app.post("/api/studio/projects", async (c) => {
    const v = createStudioProjectSchema.parse(await deps.readJson(c));
    const r = await c.get("db").rpc("studio_create_project", {
      p_title: v.title,
      p_mode: v.mode,
      p_lead_id: v.lead_id,
      p_request_id: v.request_id,
    });
    deps.databaseError(r.error);
    return c.json(r.data, 201);
  });
  app.get("/api/studio/projects/:id", async (c) => {
    const r = await c.get("db").rpc("studio_project_detail", {
      p_id: z.uuid().parse(c.req.param("id")),
      p_version_id: null,
    });
    deps.databaseError(r.error);
    return c.json(r.data);
  });
  app.get("/api/studio/projects/:id/versions", async (c) => {
    const r = await c.get("db").rpc("studio_list_briefs", {
      p_id: z.uuid().parse(c.req.param("id")),
      p_offset: offset(c.req.query("offset")),
    });
    deps.databaseError(r.error);
    return c.json({ versions: r.data ?? [] });
  });
  app.get("/api/studio/projects/:id/versions/:version", async (c) => {
    const r = await c.get("db").rpc("studio_project_detail", {
      p_id: z.uuid().parse(c.req.param("id")),
      p_version_id: z.uuid().parse(c.req.param("version")),
    });
    deps.databaseError(r.error);
    return c.json(r.data);
  });
  app.post("/api/studio/projects/:id/briefs", async (c) => {
    const v = saveStudioBriefSchema.parse(await deps.readJson(c));
    const r = await c.get("db").rpc("studio_save_brief", {
      p_id: z.uuid().parse(c.req.param("id")),
      p_expected_head: v.expected_head_id,
      p_fields: v.fields,
      p_request_id: v.request_id,
    });
    deps.databaseError(r.error);
    return c.json(r.data, 201);
  });
  app.post("/api/studio/projects/:id/approvals", async (c) => {
    const v = approveStudioBriefSchema.parse(await deps.readJson(c));
    const r = await c.get("db").rpc("studio_approve_brief", {
      p_id: z.uuid().parse(c.req.param("id")),
      p_version_id: v.version_id,
      p_content_hash: v.content_hash,
    });
    deps.databaseError(r.error);
    return c.json(r.data);
  });
}
