import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Compass,
  FileUp,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  discoveryQuerySchema,
  initialDiscoveryQuery,
  states,
  type DiscoveryQuery,
  type DiscoveryResult,
  type DiscoverySources,
} from "../shared/discovery";
import { api, ApiError } from "./api";
import { getDiscoveryResults, promoteDiscovery } from "./discovery-api";
import { dateText, errorText } from "./format";
import type { Notice } from "./types";
import { DiscoveryImport } from "./components/DiscoveryImport";
import { Modal } from "./components/Ui";

export default function DiscoveryPage({
  onPipelineChanged,
  onOpenPipeline,
  onSessionExpired,
}: {
  onPipelineChanged(): Promise<void>;
  onOpenPipeline(): void;
  onSessionExpired(): void;
}) {
  const [filters, setFilters] = useState(initialDiscoveryQuery);
  const [query, setQuery] = useState(initialDiscoveryQuery);
  const [sources, setSources] = useState<DiscoverySources | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [results, setResults] = useState<DiscoveryResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<DiscoveryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  function showError(error: unknown) {
    setNotice({ kind: "error", text: errorText(error) });
    if (error instanceof ApiError && [401, 403].includes(error.status))
      onSessionExpired();
  }
  async function load(next: DiscoveryQuery) {
    const sequence = ++request.current;
    setLoading(true);
    setQuery(next);
    setFailed(false);
    try {
      const data = await getDiscoveryResults(next);
      if (mounted.current && sequence === request.current) {
        setResults(data.results);
        setHasMore(data.results.length === 100);
        setQuery(next);
      }
    } catch (e) {
      if (mounted.current && sequence === request.current) {
        setResults([]);
        setHasMore(false);
        setFailed(true);
        showError(e);
      }
    } finally {
      if (mounted.current && sequence === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    api<DiscoverySources>("/discovery/sources")
      .then((data) => {
        if (mounted.current) setSources(data);
      })
      .catch((e) => {
        if (mounted.current) {
          setSourcesFailed(true);
          showError(e);
        }
      });
    void load(initialDiscoveryQuery);
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  function filter(event: FormEvent) {
    event.preventDefault();
    const parsed = discoveryQuerySchema.safeParse({ ...filters, offset: 0 });
    if (!parsed.success) {
      setNotice({
        kind: "error",
        text: "Confira a cidade, a UF e o segmento.",
      });
      return;
    }
    setNotice(null);
    void load(parsed.data);
  }
  async function promote() {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await promoteDiscovery(selected.id);
      setSelected(null);
      setNotice({
        kind: "success",
        text:
          result.outcome === "added"
            ? "Oportunidade adicionada ao pipeline. Nenhuma abordagem foi enviada."
            : `O registro já existe${result.archived ? " na lixeira" : " no pipeline"}. Nenhum dado foi substituído.`,
      });
      await load(query);
      await onPipelineChanged();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CENTRAL DE DESCOBERTA</span>
          <h1>
            Descobrir empresas<span className="heading-dot">.</span>
          </h1>
          <p>Encontre contexto. Revise a origem. Escolha o próximo passo.</p>
        </div>
        <button onClick={() => setImporting(true)} disabled={busy}>
          <FileUp size={16} /> Importar resultados
        </button>
      </div>
      <section className="discovery-intro">
        <div className="discovery-orbit">
          <Compass size={30} />
        </div>
        <div>
          <span className="eyebrow blue">DA PESQUISA À OPORTUNIDADE</span>
          <h2>Sua prospecção começa com uma boa fonte.</h2>
          <p>
            {sources
              ? sources.providers.length
                ? "Fontes autorizadas disponíveis para integração."
                : "Nenhuma fonte externa configurada. Importe informações coletadas por você de forma permitida para começar."
              : sourcesFailed
                ? "Não foi possível verificar as fontes. A importação manual permanece disponível."
                : "Verificando as fontes disponíveis…"}
          </p>
        </div>
        <span className="discovery-reference">
          <MapPin size={16} /> Passos, MG <small>Cidade de referência</small>
        </span>
      </section>
      {notice && (
        <p
          className={`notice ${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      <form
        className="panel discovery-filters"
        onSubmit={filter}
        aria-label="Filtros de descoberta"
      >
        <div>
          <label htmlFor="filter-city">Cidade</label>
          <input
            id="filter-city"
            maxLength={70}
            value={filters.city}
            onChange={(e) => setFilters({ ...filters, city: e.target.value })}
            placeholder="Todas as cidades"
          />
        </div>
        <div>
          <label htmlFor="filter-state">Estado (UF)</label>
          <select
            id="filter-state"
            value={filters.state}
            onChange={(e) =>
              setFilters({
                ...filters,
                state: e.target.value as DiscoveryQuery["state"],
              })
            }
          >
            <option value="">Todos os estados</option>
            {states.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-sector">Segmento</label>
          <input
            id="filter-sector"
            maxLength={80}
            value={filters.sector}
            onChange={(e) => setFilters({ ...filters, sector: e.target.value })}
            placeholder="Todos os segmentos"
          />
        </div>
        <button disabled={busy || loading}>
          <Search size={16} /> Filtrar resultados
        </button>
      </form>
      <section
        className="panel discovery-results"
        aria-label="Resultados de descoberta"
        aria-busy={loading}
      >
        <div className="pipeline-heading">
          <div>
            <h2>
              Resultados para revisar{" "}
              <span className="count-badge">{results.length}</span>
            </h2>
            <p>Informações importadas, sem diagnóstico automático.</p>
          </div>
          <button
            className="icon-button"
            aria-label="Atualizar descoberta"
            disabled={busy || loading}
            onClick={() => {
              setNotice(null);
              void load(query);
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {loading ? (
          <div className="empty">
            <RefreshCw size={26} />
            <h3>Carregando resultados…</h3>
          </div>
        ) : failed ? (
          <div className="empty">
            <h3>Não foi possível carregar os resultados</h3>
            <p>Confira o aviso e tente atualizar a lista.</p>
          </div>
        ) : !results.length ? (
          <div className="empty">
            <span className="empty-icon">
              <Compass size={30} />
            </span>
            <h3>Nenhuma empresa nesta seleção</h3>
            <p>
              Importe resultados reais ou ajuste os filtros para consultar o que
              já foi salvo.
            </p>
            <button className="secondary" onClick={() => setImporting(true)}>
              Importar resultados reais
            </button>
          </div>
        ) : (
          <div className="discovery-grid">
            {results.map((result) => (
              <article className="discovery-card" key={result.id}>
                <div className="lead-top">
                  <div className="company-avatar">
                    {result.company[0]?.toUpperCase()}
                  </div>
                  <div className="lead-title">
                    <h3>{result.company}</h3>
                    <p>
                      {result.city}, {result.state} · {result.sector}
                    </p>
                  </div>
                </div>
                <span className="discovery-label">
                  Importação manual · Ainda não analisado
                </span>
                {result.contact && (
                  <p className="lead-detail">{result.contact}</p>
                )}
                {result.website && (
                  <a
                    className="discovery-url blue"
                    href={result.website}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Site informado <ArrowRight size={13} />
                  </a>
                )}
                <dl className="discovery-provenance">
                  <div>
                    <dt>Fonte</dt>
                    <dd>
                      {result.source_url ? (
                        <a
                          href={result.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {result.source_name}
                        </a>
                      ) : (
                        result.source_name
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Coletado em</dt>
                    <dd>
                      <time dateTime={result.collected_at}>
                        {dateText(result.collected_at)}
                      </time>
                    </dd>
                  </div>
                </dl>
                {result.pipeline_match && (
                  <p className="small muted">
                    {result.pipeline_match.linked
                      ? "Já adicionado"
                      : "Possível duplicata"}
                    {result.pipeline_match.archived
                      ? " na lixeira"
                      : " no pipeline"}
                    . Revise o cadastro existente.
                  </p>
                )}
                <button
                  className={result.pipeline_match ? "secondary full" : "full"}
                  disabled={busy || Boolean(result.pipeline_match)}
                  onClick={() => {
                    setNotice(null);
                    setSelected(result);
                  }}
                >
                  <ArrowRight size={15} />
                  {result.pipeline_match
                    ? "Registro já existente"
                    : "Adicionar ao pipeline"}
                </button>
              </article>
            ))}
          </div>
        )}
        <div className="discovery-pagination">
          <span className="small muted">
            {results.length ? query.offset + 1 : 0}–
            {query.offset + results.length} · até 100 por página
          </span>
          <button
            className="secondary"
            disabled={loading || busy || query.offset === 0}
            onClick={() =>
              void load({ ...query, offset: Math.max(0, query.offset - 100) })
            }
          >
            Anterior
          </button>
          <button
            className="secondary"
            disabled={loading || busy || !hasMore}
            onClick={() => void load({ ...query, offset: query.offset + 100 })}
          >
            Próxima
          </button>
          <button className="text-button blue" onClick={onOpenPipeline}>
            Ver pipeline <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <div className="bottom-note">
        <ShieldCheck size={16} />
        <span>
          A origem fica registrada. Adicionar uma oportunidade não envia
          mensagens e não cria uma análise da empresa.
        </span>
      </div>
      {importing && (
        <DiscoveryImport
          query={query}
          onClose={() => setImporting(false)}
          onImported={async () => {
            await load(query);
          }}
        />
      )}
      {selected && (
        <Modal
          title="Adicionar ao pipeline?"
          busy={busy}
          onClose={() => setSelected(null)}
        >
          {notice?.kind === "error" && (
            <p className="notice error" role="alert">
              {notice.text}
            </p>
          )}
          <p>
            <strong>{selected.company}</strong> será cadastrada como{" "}
            <strong>Novo</strong>, com presença digital{" "}
            <strong>Ainda não analisado</strong>.
          </p>
          <p className="small muted">
            Fonte: {selected.source_name} · Coleta:{" "}
            {dateText(selected.collected_at)}. Possíveis duplicatas, inclusive
            na lixeira, serão verificadas novamente ao confirmar.
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Cancelar
            </button>
            <button disabled={busy} onClick={promote}>
              {busy ? "Adicionando…" : "Confirmar adição"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
