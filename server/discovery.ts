import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  discoveryImportSchema,
  discoveryQuerySchema,
} from "../shared/discovery";
import type { ApiEnv } from "./types";
import { discoveryProviders } from "./discovery-sources";

export function registerDiscoveryRoutes(
  app: Hono<ApiEnv>,
  deps: {
    authenticate(c: Context<ApiEnv>): Promise<void>;
    readJson(c: Context<ApiEnv>): Promise<unknown>;
    databaseError(error: { code?: string } | null): void;
  },
) {
  for (const path of ["/api/discovery", "/api/discovery/*"])
    app.use(path, async (c, next) => {
      await deps.authenticate(c);
      await next();
    });
  app.get("/api/discovery/sources", (c) =>
    c.json({
      providers: discoveryProviders.map(({ id, name }) => ({ id, name })),
      manual: true,
    }),
  );
  app.get("/api/discovery", async (c) => {
    const query = discoveryQuerySchema.parse(c.req.query());
    const result = await c.get("db").rpc("list_discovery_results", {
      p_city: query.city,
      p_state: query.state,
      p_sector: query.sector,
      p_offset: query.offset,
    });
    deps.databaseError(result.error);
    return c.json({ results: result.data ?? [] });
  });
  app.post("/api/discovery/import", async (c) => {
    const input = discoveryImportSchema.parse(await deps.readJson(c));
    const result = await c.get("db").rpc("import_discovery_results", {
      p_source: input.source,
      p_records: input.records,
      p_commit: input.commit,
    });
    deps.databaseError(result.error);
    return c.json({ summary: result.data });
  });
  app.post("/api/discovery/:id/promote", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    z.object({})
      .strict()
      .parse(await deps.readJson(c));
    const result = await c
      .get("db")
      .rpc("promote_discovery_result", { p_id: id });
    deps.databaseError(result.error);
    return c.json(result.data);
  });
}
