import type { LeadInput } from "../shared/leads";
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível concluir a operação.";
export const dateText = (value: string) =>
  new Date(value).toLocaleString("pt-BR");
export const labels: Record<keyof LeadInput, string> = {
  company: "Empresa",
  city: "Cidade",
  sector: "Segmento",
  contact: "Contato",
  site: "Presença digital",
  status: "Etapa",
  notes: "Observações",
};
