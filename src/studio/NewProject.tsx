import { useRef, useState, type FormEvent } from "react";
import type { Lead } from "../../shared/leads";
import {
  createStudioProjectSchema,
  type ProjectMode,
} from "../../shared/studio";
import { createProject } from "./api";
import { Modal } from "../components/Ui";
import { errorText } from "../format";
import { createRequestId } from "../request-id";
export function NewProject({
  leads,
  onClose,
  onCreated,
}: {
  leads: Lead[];
  onClose(): void;
  onCreated(id: string): void;
}) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<ProjectMode>("opportunity");
  const [lead, setLead] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef({ key: "", id: createRequestId() });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const key = JSON.stringify({ title, mode, lead });
      if (mutation.current.key !== key)
        mutation.current = { key, id: createRequestId() };
      const input = createStudioProjectSchema.safeParse({
        title,
        mode,
        lead_id: mode === "opportunity" ? lead : null,
        request_id: mutation.current.id,
      });
      if (!input.success)
        throw new Error(
          "Informe um título e escolha uma oportunidade válida ou o modo demonstração.",
        );
      const result = await createProject(input.data);
      onCreated(result.project_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Novo projeto" onClose={onClose} busy={busy}>
      <p className="small muted">
        O projeto guarda uma cópia das informações selecionadas. O cadastro
        original permanece no pipeline.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset className="studio-fieldset" disabled={busy}>
          <label htmlFor="project-mode">Tipo de projeto</label>
          <select
            id="project-mode"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as ProjectMode);
              setLead("");
            }}
          >
            <option value="opportunity">Vinculado a uma oportunidade</option>
            <option value="demo">Demonstração / empresa fictícia</option>
          </select>
          {mode === "opportunity" ? (
            <>
              <label htmlFor="project-lead">Oportunidade existente</label>
              <select
                id="project-lead"
                required
                value={lead}
                onChange={(e) => {
                  setLead(e.target.value);
                  if (!title)
                    setTitle(
                      leads.find((l) => l.id === e.target.value)?.company ?? "",
                    );
                }}
              >
                <option value="">Selecione uma oportunidade</option>
                {leads
                  .filter((l) => !l.deleted_at)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.company} · {l.city}
                    </option>
                  ))}
              </select>
              {!leads.some((l) => !l.deleted_at) && (
                <p className="small muted">
                  Cadastre uma oportunidade no painel ou escolha o modo
                  demonstração.
                </p>
              )}
            </>
          ) : (
            <p className="notice">
              Este projeto será identificado como demonstração. Preencha seu
              próprio conteúdo; nenhuma empresa será gerada automaticamente.
            </p>
          )}
          <label htmlFor="project-title">Título do projeto</label>
          <input
            id="project-title"
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="full">
            {busy ? "Criando…" : "Criar projeto"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}
