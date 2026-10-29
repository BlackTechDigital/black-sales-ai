import type { SupabaseClient, SupportedStorage } from "@supabase/supabase-js";
export interface Bindings {
  APP_ORIGIN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}
export type ApiEnv = {
  Bindings: Bindings;
  Variables: { db: SupabaseClient; user: { id: string; email?: string } };
};
export type ClientFactory = (
  env: Bindings,
  token?: string,
  recoveryStorage?: SupportedStorage,
) => SupabaseClient;
