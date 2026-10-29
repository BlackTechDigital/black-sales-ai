import { z } from "zod";

export const recoveryProofSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tokenHash"),
      tokenHash: z.string().min(16).max(2048),
    })
    .strict(),
  z
    .object({
      kind: z.literal("code"),
      code: z.string().min(1).max(2048),
      flowId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{8,64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      accessToken: z.string().min(1).max(8192),
      refreshToken: z.string().min(1).max(2048),
    })
    .strict(),
]);
export type RecoveryProof = z.infer<typeof recoveryProofSchema>;
export const recoveryPasswordSchema = z
  .object({
    password: z
      .string()
      .min(12, "Use uma senha com pelo menos 12 caracteres.")
      .max(128, "Use uma senha com até 128 caracteres."),
    confirmation: z.string(),
  })
  .strict()
  .refine((input) => input.password === input.confirmation, {
    message: "As senhas precisam ser iguais.",
    path: ["confirmation"],
  });

export interface RecoveryEntry {
  proof?: RecoveryProof;
  invalid?: boolean;
}
const callbackKeys = [
  "token_hash",
  "code",
  "access_token",
  "refresh_token",
  "error",
  "error_code",
  "error_description",
  "sb_flow_id",
];

// Parse once before React mounts. Fragments never reach the HTTP server.
export function readRecoveryEntry(
  location: Pick<Location, "href">,
  replace: (path: string) => void,
): RecoveryEntry | null {
  const url = new URL(location.href);
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const isCallback = callbackKeys.some(
    (key) => query.has(key) || fragment.has(key),
  );
  if (
    !isCallback &&
    ![
      "/reset-password",
      "/update-password",
      "/auth/callback",
      "/auth/confirm",
    ].includes(url.pathname)
  )
    return null;
  // Remove codes, tokens and attacker-controlled error descriptions from URL/history.
  replace("/reset-password");
  if (!isCallback) return {};
  for (const key of [...callbackKeys, "type"]) {
    if (query.getAll(key).length + fragment.getAll(key).length > 1)
      return { invalid: true };
  }
  const get = (key: string) => fragment.get(key) ?? query.get(key);
  if (get("error") || get("error_code")) return { invalid: true };
  const forms = [
    get("token_hash"),
    get("code"),
    get("access_token") || get("refresh_token"),
  ].filter(Boolean).length;
  if (forms !== 1) return { invalid: true };
  let proof: unknown;
  if (get("token_hash") && get("type") === "recovery")
    proof = { kind: "tokenHash", tokenHash: get("token_hash") };
  else if (get("code") && (!get("type") || get("type") === "recovery"))
    proof = {
      kind: "code",
      code: get("code"),
      ...(get("sb_flow_id") ? { flowId: get("sb_flow_id") } : {}),
    };
  else if (
    get("access_token") &&
    get("refresh_token") &&
    get("type") === "recovery"
  )
    proof = {
      kind: "session",
      accessToken: get("access_token"),
      refreshToken: get("refresh_token"),
    };
  const parsed = recoveryProofSchema.safeParse(proof);
  return parsed.success ? { proof: parsed.data } : { invalid: true };
}
