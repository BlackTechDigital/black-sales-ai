import type {
  DiscoveryQuery,
  DiscoveryRecord,
  DiscoverySource,
} from "../shared/discovery";

// Server-only extension point. Register a provider only after checking its terms,
// authorized API, quotas, retention rules, and server-side secret bindings.
// User-supplied source/website URLs are metadata; they are never fetched.
export interface AuthorizedDiscoverySource {
  id: string;
  name: string;
  search(
    query: DiscoveryQuery,
    signal: AbortSignal,
  ): Promise<{
    source: DiscoverySource;
    records: DiscoveryRecord[];
  }>;
}
export const discoveryProviders: readonly AuthorizedDiscoverySource[] = [];
