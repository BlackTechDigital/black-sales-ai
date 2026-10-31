export const aiErrorMessages = {
  disabled: "A geração por IA está desativada.",
  configuration_invalid:
    "A configuração de IA precisa ser revisada no servidor.",
  authentication_required: "Entre com uma conta autorizada para continuar.",
  invalid_request: "Informe somente o identificador do trabalho de geração.",
  job_unavailable: "Trabalho indisponível para esta conta ou estado.",
  brief_unavailable:
    "O briefing atual precisa estar aprovado e autorizado para uso público.",
  brief_changed: "O briefing mudou. Revise o trabalho antes de continuar.",
  input_limit: "O contexto excede o limite configurado para uma geração.",
  output_limit: "A resposta excedeu os limites de geração.",
  timeout: "O provedor não respondeu dentro do tempo permitido.",
  cancelled: "A chamada de geração foi interrompida.",
  provider_auth: "O provedor recusou a autenticação configurada no servidor.",
  provider_rate_limited: "O provedor atingiu seu limite de uso.",
  provider_unavailable: "O provedor de IA está indisponível.",
  provider_invalid_response:
    "O provedor não retornou um documento de site válido.",
  quota_exceeded: "A cota configurada para geração foi atingida.",
  duplicate_request:
    "Este trabalho já reservou uma chamada de IA. Não será enviado novamente.",
  guard_unavailable:
    "Não foi possível reservar a cota de geração com segurança.",
} as const;
export type SiteAIErrorCode = keyof typeof aiErrorMessages;
export class SiteAIError extends Error {
  readonly code: SiteAIErrorCode;
  constructor(code: SiteAIErrorCode) {
    super(aiErrorMessages[code]);
    this.name = "SiteAIError";
    this.code = code;
  }
}
