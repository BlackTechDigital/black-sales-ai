import { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCheck,
  History,
  LockKeyhole,
  Save,
} from "lucide-react";
import {
  approvalIssues,
  briefChanges,
  briefFieldDefinitions,
  briefFieldsSchema,
  changeBriefField,
  verificationLabels,
  type BriefFields,
  type BriefVersionMeta,
  type StudioDetail,
} from "../../shared/studio";
import { approveBrief, saveBrief } from "./api";
import { dateText, errorText } from "../format";
import { Modal } from "../components/Ui";
export function BriefEditor({
  detail,
  versions,
  hasMore,
  onMore,
  onVersion,
  onRefresh,
  onDirtyChange,
}: {
  detail: StudioDetail;
  versions: BriefVersionMeta[];
  hasMore: boolean;
  onMore(): void;
  onVersion(id: string): void;
  onRefresh(): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}) {
  const { project, version } = detail;
  const historical = project.head_id !== version.id;
  const [fields, setFields] = useState<BriefFields>(version.fields);
  const [editingHistory, setEditingHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState(false);
  const [approving, setApproving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [committed, setCommitted] = useState(false);
  const request = useRef({ key: "", id: crypto.randomUUID() });
  const changes = briefChanges(version.fields, fields);
  const dirty = changes.length > 0 || editingHistory;
  const issues = approvalIssues(version.fields, project.mode);
  useEffect(() => {
    onDirtyChange(dirty && !committed);
  }, [dirty, committed, onDirtyChange]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty && !committed) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty, committed]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const parsed = briefFieldsSchema.safeParse(fields);
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const key = JSON.stringify({
        fields: parsed.data,
        base: project.head_id,
      });
      if (request.current.key !== key)
        request.current = { key, id: crypto.randomUUID() };
      const result = await saveBrief(
        project.id,
        project.head_id,
        parsed.data,
        request.current.id,
      );
      setCommitted(true);
      setReview(false);
      setNotice(
        `Versão ${result.number} salva. Atualize o briefing se a leitura não terminar.`,
      );
      await onRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    setBusy(true);
    setError("");
    try {
      await approveBrief(project.id, version.id, version.content_hash);
      setApproving(false);
      setNotice(`Aprovação da versão ${version.number} registrada.`);
      await onRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="studio-editor panel">
      <div className="studio-editor-heading">
        <div>
          <span className="eyebrow blue">BRIEFING VERSIONADO</span>
          <h2>{project.title}</h2>
          <p className="small muted">
            {project.mode === "demo"
              ? "Demonstração / empresa fictícia"
              : "Vinculado a uma oportunidade"}{" "}
            · v{version.number} · {version.approval ? "Aprovada" : "Rascunho"}
            {historical ? " · Versão histórica" : " · Versão atual"}
          </p>
        </div>
        <span className="foundation-badge">
          <LockKeyhole size={14} />{" "}
          {dirty && !committed ? "Alterações não salvas" : "Versão preservada"}
        </span>
      </div>
      {project.mode === "demo" && (
        <p className="notice">
          Projeto de demonstração. Conteúdo fictício deve ser marcado como tal e
          não representa uma empresa verificada.
        </p>
      )}
      {error && !review && !approving && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {project.lead_snapshot && (
        <details className="studio-snapshot">
          <summary>Ver snapshot da oportunidade</summary>
          <p className="small muted">
            Cópia feita na criação. A origem não comprova veracidade. Editar o
            briefing não altera o pipeline.
          </p>
          <p className="small">
            {String(project.lead_snapshot.company ?? "")} ·{" "}
            {String(project.lead_snapshot.city ?? "")} · revisão{" "}
            {String(project.lead_snapshot.version ?? "")}
          </p>
        </details>
      )}
      <div className="studio-history">
        <label htmlFor="brief-history">
          <History size={14} /> Histórico do briefing
        </label>
        <select
          id="brief-history"
          value={version.id}
          disabled={busy || committed}
          onChange={(e) => onVersion(e.target.value)}
        >
          {!versions.some((v) => v.id === version.id) && (
            <option value={version.id}>Versão {version.number}</option>
          )}
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              Versão {v.number} · {v.approval ? "Aprovada" : "Rascunho"} ·{" "}
              {dateText(v.created_at)}
            </option>
          ))}
        </select>
        {hasMore && (
          <button className="secondary" onClick={onMore}>
            Mais versões
          </button>
        )}
      </div>
      {version.approval && (
        <p className="small muted">
          <Check size={13} /> Aprovação registrada em{" "}
          {dateText(version.approval.created_at)} · responsável{" "}
          {version.approval.actor_id}. Aprovar o briefing não publica um site.
        </p>
      )}
      {historical && !editingHistory && (
        <button
          className="secondary"
          disabled={busy || committed}
          onClick={() => {
            setEditingHistory(true);
            setNotice(
              "Conteúdo histórico carregado. Salvar criará uma nova versão atual, sem modificar o histórico.",
            );
          }}
        >
          Usar como novo rascunho
        </button>
      )}
      <p className="small muted">
        Campos com * são necessários para aprovação. Salve rascunhos
        incompletos. Ao alterar conteúdo ou origem, a verificação e o uso
        público são redefinidos. As observações do diretor permanecem internas.
      </p>
      <fieldset
        className="studio-fieldset"
        disabled={busy || committed || (historical && !editingHistory)}
      >
        {[...new Set(briefFieldDefinitions.map((d) => d.group))].map(
          (group) => (
            <details className="studio-group" key={group} open>
              <summary>{group}</summary>
              {briefFieldDefinitions
                .filter((d) => d.group === group)
                .map((d) => {
                  const field = fields[d.key];
                  return (
                    <div className="studio-field" key={d.key}>
                      <label htmlFor={`brief-${d.key}`}>
                        {d.label}
                        {d.required ? " *" : ""}
                      </label>
                      {d.max <= 100 ? (
                        <input
                          id={`brief-${d.key}`}
                          value={field.value}
                          maxLength={d.max}
                          onChange={(e) =>
                            setFields({
                              ...fields,
                              [d.key]: changeBriefField(field, {
                                value: e.target.value,
                              }),
                            })
                          }
                        />
                      ) : (
                        <textarea
                          id={`brief-${d.key}`}
                          rows={3}
                          maxLength={d.max}
                          value={field.value}
                          onChange={(e) =>
                            setFields({
                              ...fields,
                              [d.key]: changeBriefField(field, {
                                value: e.target.value,
                              }),
                            })
                          }
                        />
                      )}
                      <div className="studio-field-meta">
                        <div>
                          <label htmlFor={`source-${d.key}`}>
                            Origem — {d.label}
                          </label>
                          <input
                            id={`source-${d.key}`}
                            maxLength={500}
                            value={field.source}
                            placeholder="Fonte, documento ou declaração do responsável"
                            onChange={(e) =>
                              setFields({
                                ...fields,
                                [d.key]: changeBriefField(field, {
                                  source: e.target.value,
                                }),
                              })
                            }
                          />
                        </div>
                        <div>
                          <label htmlFor={`verification-${d.key}`}>
                            Verificação — {d.label}
                          </label>
                          <select
                            id={`verification-${d.key}`}
                            value={field.verification}
                            onChange={(e) =>
                              setFields({
                                ...fields,
                                [d.key]: changeBriefField(field, {
                                  verification: e.target
                                    .value as typeof field.verification,
                                }),
                              })
                            }
                          >
                            {Object.entries(verificationLabels)
                              .filter(
                                ([key]) =>
                                  key !== "fictional" ||
                                  project.mode === "demo",
                              )
                              .map(([key, label]) => (
                                <option key={key} value={key}>
                                  {label}
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>
                      {d.key !== "creative_notes" && (
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={field.public_use}
                            disabled={
                              !field.value ||
                              !field.source ||
                              field.verification === "pending"
                            }
                            onChange={(e) =>
                              setFields({
                                ...fields,
                                [d.key]: {
                                  ...field,
                                  public_use: e.target.checked,
                                },
                              })
                            }
                          />
                          Uso público — {d.label}
                        </label>
                      )}
                    </div>
                  );
                })}
            </details>
          ),
        )}
      </fieldset>
      <div className="studio-savebar">
        <span className="small muted">
          v{version.number} · {dateText(version.created_at)}
          <br />
          Hash: <code className="studio-hash">{version.content_hash}</code>
        </span>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (
              !dirty ||
              committed ||
              window.confirm(
                "Descartar alterações não salvas e carregar a versão atual?",
              )
            )
              void onRefresh();
          }}
        >
          Atualizar briefing
        </button>
        <button
          disabled={busy || committed || !dirty}
          onClick={() => {
            setError("");
            setReview(true);
          }}
        >
          <Save size={15} /> Revisar e salvar rascunho
        </button>
        <button
          className="secondary"
          disabled={
            busy ||
            committed ||
            dirty ||
            historical ||
            Boolean(version.approval) ||
            issues.length > 0
          }
          onClick={() => {
            setConfirmed(false);
            setError("");
            setApproving(true);
          }}
        >
          <ClipboardCheck size={16} /> Aprovar versão {version.number}
        </button>
      </div>
      {!version.approval && issues.length > 0 && (
        <details className="studio-approval-issues">
          <summary>
            {issues.length} pendência(s) para aprovar esta versão salva
          </summary>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
      {review && (
        <Modal
          title="Revisar alterações do briefing"
          busy={busy}
          onClose={() => setReview(false)}
        >
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <p className="small muted">
            O salvamento cria uma versão nova.{" "}
            {editingHistory
              ? "O conteúdo será copiado da versão histórica e terá a versão atual como antecessora."
              : "A versão anterior será preservada."}
          </p>
          <div className="studio-diff">
            {(editingHistory
              ? briefFieldDefinitions.map((d) => d.key)
              : changes
            ).map((key) => {
              const d = briefFieldDefinitions.find((d) => d.key === key)!;
              return (
                <article key={key}>
                  <strong>{d.label}</strong>
                  {!editingHistory && (
                    <p className="small muted">
                      <s>{version.fields[key].value || "Não informado"}</s>
                    </p>
                  )}
                  <p>{fields[key].value || "Não informado"}</p>
                  <p className="small muted">
                    Origem: {fields[key].source || "Pendente"}
                    <br />
                    {verificationLabels[fields[key].verification]} ·{" "}
                    {fields[key].public_use
                      ? "Uso público autorizado"
                      : "Uso interno"}
                  </p>
                </article>
              );
            })}
          </div>
          <button className="full" disabled={busy} onClick={save}>
            {busy ? "Salvando…" : "Salvar nova versão"}
          </button>
        </Modal>
      )}
      {approving && (
        <Modal
          title={`Aprovar briefing v${version.number}?`}
          busy={busy}
          onClose={() => setApproving(false)}
        >
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <p>
            Esta aprovação será vinculada à versão{" "}
            <strong>{version.number}</strong> e ao seu conteúdo imutável. Uma
            nova versão precisará de nova aprovação.
          </p>
          <p className="small muted">
            Aprovar não autoriza publicação automática. Somente informações
            marcadas para uso público poderão compor conteúdo público em etapas
            futuras.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Revisei esta versão exata e aprovo o briefing.
          </label>
          <button
            className="full"
            disabled={busy || !confirmed}
            onClick={approve}
          >
            {busy ? "Registrando…" : "Confirmar aprovação"}
          </button>
        </Modal>
      )}
    </section>
  );
}
