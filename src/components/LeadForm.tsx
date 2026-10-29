import { useState, type FormEvent } from "react";
import { Plus, ChevronRight, ShieldCheck } from "lucide-react";
import {
  emptyLead,
  leadInputSchema,
  pickLeadValues,
  sectors,
  sites,
  siteLabels,
  statuses,
  type Lead,
  type LeadInput,
} from "../../shared/leads";
export function LeadForm({
  lead,
  busy,
  onSave,
  onCancel,
}: {
  lead: Lead | null;
  busy: boolean;
  onSave: (values: LeadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<LeadInput>(
    lead ? pickLeadValues(lead) : { ...emptyLead },
  );
  const [error, setError] = useState("");
  const field = (name: keyof LeadInput, value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = leadInputSchema.safeParse(values);
    if (!result.success) {
      setError(result.error.issues[0].message);
      return;
    }
    setError("");
    await onSave(result.data);
  }
  return (
    <section className="panel form-panel">
      <div className="panel-heading">
        <span className="square-icon">
          <Plus size={19} />
        </span>
        <div>
          <h2>{lead ? "Editar oportunidade" : "Nova oportunidade"}</h2>
          <p>Comece com o que você já sabe.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <label htmlFor="company">
            Nome da empresa <span>*</span>
          </label>
          <input
            id="company"
            autoFocus={Boolean(lead)}
            value={values.company}
            onChange={(e) => field("company", e.target.value)}
            required
            maxLength={100}
            placeholder="Nome da empresa"
          />
          <label htmlFor="city">
            Cidade <span>*</span>
          </label>
          <input
            id="city"
            value={values.city}
            onChange={(e) => field("city", e.target.value)}
            required
            maxLength={80}
            placeholder="Cidade e estado"
          />
          <label htmlFor="sector">Segmento</label>
          <select
            id="sector"
            value={values.sector}
            onChange={(e) => field("sector", e.target.value)}
          >
            <option value="">Não informado</option>
            {!sectors.includes(values.sector) && values.sector && (
              <option>{values.sector}</option>
            )}
            {sectors.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <label htmlFor="contact">
            Contato público <small>opcional</small>
          </label>
          <input
            id="contact"
            value={values.contact}
            onChange={(e) => field("contact", e.target.value)}
            maxLength={160}
            placeholder="Site, Instagram ou telefone comercial"
          />
          <label htmlFor="site">Presença digital</label>
          <select
            id="site"
            value={values.site}
            onChange={(e) => field("site", e.target.value)}
          >
            {sites.map((value) => (
              <option key={value} value={value}>
                {siteLabels[value]}
              </option>
            ))}
          </select>
          <p className="field-help">
            Classificação manual. Nenhuma análise automática é realizada.
          </p>
          <label htmlFor="status">Etapa comercial</label>
          <select
            id="status"
            value={values.status}
            onChange={(e) => field("status", e.target.value)}
          >
            {statuses.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <label htmlFor="notes">
            Observações <small>opcional</small>
          </label>
          <textarea
            id="notes"
            value={values.notes}
            onChange={(e) => field("notes", e.target.value)}
            maxLength={600}
            placeholder="Contexto profissional e próximos passos"
            rows={3}
          />
          <button className="full" disabled={busy}>
            {busy
              ? "Salvando…"
              : lead
                ? "Salvar alterações"
                : "Salvar oportunidade"}
            <ChevronRight size={17} />
          </button>
          {lead && (
            <button
              type="button"
              className="secondary full"
              disabled={busy}
              onClick={onCancel}
            >
              Cancelar edição
            </button>
          )}
        </fieldset>
      </form>
      <p className="form-footer">
        <ShieldCheck size={15} /> Informe apenas dados necessários à prospecção.
      </p>
    </section>
  );
}
