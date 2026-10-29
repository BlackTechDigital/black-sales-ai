import { useState, useRef, useEffect, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  FileJson,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  emptyLead,
  leadInputSchema,
  siteLabels,
  statuses,
  toLegacyExport,
  type Lead,
  type LeadInput,
} from "../shared/leads";
import { api, ApiError, createLead, getLeads, updateLead } from "./api";
import { errorText } from "./format";
import type { Notice, User } from "./types";
import { Brand, Modal, downloadJson } from "./components/Ui";
import { LeadForm } from "./components/LeadForm";
import { DraftModal } from "./components/DraftModal";
import { HistoryModal } from "./components/HistoryModal";
import { ImportModal } from "./components/ImportModal";
export default function Dashboard({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => void;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState<Lead | null>(null);
  const [draft, setDraft] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Lead | null>(null);
  const [importing, setImporting] = useState(false);
  const alive = useRef(true);
  async function load() {
    setLoading(true);
    try {
      const data = await getLeads();
      if (alive.current) setLeads(data);
    } catch (e) {
      if (alive.current) {
        setNotice({ kind: "error", text: errorText(e) });
        if (e instanceof ApiError && [401, 403].includes(e.status)) onLogout();
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  async function action(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice(null);
    try {
      await task();
      setNotice({ kind: "success", text: message });
      await load();
      return true;
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const active = leads.filter((lead) => !lead.deleted_at);
  const shown = leads.filter(
    (lead) =>
      Boolean(lead.deleted_at) === archived &&
      (!filter || lead.status === filter) &&
      [lead.company, lead.city, lead.sector]
        .join(" ")
        .toLocaleLowerCase("pt-BR")
        .includes(search.toLocaleLowerCase("pt-BR")),
  );
  async function save(values: LeadInput) {
    const ok = await action(
      () => (editing ? updateLead(editing, values) : createLead(values)),
      editing ? "Alterações salvas com histórico." : "Oportunidade cadastrada.",
    );
    if (ok) {
      setEditing(null);
      setFormRevision((value) => value + 1);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const result = await api<{ message: string }>("/logout", {
        method: "POST",
        body: "{}",
      });
      if (result.message.includes("não pôde")) window.alert(result.message);
      onLogout();
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-section">WORKSPACE</div>
        <a href="#overview" className="nav-item current">
          <LayoutDashboard size={18} /> Visão geral <span className="nav-dot" />
        </a>
        <a href="#pipeline" className="nav-item">
          <Users size={18} /> Oportunidades{" "}
          <span className="nav-count">{active.length}</span>
        </a>
        <div className="sidebar-bottom">
          <div className="human-card">
            <ShieldCheck size={22} />
            <strong>Você no controle.</strong>
            <p>Abordagens com revisão humana e envio manual.</p>
          </div>
          <span className="sidebar-label">BLACK TECH</span>
          <span className="small muted">Tecnologia que conecta negócios.</span>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>Visão geral</strong>
          </span>
          <div className="account">
            <span className="connection">
              <span /> Conectado
            </span>
            <span className="avatar" title={user.email}>
              {user.email?.[0]?.toUpperCase() ?? "B"}
            </span>
            <button
              className="icon-button"
              title="Sair"
              aria-label="Sair da conta"
              onClick={logout}
              disabled={busy}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main id="overview">
          <div className="page-heading">
            <div>
              <span className="eyebrow">SEU CENTRO DE PROSPECÇÃO</span>
              <h1>
                Visão geral<span className="heading-dot">.</span>
              </h1>
              <p>Transforme boas conversas em novas oportunidades.</p>
            </div>
            <span className="foundation-badge">
              <ShieldCheck size={15} /> Fundação 2.0
            </span>
          </div>
          {notice && (
            <div
              className={`notice ${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.text}
              <button
                className="icon-button"
                aria-label="Fechar aviso"
                onClick={() => setNotice(null)}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <section className="stats" aria-label="Indicadores">
            <Stat
              title="Empresas cadastradas"
              value={active.length}
              icon={<Users size={20} />}
              note="Oportunidades no seu pipeline"
            />
            <Stat
              title="Oportunidades prioritárias"
              value={
                active.filter((lead) => ["none", "basic"].includes(lead.site))
                  .length
              }
              icon={<Sparkles size={20} />}
              note="Segundo classificação manual"
            />
            <Stat
              title="Em negociação"
              value={
                active.filter((lead) => lead.status === "Em negociação").length
              }
              icon={<ArrowUpRight size={20} />}
              note="Conversas que estão avançando"
            />
          </section>
          <div className="content-grid">
            <LeadForm
              key={
                editing
                  ? `${editing.id}-${editing.version}`
                  : `new-${formRevision}`
              }
              lead={editing}
              busy={busy || loading}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
            <section className="panel pipeline" id="pipeline">
              <div className="pipeline-heading">
                <div>
                  <h2>
                    Pipeline de prospecção{" "}
                    <span className="count-badge">{shown.length}</span>
                  </h2>
                  <p>Cada oportunidade, um próximo passo.</p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Atualizar oportunidades"
                  onClick={load}
                  disabled={busy || loading}
                >
                  <RefreshCw size={17} />
                </button>
              </div>
              <div className="list-tabs">
                <button
                  className={!archived ? "selected" : ""}
                  onClick={() => setArchived(false)}
                >
                  Oportunidades
                </button>
                <button
                  className={archived ? "selected" : ""}
                  onClick={() => setArchived(true)}
                >
                  Lixeira <span>{leads.length - active.length}</span>
                </button>
              </div>
              <div className="toolbar">
                <div className="search-input">
                  <Search size={16} />
                  <input
                    aria-label="Buscar empresa, cidade ou segmento"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar empresa, cidade ou segmento"
                  />
                </div>
                <select
                  aria-label="Filtrar por etapa"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="">Todas as etapas</option>
                  {statuses.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div className="lead-list" aria-busy={loading}>
                {loading ? (
                  <div className="empty">
                    <RefreshCw size={26} />
                    <h3>Carregando oportunidades…</h3>
                  </div>
                ) : shown.length === 0 ? (
                  <div className="empty">
                    <span className="empty-icon">
                      <Users size={29} />
                    </span>
                    <h3>
                      {search || filter
                        ? "Nenhum resultado por aqui"
                        : archived
                          ? "Sua lixeira está vazia"
                          : "Sua próxima oportunidade começa aqui"}
                    </h3>
                    <p>
                      {search || filter
                        ? "Tente outro termo ou outra etapa."
                        : archived
                          ? "Registros excluídos ficam preservados para restauração."
                          : "Cadastre uma empresa ou importe seu backup da versão 1.0."}
                    </p>
                    {!archived && !search && !filter && (
                      <span className="empty-hint">
                        <Plus size={14} /> Use o formulário ao lado para começar
                      </span>
                    )}
                  </div>
                ) : (
                  shown.map((lead) => (
                    <article className="lead" key={lead.id}>
                      <div className="lead-top">
                        <div className="company-avatar">
                          {lead.company[0]?.toUpperCase()}
                        </div>
                        <div className="lead-title">
                          <h3>{lead.company}</h3>
                          <p>
                            {lead.city} <span>·</span>{" "}
                            {lead.sector || "Segmento não informado"}
                          </p>
                        </div>
                        <span
                          className={`status-pill status-${statuses.indexOf(lead.status)}`}
                        >
                          {lead.status}
                        </span>
                      </div>
                      {lead.contact && (
                        <p className="lead-detail">{lead.contact}</p>
                      )}
                      {lead.notes && <p className="lead-notes">{lead.notes}</p>}
                      <p className="lead-source">
                        {siteLabels[lead.site]} ·{" "}
                        {lead.source === "v1_import"
                          ? "Legado v1; análise não verificada"
                          : "Classificação manual"}
                      </p>
                      <div className="lead-actions">
                        {!archived ? (
                          <>
                            <button
                              className="text-button blue"
                              onClick={() => setDraft(lead)}
                              disabled={busy}
                            >
                              <Sparkles size={14} /> Preparar abordagem
                            </button>
                            <button
                              className="text-button"
                              onClick={() => {
                                setEditing(lead);
                                document.getElementById("company")?.focus();
                              }}
                              disabled={busy}
                            >
                              <Pencil size={14} /> Editar / etapa
                            </button>
                          </>
                        ) : (
                          <button
                            className="text-button blue"
                            disabled={busy}
                            onClick={() =>
                              action(
                                () =>
                                  updateLead(
                                    lead,
                                    leadInputSchema.parse(
                                      Object.fromEntries(
                                        Object.keys(emptyLead).map((key) => [
                                          key,
                                          lead[key as keyof LeadInput],
                                        ]),
                                      ),
                                    ),
                                    false,
                                  ),
                                "Oportunidade restaurada.",
                              )
                            }
                          >
                            <RefreshCw size={14} /> Restaurar
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() => setHistory(lead)}
                          disabled={busy}
                        >
                          <History size={14} /> Histórico
                        </button>
                        {!archived && (
                          <button
                            className="icon-button delete-button"
                            aria-label={`Excluir ${lead.company}`}
                            onClick={() => setDeleting(lead)}
                            disabled={busy}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </article>
                  ))
                )}
              </div>
              <div className="pipeline-footer">
                <div className="backup-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      downloadJson(
                        toLegacyExport(active),
                        "black-sales-ai-backup-v1.json",
                      );
                      setNotice({
                        kind: "success",
                        text: "Registros ativos exportados em formato v1. Lixeira e histórico permanecem no banco e exigem backup do PostgreSQL.",
                      });
                    }}
                    disabled={busy || loading || !active.length}
                  >
                    <ArrowDownToLine size={15} /> Exportar ativos
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setImporting(true)}
                    disabled={busy || loading}
                  >
                    <FileJson size={15} /> Importar backup
                  </button>
                </div>
                <p>
                  <LockKeyhole size={13} /> Seus registros são protegidos pelo
                  seu acesso.
                </p>
              </div>
            </section>
          </div>
          <div className="bottom-note">
            <CircleHelp size={15} />
            <span>
              Dados reais, contexto relevante e revisão humana. Nenhuma mensagem
              é enviada automaticamente.
            </span>
          </div>
        </main>
        <footer className="workspace-footer">
          <span>
            BLACK TECH <span className="muted">/ BLACK SALES AI</span>
          </span>
          <span>Fundação · 2.0</span>
        </footer>
      </div>
      {deleting && (
        <Modal
          title="Excluir oportunidade?"
          busy={busy}
          onClose={() => setDeleting(null)}
        >
          <p>
            <strong>{deleting.company}</strong> será movida para a lixeira. Os
            dados e o histórico serão preservados, e você poderá restaurá-la.
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => setDeleting(null)}
              disabled={busy}
            >
              Cancelar
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                const { company, city, sector, contact, site, status, notes } =
                  deleting;
                if (
                  await action(
                    () =>
                      updateLead(
                        deleting,
                        { company, city, sector, contact, site, status, notes },
                        true,
                      ),
                    "Oportunidade movida para a lixeira.",
                  )
                )
                  setDeleting(null);
              }}
            >
              Confirmar exclusão
            </button>
          </div>
        </Modal>
      )}
      {draft && <DraftModal lead={draft} onClose={() => setDraft(null)} />}
      {history && (
        <HistoryModal lead={history} onClose={() => setHistory(null)} />
      )}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
function Stat({
  title,
  value,
  icon,
  note,
}: {
  title: string;
  value: number;
  icon: ReactNode;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span>{title}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{value.toLocaleString("pt-BR")}</strong>
      <p>{note}</p>
    </div>
  );
}
