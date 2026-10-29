import type {
  DiscoveryQuery,
  DiscoveryResult,
  DiscoverySource,
  DiscoveryRecord,
  DiscoverySummary,
  PromotionResult,
} from "../shared/discovery";
import { api } from "./api";
export const getDiscoveryResults = (query: DiscoveryQuery) => {
  const params = new URLSearchParams({
    city: query.city,
    state: query.state,
    sector: query.sector,
    offset: String(query.offset),
  });
  return api<{ results: DiscoveryResult[] }>(`/discovery?${params}`);
};
export const importDiscovery = (
  source: DiscoverySource,
  records: DiscoveryRecord[],
  commit: boolean,
) =>
  api<{ summary: DiscoverySummary }>("/discovery/import", {
    method: "POST",
    body: JSON.stringify({ source, records, commit }),
  });
export const promoteDiscovery = (id: string) =>
  api<PromotionResult>(`/discovery/${id}/promote`, {
    method: "POST",
    body: "{}",
  });
