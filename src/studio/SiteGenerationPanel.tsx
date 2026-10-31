import { useEffect, useRef, useState } from "react";
import {
  Globe2,
  History,
  RefreshCw,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import type { StudioDetail } from "../../shared/studio";
import {
  generationFailureMessages,
  generationStatusLabels,
  type GenerationEligibility,
  type GenerationHistory,
  type GenerationJob,
  type SiteVersionSummary,
} from "../../shared/studio-generation";
import {
  generationEligibility,
  generationHistory,
  generationJob,
  requestGeneration,
  cancelGeneration,
} from "./generation-api";
import { ApiError } from "../api";
import { dateText, errorText } from "../format";
import { Modal } from "../components/Ui";

export function SiteGenerationPanel({
  detail,
  dirty,
  opening,
  onSessionExpired,
}: {
  detail: StudioDetail;
  dirty: boolean;
  opening: boolean;
  onSessionExpired(): void;
}) {
  const { project, version } = detail;
  const [eligibility, setEligibility] = useState<GenerationEligibility | null>(
    null,
  );
  const [history, setHistory] = useState<GenerationHistory>({
    jobs: [],
    versions: [],
    has_more: false,
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [pollError, setPollError] = useState("");
  const [historyReady, setHistoryReady] = useState(false);
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false),
    [cancelling, setCancelling] = useState<GenerationJob | null>(null),
    [moreBusy, setMoreBusy] = useState(false);
  const alive = useRef(true),
    lock = useRef(false),
    request = useRef({ id: crypto.randomUUID(), accepted: false });
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const active = history.jobs.find(
    (j) => j.status === "pending" || j.status === "processing",
  );
  const historical = project.head_id !== version.id;
  function fail(e: unknown) {
    if (!alive.current) return;
    setError(errorText(e));
    if (e instanceof ApiError && [401, 403].includes(e.status))
      expired.current();
  }
  function merge(job: GenerationJob, result: SiteVersionSummary | null) {
    setHistory((prev) => ({
      ...prev,
      jobs: [job, ...prev.jobs.filter((j) => j.id !== job.id)],
      versions: result
        ? [result, ...prev.versions.filter((v) => v.id !== result.id)]
        : prev.versions,
    }));
    if (job.request_id === request.current.id) {
      request.current.accepted = true;
      setUncertain(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    setHistoryReady(false);
    setPollError("");
    void Promise.allSettled([
      generationEligibility(
        project.id,
        version.id,
        version.content_hash,
        controller.signal,
      ),
      generationHistory(project.id, 0, controller.signal),
    ]).then(([elig, items]) => {
      if (stopped) return;
      if (elig.status === "fulfilled") setEligibility(elig.value);
      else {
        setEligibility(null);
        fail(elig.reason);
      }
      if (items.status === "fulfilled") {
        setHistoryReady(true);
        setHistory(items.value);
        if (items.value.jobs.some((j) => j.request_id === request.current.id)) {
          request.current.accepted = true;
          setUncertain(false);
        }
      } else fail(items.reason);
      setLoading(false);
    });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [project.id, version.id, version.content_hash, revision]);
  useEffect(() => {
    if (!active) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController(),
      id = active.id;
    async function poll() {
      if (document.hidden) {
        timer = setTimeout(poll, 5000);
        return;
      }
      try {
        const result = await generationJob(project.id, id, controller.signal);
        if (stopped) return;
        setPollError("");
        merge(result.job, result.version);
        if (result.job.status === "completed" || result.job.status === "failed")
          return;
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && [401, 403].includes(e.status)) {
          expired.current();
          return;
        }
        setPollError(
          "Não foi possível atualizar o trabalho. O processamento pode continuar; consulte novamente antes de solicitar outro.",
        );
      }
      timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [project.id, active?.id, active?.status, revision]);
  async function submit() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestGeneration(project.id, {
        request_id: request.current.id,
        brief_version_id: version.id,
        brief_hash: version.content_hash,
      });
      if (alive.current) {
        merge(result.job, result.version);
        setConfirm(false);
      }
    } catch (e) {
      if (alive.current) {
        setUncertain(!(e instanceof ApiError) || e.status >= 500);
        setConfirm(false);
        fail(e);
        setRevision((n) => n + 1);
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!cancelling || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await cancelGeneration(project.id, cancelling.id);
      if (alive.current) {
        merge(result.job, result.version);
        setCancelling(null);
      }
    } catch (e) {
      fail(e);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function more() {
    if (moreBusy) return;
    setMoreBusy(true);
    try {
      const result = await generationHistory(project.id, history.jobs.length);
      if (alive.current)
        setHistory((prev) => ({
          jobs: [
            ...prev.jobs,
            ...result.jobs.filter((j) => !prev.jobs.some((p) => p.id === j.id)),
          ],
          versions: [
            ...prev.versions,
            ...result.versions.filter(
              (v) => !prev.versions.some((p) => p.id === v.id),
            ),
          ],
          has_more: result.has_more,
        }));
    } catch (e) {
      fail(e);
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  }
  const canGenerate =
    !opening &&
    !dirty &&
    !historical &&
    !loading &&
    historyReady &&
    !busy &&
    !active &&
    Boolean(eligibility?.eligible && eligibility.availability.available);
  return (
    <section
      className="panel site-generation"
      aria-labelledby="site-generation-title"
      aria-busy={loading}
    >
      <div className="site-generation-heading">
        <div>
          <span className="eyebrow blue">DO BRIEFING AO SITE</span>
          <h2 id="site-generation-title">
            <Globe2 size={22} /> Geração de site
          </h2>
          <p>
            Crie um documento de site a partir da versão aprovada. Cada
            resultado mantém seu histórico.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Atualizar geração"
          disabled={loading || busy}
          onClick={() => {
            setError("");
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {pollError && (
        <p role="alert" className="notice error">
          {pollError}
        </p>
      )}
      {loading ? (
        <p role="status" className="small muted">
          Consultando elegibilidade e histórico…
        </p>
      ) : (
        <>
          {eligibility && !eligibility.availability.available && (
            <p className="notice" role="status">
              {eligibility.availability.message}
            </p>
          )}
          {dirty ? (
            <p className="notice">
              Há alterações não salvas. Salve e aprove a versão desejada antes
              de gerar.
            </p>
          ) : historical ? (
            <p className="notice">
              Você está consultando um briefing histórico. Selecione a versão
              atual para gerar.
            </p>
          ) : (
            eligibility &&
            !eligibility.eligible && (
              <p className="notice">{eligibility.message}</p>
            )
          )}
          {active && (
            <div className="generation-active" role="status">
              <span className={`generation-status ${active.status}`}>
                {generationStatusLabels[active.status]}
              </span>
              <p>
                {active.stalled
                  ? "O trabalho está demorando além do esperado. Atualize o estado ou encerre-o explicitamente; nenhuma nova chamada será feita automaticamente."
                  : "Você pode continuar trabalhando. Este painel acompanha o estado salvo no servidor."}
              </p>
              <button
                className="secondary"
                disabled={busy || opening}
                onClick={() => setCancelling(active)}
              >
                Encerrar trabalho
              </button>
            </div>
          )}
          {uncertain && !active && (
            <p className="notice">
              A resposta da solicitação não foi confirmada. Atualize o histórico
              ou repita com a mesma chave para evitar um novo trabalho.
            </p>
          )}
          <div className="generation-actions">
            <button
              disabled={!canGenerate}
              onClick={() => {
                if (uncertain) {
                  void submit();
                  return;
                }
                if (request.current.accepted)
                  request.current = {
                    id: crypto.randomUUID(),
                    accepted: false,
                  };
                setConfirmed(false);
                setConfirm(true);
              }}
            >
              <Sparkles size={17} />
              {busy
                ? "Solicitando…"
                : uncertain
                  ? "Repetir mesma solicitação"
                  : history.versions.length
                    ? "Gerar nova versão"
                    : "Gerar site"}
            </button>
            <span className="small muted">
              <ShieldCheck size={15} /> Revisão humana antes de qualquer
              publicação.
            </span>
          </div>
        </>
      )}
      <div className="generation-history">
        <h3>
          <History size={17} /> Histórico de geração
        </h3>
        {!loading && !history.jobs.length ? (
          <p className="small muted">Nenhum trabalho de geração registrado.</p>
        ) : (
          <ol>
            {history.jobs.map((job) => {
              const result = history.versions.find((v) => v.job_id === job.id);
              return (
                <li key={job.id}>
                  <div>
                    <span className={`generation-status ${job.status}`}>
                      {generationStatusLabels[job.status]}
                    </span>
                    <strong>
                      {result
                        ? `Site · versão ${result.number}`
                        : "Solicitação de site"}
                    </strong>
                  </div>
                  <p className="small muted">
                    {dateText(job.created_at)} ·{" "}
                    {job.brief_version_id === version.id
                      ? `Briefing v${version.number}`
                      : "Briefing de outra versão"}
                  </p>
                  {job.error_code && (
                    <p className="generation-error">
                      {generationFailureMessages[job.error_code]}
                    </p>
                  )}
                  {result && (
                    <p className="small">
                      Documento salvo. Aguarda revisão humana; nenhum site foi
                      publicado.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {history.has_more && (
          <button
            className="secondary"
            disabled={moreBusy || busy || Boolean(active)}
            onClick={() => void more()}
          >
            {moreBusy ? "Carregando…" : "Carregar trabalhos anteriores"}
          </button>
        )}
      </div>
      {confirm && (
        <Modal
          title="Confirmar geração de site"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>
            Usar a versão <strong>{version.number}</strong> do briefing salvo e
            aprovado. Somente os campos autorizados para uso público serão
            enviados ao provedor configurado.
          </p>
          <p className="small muted">
            A geração consome a cota definida no servidor. O resultado não será
            publicado automaticamente.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            Confirmo esta solicitação e revisarei o resultado antes de qualquer
            publicação.
          </label>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Voltar
            </button>
            <button
              disabled={busy || !confirmed || !canGenerate}
              onClick={() => void submit()}
            >
              {busy ? "Solicitando…" : "Confirmar e gerar"}
            </button>
          </div>
        </Modal>
      )}
      {cancelling && (
        <Modal
          title="Encerrar trabalho de geração"
          busy={busy}
          onClose={() => setCancelling(null)}
        >
          <p>
            O trabalho será encerrado sem nova tentativa automática. Uma chamada
            já enviada ao provedor pode continuar e consumir cota. Versões
            anteriores serão preservadas.
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setCancelling(null)}
            >
              Voltar
            </button>
            <button disabled={busy} onClick={() => void cancel()}>
              Confirmar encerramento
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
