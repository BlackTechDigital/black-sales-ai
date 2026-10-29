import type {
  ImportSummary,
  Lead,
  LeadEvent,
  LeadInput,
  LegacyLead,
} from "../shared/leads";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data &&
        typeof data === "object" &&
        "message" in data &&
        typeof data.message === "string"
        ? data.message
        : "Não foi possível concluir a operação.",
      response.status,
      data &&
        typeof data === "object" &&
        "code" in data &&
        typeof data.code === "string"
        ? data.code
        : undefined,
    );
  return data as T;
}
export async function getLeads(): Promise<Lead[]> {
  const all: Lead[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api<{ leads: Lead[] }>(`/leads?offset=${offset}`);
    all.push(...page.leads);
    if (page.leads.length < 200) return all;
  }
}
export async function getHistory(id: string): Promise<LeadEvent[]> {
  const all: LeadEvent[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api<{ events: LeadEvent[] }>(
      `/leads/${id}/history?offset=${offset}`,
    );
    all.push(...page.events);
    if (page.events.length < 200) return all;
  }
}
export const createLead = (values: LeadInput) =>
  api("/leads", { method: "POST", body: JSON.stringify(values) });
export const updateLead = (lead: Lead, values: LeadInput, archived?: boolean) =>
  api(`/leads/${lead.id}`, {
    method: "PATCH",
    body: JSON.stringify({ values, version: lead.version, archived }),
  });
export const importLeads = (records: LegacyLead[], commit: boolean) =>
  api<{ summary: ImportSummary }>("/leads/import", {
    method: "POST",
    body: JSON.stringify({ records, commit }),
  });
