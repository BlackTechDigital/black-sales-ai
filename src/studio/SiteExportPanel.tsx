import { useEffect, useRef, useState } from "react";
import { Download, ClipboardCheck, RefreshCw } from "lucide-react";
import type { PreviewVersion } from "../../shared/studio-preview";
import type { SiteExportStatus } from "../../shared/studio-export";
import {
  siteExportStatus,
  reviewSiteExport,
  downloadSiteExport,
} from "./export-api";
import { ApiError } from "../api";
import { errorText, dateText } from "../format";
import { Modal } from "../components/Ui";
import { createRequestId } from "../request-id";
import { canVerifySiteExport, secureExportMessage } from "./export-api";

export function SiteExportPanel({
  projectId,
  preview,
  frameReady,
  onSessionExpired,
}: {
  projectId: string;
  preview: PreviewVersion;
  frameReady: boolean;
  onSessionExpired(): void;
}) {
  const v = preview.version;
  const [state, setState] = useState<SiteExportStatus | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0),
    [mode, setMode] = useState<"approved" | "changes_requested" | null>(null),
    [checked, setChecked] = useState(false),
    [publicUse, setPublicUse] = useState(false);
  const alive = useRef(true),
    downloadController = useRef<AbortController | null>(null),
    lock = useRef(false),
    request = useRef({ key: "", id: createRequestId() }),
    expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  function fail(e: unknown) {
    if (!alive.current) return;
    setError(errorText(e));
    if (e instanceof ApiError && [401, 403].includes(e.status))
      expired.current();
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      downloadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    setState(null);
    void siteExportStatus(projectId, v.id, v.document_hash, controller.signal)
      .then((result) => {
        if (stopped) return;
        if (
          result.version_id !== v.id ||
          result.document_hash !== v.document_hash
        )
          throw new ApiError(
            "A versão da revisão não corresponde à prévia.",
            409,
            "review_changed",
          );
        setState(result);
      })
      .catch((e) => {
        if (!stopped) fail(e);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [projectId, v.id, v.document_hash, revision]);
  async function review() {
    if (
      lock.current ||
      !state?.artifact_hash ||
      !state.visual_hash ||
      !mode ||
      preview.visual_hash !== state.visual_hash ||
      !frameReady
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const key = `${v.id}:${v.document_hash}:${state.artifact_hash}:${mode}`;
    if (request.current.key !== key)
      request.current = { key, id: createRequestId() };
    try {
      const result = await reviewSiteExport(projectId, v.id, {
        document_hash: v.document_hash,
        artifact_hash: state.artifact_hash,
        visual_hash: state.visual_hash,
        request_id: request.current.id,
        decision: mode,
        confirm_review: true,
        confirm_public_use: mode === "approved" ? publicUse : false,
      });
      if (alive.current) {
        if (
          result.version_id !== v.id ||
          result.document_hash !== v.document_hash ||
          result.visual_hash !== preview.visual_hash
        )
          throw new ApiError(
            "A revisão mudou. Reabra a prévia antes de exportar.",
            409,
            "review_changed",
          );
        setState(result);
        setMode(null);
        setNotice(
          mode === "approved"
            ? "Revisão do site registrada para esta versão e estes arquivos."
            : "Solicitação de ajustes registrada. Exportação bloqueada.",
        );
        request.current = { key: "", id: createRequestId() };
      }
    } catch (e) {
      fail(e);
      if (alive.current) {
        setMode(null);
        setRevision((n) => n + 1);
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function download() {
    if (
      lock.current ||
      !state ||
      !frameReady ||
      !preview.visual_hash ||
      state.visual_hash !== preview.visual_hash
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      downloadController.current = new AbortController();
      await downloadSiteExport(
        projectId,
        v.id,
        v.number,
        state,
        downloadController.current.signal,
      );
      if (alive.current)
        setNotice(
          "ZIP conferido. Download solicitado ao navegador; nenhum site foi publicado.",
        );
    } catch (e) {
      fail(e);
      if (alive.current) setRevision((n) => n + 1);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const matchesPreview = Boolean(
    preview.visual_hash && state?.visual_hash === preview.visual_hash,
  );
  const canReview =
    !loading && !busy && frameReady && matchesPreview && state?.can_review;
  const canRevoke =
    !loading &&
    !busy &&
    frameReady &&
    matchesPreview &&
    state?.enabled &&
    state.review?.decision === "approved" &&
    preview.current_version_id === v.id;
  return (
    <div className="site-export" aria-labelledby="site-export-title">
      <div className="site-export-heading">
        <h3 id="site-export-title">
          <ClipboardCheck size={18} /> Revisão do site e exportação
        </h3>
        <button
          className="icon-button"
          aria-label="Atualizar revisão de exportação"
          disabled={loading || busy}
          onClick={() => {
            setError("");
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="small muted">
        A aprovação do briefing não aprova o site. Revise a prévia e autorize a
        versão {v.number} antes de baixar os arquivos.
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status" className="small muted">
          Consultando revisão da versão…
        </p>
      ) : (
        state && (
          <>
            <p className="notice">{state.message}</p>
            {state.enabled && !canVerifySiteExport() && (
              <p role="status" className="notice">
                {secureExportMessage}
              </p>
            )}
            {state.enabled && !matchesPreview && (
              <p role="alert" className="notice error">
                A prévia e os arquivos mudaram. Feche e reabra a prévia antes de
                revisar ou baixar.
              </p>
            )}
            {state.review && (
              <p className="small muted">
                Última decisão:{" "}
                {state.review.decision === "approved"
                  ? "aprovada"
                  : "ajustes solicitados"}{" "}
                · {dateText(state.review.created_at)}
              </p>
            )}
            <div className="export-actions">
              <button
                className="secondary"
                disabled={!canReview}
                onClick={() => {
                  setChecked(false);
                  setPublicUse(false);
                  setMode("approved");
                }}
              >
                Revisar site para exportação
              </button>
              {canRevoke && (
                <button
                  className="secondary"
                  onClick={() => {
                    setChecked(false);
                    setMode("changes_requested");
                  }}
                >
                  Solicitar ajustes
                </button>
              )}
              <button
                disabled={
                  loading ||
                  busy ||
                  !frameReady ||
                  !matchesPreview ||
                  !state.can_export ||
                  !canVerifySiteExport()
                }
                onClick={() => void download()}
              >
                <Download size={16} />
                {busy ? "Processando…" : "Baixar projeto ZIP"}
              </button>
            </div>
          </>
        )
      )}
      {mode && (
        <Modal
          title={
            mode === "approved"
              ? "Revisar versão do site para exportação"
              : "Solicitar ajustes no site"
          }
          busy={busy}
          onClose={() => setMode(null)}
        >
          <p>
            Site <strong>versão {v.number}</strong>. Esta decisão será vinculada
            ao documento e aos arquivos exatos do pacote; não aprova nenhuma
            outra versão.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />{" "}
            Conferi a prévia e os textos desta versão do site.
          </label>
          {mode === "approved" && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={publicUse}
                onChange={(e) => setPublicUse(e.target.checked)}
              />{" "}
              Confirmo autorização de uso público e ausência de segredos, dados
              privados e observações internas no conteúdo.
            </label>
          )}
          <p className="small muted">
            O ZIP mantém os links externos inativos, não contém imagens e não
            publica o site. Arquivos modificados exigem nova revisão.
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Voltar
            </button>
            <button
              disabled={
                busy ||
                !checked ||
                (mode === "approved" && !publicUse) ||
                (mode === "approved" && !frameReady)
              }
              onClick={() => void review()}
            >
              {busy
                ? "Registrando…"
                : mode === "approved"
                  ? "Aprovar site para exportação"
                  : "Confirmar solicitação de ajustes"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
