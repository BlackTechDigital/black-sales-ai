import { useEffect, useRef, useState } from "react";
import {
  Eye,
  Monitor,
  Tablet,
  Smartphone,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  PREVIEW_VIEWPORTS,
  type PreviewVersions,
  type PreviewVersion,
} from "../../shared/studio-preview";
import {
  previewVersions,
  previewVersion,
  previewFramePath,
} from "./preview-api";
import { ApiError } from "../api";
import { errorText, dateText } from "../format";
import { SiteExportPanel } from "./SiteExportPanel";

export function SitePreviewPanel({
  projectId,
  briefHeadId,
  opening,
  onSessionExpired,
}: {
  projectId: string;
  briefHeadId: string;
  opening: boolean;
  onSessionExpired(): void;
}) {
  const [expanded, setExpanded] = useState(false),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false),
    [moreBusy, setMoreBusy] = useState(false);
  const [list, setList] = useState<PreviewVersions>({
    versions: [],
    current_version_id: null,
    current_brief_version_id: null,
    has_more: false,
  });
  const [selected, setSelected] = useState(""),
    [validated, setValidated] = useState<PreviewVersion | null>(null),
    [checking, setChecking] = useState(false),
    [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState(""),
    [documentError, setDocumentError] = useState("");
  const [mode, setMode] = useState<keyof typeof PREVIEW_VIEWPORTS>("desktop"),
    [availableWidth, setAvailableWidth] = useState(0);
  const canvas = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    selectedRef = useRef(""),
    expired = useRef(onSessionExpired),
    offset = useRef(0),
    listEpoch = useRef(0);
  expired.current = onSessionExpired;
  selectedRef.current = selected;
  const selectedMeta = list.versions.find((v) => v.id === selected),
    viewport = PREVIEW_VIEWPORTS[mode];
  const scale = Math.min(
    1,
    (availableWidth || viewport.width) / viewport.width,
  );
  function report(e: unknown, document = false) {
    if (!alive.current) return;
    (document ? setDocumentError : setError)(errorText(e));
    if (e instanceof ApiError && [401, 403].includes(e.status))
      expired.current();
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    listEpoch.current++;
    if (!expanded || opening) return;
    let stopped = false;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void previewVersions(projectId, 0, controller.signal)
      .then((result) => {
        if (stopped) return;
        offset.current = result.versions.length;
        setList(result);
        setSelected((previous) =>
          result.versions.some((v) => v.id === previous)
            ? previous
            : (result.current_version_id ?? result.versions[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!stopped) {
          setList({
            versions: [],
            current_version_id: null,
            current_brief_version_id: null,
            has_more: false,
          });
          setSelected("");
          report(e);
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [projectId, briefHeadId, expanded, opening, revision]);
  useEffect(() => {
    setValidated(null);
    setFrameReady(false);
    setDocumentError("");
    if (!expanded || opening || loading || !selectedMeta) {
      setChecking(false);
      return;
    }
    let stopped = false;
    const controller = new AbortController(),
      id = selectedMeta.id,
      hash = selectedMeta.document_hash;
    setChecking(true);
    void previewVersion(projectId, id, hash, controller.signal)
      .then((result) => {
        if (stopped) return;
        if (
          result.version.id !== id ||
          result.version.document_hash !== hash ||
          result.version.number !== selectedMeta.number
        )
          throw new ApiError(
            "A versão recebida não corresponde à seleção. Atualize a lista.",
            409,
            "preview_changed",
          );
        setValidated(result);
        setList((previous) => ({
          ...previous,
          current_version_id: result.current_version_id,
          current_brief_version_id: result.current_brief_version_id,
        }));
      })
      .catch((e) => {
        if (!stopped) report(e, true);
      })
      .finally(() => {
        if (!stopped) setChecking(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [
    projectId,
    selectedMeta?.id,
    selectedMeta?.document_hash,
    loading,
    expanded,
    opening,
    revision,
    briefHeadId,
  ]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () =>
      setAvailableWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [validated?.version.id, expanded, mode]);
  async function more() {
    if (moreBusy) return;
    setMoreBusy(true);
    setError("");
    const expectedEpoch = listEpoch.current;
    try {
      const result = await previewVersions(projectId, offset.current);
      if (!alive.current || expectedEpoch !== listEpoch.current) return;
      offset.current += result.versions.length;
      setList((prev) => ({
        ...result,
        versions: [
          ...prev.versions,
          ...result.versions.filter(
            (v) => !prev.versions.some((p) => p.id === v.id),
          ),
        ],
      }));
    } catch (e) {
      report(e);
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  }
  const current = validated?.version.id === validated?.current_version_id;
  const oldBrief =
    validated &&
    validated.version.brief_version_id !== validated.current_brief_version_id;
  const frame =
    validated &&
    validated.version.id === selected &&
    validated.version.document_hash === selectedMeta?.document_hash &&
    !checking &&
    !loading &&
    !opening
      ? validated
      : null;
  return (
    <section
      className="panel site-preview"
      aria-labelledby="site-preview-title"
    >
      <div className="site-preview-heading">
        <div>
          <span className="eyebrow blue">VERSÕES SALVAS</span>
          <h2 id="site-preview-title">
            <Eye size={22} /> Prévia do site
          </h2>
          <p>
            Visualize o documento salvo em um ambiente isolado. A prévia não
            publica o site.
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Fechar prévia" : "Abrir prévia"}
        </button>
      </div>
      {expanded && (
        <>
          <div className="preview-toolbar">
            <label>
              Versão do site
              <select
                aria-label="Versão do site"
                value={selected}
                disabled={loading || !list.versions.length || opening}
                onChange={(e) => setSelected(e.target.value)}
              >
                {!list.versions.length && (
                  <option value="">Nenhuma versão</option>
                )}
                {list.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    Versão {v.number}
                    {v.id === list.current_version_id
                      ? " · Atual"
                      : " · Antiga"}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              aria-label="Atualizar versões da prévia"
              disabled={loading || opening}
              onClick={() => setRevision((n) => n + 1)}
            >
              <RefreshCw size={17} />
            </button>
          </div>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {loading && (
            <p role="status" className="notice">
              Carregando versões salvas…
            </p>
          )}
          {!loading && !error && !list.versions.length && (
            <p className="notice" role="status">
              Ainda não há versões de site salvas neste projeto. Conclua uma
              geração para visualizar a prévia.
            </p>
          )}
          {list.has_more && (
            <button
              className="secondary"
              disabled={moreBusy || loading || opening}
              onClick={() => void more()}
            >
              {moreBusy ? "Carregando…" : "Carregar versões anteriores"}
            </button>
          )}
          {checking && (
            <p role="status" className="notice">
              Validando o documento da versão selecionada…
            </p>
          )}
          {documentError && (
            <p role="alert" className="notice error">
              {documentError} Nenhuma prévia dessa seleção foi carregada.
            </p>
          )}
          {frame && (
            <>
              <div className="preview-provenance">
                <strong>Site · versão {frame.version.number}</strong>
                <span
                  className={`generation-status ${current ? "completed" : "pending"}`}
                >
                  {current ? "Versão atual" : "Versão antiga"}
                </span>
                <span className="small muted">
                  Salva em {dateText(frame.version.created_at)}
                </span>
              </div>
              {!current && (
                <p className="notice">
                  Você está visualizando uma versão antiga. A versão atual do
                  site foi preservada.
                </p>
              )}
              {oldBrief && (
                <p className="notice">
                  Esta versão foi gerada a partir de um briefing anterior. A
                  prévia não aprova seu uso público.
                </p>
              )}
              <div
                className="preview-devices"
                role="group"
                aria-label="Tamanho da prévia"
              >
                {(
                  Object.entries(PREVIEW_VIEWPORTS) as [
                    keyof typeof PREVIEW_VIEWPORTS,
                    (typeof PREVIEW_VIEWPORTS)[keyof typeof PREVIEW_VIEWPORTS],
                  ][]
                ).map(([key, value]) => {
                  const Icon =
                    key === "desktop"
                      ? Monitor
                      : key === "tablet"
                        ? Tablet
                        : Smartphone;
                  return (
                    <button
                      key={key}
                      className="secondary"
                      aria-pressed={mode === key}
                      onClick={() => setMode(key)}
                    >
                      <Icon size={16} />
                      {value.label}
                    </button>
                  );
                })}
                <span className="small muted">
                  {viewport.width} × {viewport.height}
                </span>
              </div>
              <p className="small muted preview-safety">
                <ShieldCheck size={15} /> Sem scripts, imagens ou links externos
                ativos. Use a navegação dentro da prévia para trocar de página.
              </p>
              {!frameReady && (
                <p role="status" className="small muted">
                  Carregando prévia isolada…
                </p>
              )}
              <div className="preview-window">
                <div
                  className="preview-canvas"
                  ref={canvas}
                  style={{ height: Math.ceil(viewport.height * scale) }}
                >
                  <iframe
                    key={`${frame.version.id}:${frame.version.document_hash}:${frame.visual_hash ?? ""}`}
                    title={`Prévia do site — versão ${frame.version.number}`}
                    src={previewFramePath(
                      projectId,
                      frame.version.id,
                      frame.version.document_hash,
                      frame.visual_hash,
                    )}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
                    width={viewport.width}
                    height={viewport.height}
                    style={{
                      width: viewport.width,
                      height: viewport.height,
                      transform: `scale(${scale})`,
                    }}
                    onLoad={() => {
                      if (selectedRef.current === frame.version.id)
                        setFrameReady(true);
                    }}
                    onError={() => {
                      if (selectedRef.current === frame.version.id) {
                        setValidated(null);
                        setDocumentError(
                          "Não foi possível abrir a prévia isolada. Atualize para tentar novamente.",
                        );
                      }
                    }}
                  />
                </div>
              </div>
              <SiteExportPanel
                key={`${projectId}:${frame.version.id}:${frame.version.document_hash}:${frame.visual_hash ?? ""}`}
                projectId={projectId}
                preview={frame}
                frameReady={frameReady}
                onSessionExpired={onSessionExpired}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
