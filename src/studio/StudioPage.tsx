import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  FolderOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { Lead } from "../../shared/leads";
import type {
  BriefVersionMeta,
  StudioDetail,
  StudioProject,
} from "../../shared/studio";
import { ApiError } from "../api";
import { errorText } from "../format";
import { listBriefVersions, listProjects, projectDetail } from "./api";
import { NewProject } from "./NewProject";
import { BriefEditor } from "./BriefEditor";
export default function StudioPage({
  leads,
  onSessionExpired,
  onDirtyChange,
}: {
  leads: Lead[];
  onSessionExpired(): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<StudioDetail | null>(null);
  const [versions, setVersions] = useState<BriefVersionMeta[]>([]);
  const [moreVersions, setMoreVersions] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const dirty = useRef(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const listSequence = useRef(0);
  const historyPending = useRef(false);
  const changed = useCallback(
    (value: boolean) => {
      dirty.current = value;
      onDirtyChange(value);
    },
    [onDirtyChange],
  );
  function fail(e: unknown) {
    setError(errorText(e));
    if (e instanceof ApiError && [401, 403].includes(e.status))
      onSessionExpired();
  }
  async function load(page = offset) {
    const n = ++listSequence.current;
    setLoading(true);
    setListFailed(false);
    try {
      const r = await listProjects(page);
      if (alive.current && n === listSequence.current) {
        setProjects(r.projects);
        setOffset(page);
        setMore(r.projects.length === 50);
      }
    } catch (e) {
      if (alive.current && n === listSequence.current) {
        setListFailed(true);
        fail(e);
      }
    } finally {
      if (alive.current && n === listSequence.current) setLoading(false);
    }
  }
  async function open(id: string, version?: string, check = true) {
    if (
      check &&
      dirty.current &&
      !window.confirm("Descartar alterações não salvas do briefing?")
    )
      return;
    const n = ++sequence.current;
    setOpening(true);
    setError("");
    try {
      const [d, v] = await Promise.all([
        projectDetail(id, version),
        listBriefVersions(id),
      ]);
      if (alive.current && n === sequence.current) {
        setDetail(d);
        setEditorRevision((value) => value + 1);
        setVersions(v.versions);
        setMoreVersions(v.versions.length === 50);
        changed(false);
      }
    } catch (e) {
      if (alive.current && n === sequence.current) fail(e);
    } finally {
      if (alive.current && n === sequence.current) setOpening(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load(0);
    return () => {
      alive.current = false;
      sequence.current++;
      listSequence.current++;
      onDirtyChange(false);
    };
  }, []);
  async function moreHistory() {
    if (!detail || historyPending.current) return;
    historyPending.current = true;
    setError("");
    try {
      const id = detail.project.id;
      const n = sequence.current;
      const r = await listBriefVersions(id, versions.length);
      if (alive.current && n === sequence.current) {
        setVersions((prev) => [...prev, ...r.versions]);
        setMoreVersions(r.versions.length === 50);
      }
    } catch (e) {
      if (alive.current) fail(e);
    } finally {
      historyPending.current = false;
    }
  }
  return (
    <>
      <div className="page-heading studio-heading">
        <div>
          <span className="eyebrow">BLACK SALES AI · CREATIVE STUDIO</span>
          <h1>
            Creative Studio<span className="heading-dot">.</span>
          </h1>
          <p>
            Informações confiáveis. Direção criativa. Um briefing de cada vez.
          </p>
        </div>
        <button
          onClick={() => {
            if (
              !dirty.current ||
              window.confirm(
                "Descartar alterações não salvas do briefing ao abrir o novo projeto?",
              )
            )
              setCreating(true);
          }}
          disabled={opening}
        >
          <Plus size={17} /> Novo projeto
        </button>
      </div>
      <div className="studio-intro">
        <ClipboardList size={25} />
        <div>
          <strong>Antes de criar, entender.</strong>
          <p>
            Organize projetos, revise as informações e aprove a versão exata do
            briefing. Geração de sites e integrações de IA serão etapas futuras.
          </p>
        </div>
        <span className="foundation-badge">
          <ShieldCheck size={14} /> Etapa 1 · Briefings
        </span>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="studio-layout">
        <aside className="studio-projects panel">
          <div className="pipeline-heading">
            <h2>Seus projetos</h2>
            <button
              className="icon-button"
              aria-label="Atualizar projetos"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {loading ? (
            <p className="studio-list-note small muted">Carregando projetos…</p>
          ) : listFailed && !projects.length ? (
            <p className="studio-list-note">
              Não foi possível carregar os projetos. Use atualizar para tentar
              novamente.
            </p>
          ) : !projects.length ? (
            <div className="studio-list-note">
              <FolderOpen size={25} />
              <p>Nenhum projeto nesta página.</p>
              <button className="secondary" onClick={() => setCreating(true)}>
                Criar primeiro projeto
              </button>
            </div>
          ) : (
            <div className="studio-project-list">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={p.id === detail?.project.id ? "selected" : ""}
                  disabled={opening}
                  onClick={() => void open(p.id)}
                >
                  <strong>{p.title}</strong>
                  <span>
                    {p.mode === "demo" ? "Demonstração" : "Oportunidade"} ·{" "}
                    {p.head_approved ? "Briefing aprovado" : "Rascunho"}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="studio-list-pagination">
            <button
              className="secondary"
              disabled={loading || offset === 0}
              onClick={() => void load(Math.max(0, offset - 50))}
            >
              Anterior
            </button>
            <button
              className="secondary"
              disabled={loading || !more}
              onClick={() => void load(offset + 50)}
            >
              Próxima
            </button>
          </div>
        </aside>
        <div aria-busy={opening}>
          {opening && (
            <p className="notice" role="status">
              Abrindo briefing…
            </p>
          )}
          {detail ? (
            <fieldset className="studio-fieldset" disabled={opening}>
              <BriefEditor
                key={
                  detail.version.id +
                  ":" +
                  (detail.version.approval?.id ?? "draft") +
                  ":" +
                  editorRevision
                }
                detail={detail}
                versions={versions}
                hasMore={moreVersions}
                onMore={() => void moreHistory()}
                onVersion={(id) => void open(detail.project.id, id)}
                onDirtyChange={changed}
                onRefresh={async () => {
                  await open(detail.project.id, undefined, false);
                  await load();
                }}
              />
            </fieldset>
          ) : opening ? (
            <section className="panel empty">
              <RefreshCw size={26} />
              <h2>Carregando contexto…</h2>
            </section>
          ) : (
            <section className="panel empty studio-welcome">
              <span className="empty-icon">
                <ClipboardList size={30} />
              </span>
              <h2>Uma boa criação começa pelo contexto.</h2>
              <p>
                Escolha um projeto ou crie um novo. Nenhuma empresa ou
                informação será preenchida por IA.
              </p>
            </section>
          )}
        </div>
      </div>
      {creating && (
        <NewProject
          leads={leads}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void open(id, undefined, false);
            void load(0);
          }}
        />
      )}
    </>
  );
}
