import { useState, type FormEvent } from "react";
import { FileJson, Plus, ShieldCheck } from "lucide-react";
import {
  discoveryRecordSchema,
  discoverySourceSchema,
  parseDiscoveryFile,
  states,
  type DiscoveryQuery,
  type DiscoveryRecord,
  type DiscoverySource,
  type DiscoverySummary,
} from "../../shared/discovery";
import { MAX_BACKUP_BYTES } from "../../shared/leads";
import { importDiscovery } from "../discovery-api";
import { errorText } from "../format";
import { downloadJson, Modal } from "./Ui";

export function DiscoveryImport({
  query,
  onClose,
  onImported,
}: {
  query: DiscoveryQuery;
  onClose(): void;
  onImported(): Promise<void>;
}) {
  const [mode, setMode] = useState<"single" | "file">("single");
  const [record, setRecord] = useState<DiscoveryRecord>({
    company: "",
    city: query.city,
    state: query.state || "MG",
    sector: query.sector,
    contact: "",
    website: "",
  });
  const [records, setRecords] = useState<DiscoveryRecord[] | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [collected, setCollected] = useState("");
  const [preview, setPreview] = useState<{
    source: DiscoverySource;
    records: DiscoveryRecord[];
    summary: DiscoverySummary;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  async function review(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const date = new Date(collected);
      const parsedSource = discoverySourceSchema.safeParse({
        name: sourceName,
        url: sourceUrl,
        collected_at: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
      });
      if (!parsedSource.success)
        throw new Error(parsedSource.error.issues[0].message);
      const parsedRecord = discoveryRecordSchema.safeParse(record);
      if (mode === "single" && !parsedRecord.success)
        throw new Error(parsedRecord.error.issues[0].message);
      const selected =
        mode === "single" && parsedRecord.success
          ? [parsedRecord.data]
          : records;
      if (!selected) throw new Error("Selecione um arquivo JSON válido.");
      const { summary } = await importDiscovery(
        parsedSource.data,
        selected,
        false,
      );
      setPreview({ source: parsedSource.data, records: selected, summary });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const { summary } = await importDiscovery(
        preview.source,
        preview.records,
        true,
      );
      // A commit is final even if a subsequent list refresh fails.
      setPreview({ ...preview, summary });
      await onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Importar resultados"
      onClose={onClose}
      busy={busy || fileBusy}
    >
      <p className="muted small">
        Use informações que você coletou de forma permitida. A importação salva
        resultados para revisão; adicionar ao pipeline é uma ação separada.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {preview ? (
        <div>
          <div className="setup-note">
            <ShieldCheck size={22} />
            <div>
              <strong>
                {preview.summary.committed
                  ? "Importação concluída"
                  : "Revise antes de importar"}
              </strong>
              <p>
                {preview.summary.total} resultado(s) · {preview.summary.created}{" "}
                {preview.summary.committed ? "salvo(s)" : "novo(s)"} ·{" "}
                {preview.summary.duplicates} duplicata(s) ignorada(s).
              </p>
            </div>
          </div>
          <p className="small muted">
            Empresa + cidade + UF são comparados sem diferença de acentos,
            espaços ou maiúsculas. Registros existentes e suas fontes são
            preservados. Os totais são conferidos novamente ao confirmar.
          </p>
          <p className="small">
            Fonte: <strong>{preview.source.name}</strong>
            <br />
            Coleta:{" "}
            {new Date(preview.source.collected_at).toLocaleString("pt-BR")}
          </p>
          <div className="modal-actions">
            {preview.summary.committed ? (
              <button onClick={onClose}>Concluir</button>
            ) : (
              <>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setError("");
                  }}
                >
                  Voltar à revisão
                </button>
                <button
                  disabled={busy || !preview.summary.created}
                  onClick={commit}
                >
                  {busy ? "Salvando…" : "Confirmar importação"}
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={review}>
          <fieldset className="discovery-fieldset" disabled={busy || fileBusy}>
            <div className="list-tabs">
              <button
                type="button"
                className={mode === "single" ? "selected" : ""}
                onClick={() => setMode("single")}
              >
                <Plus size={14} /> Uma empresa
              </button>
              <button
                type="button"
                className={mode === "file" ? "selected" : ""}
                onClick={() => setMode("file")}
              >
                <FileJson size={14} /> Arquivo JSON
              </button>
            </div>
            {mode === "single" ? (
              <>
                <label htmlFor="discovery-company">Nome da empresa</label>
                <input
                  id="discovery-company"
                  required
                  maxLength={100}
                  value={record.company}
                  onChange={(e) =>
                    setRecord({ ...record, company: e.target.value })
                  }
                />
                <div className="discovery-pair">
                  <div>
                    <label htmlFor="discovery-city">Cidade da empresa</label>
                    <input
                      id="discovery-city"
                      required
                      maxLength={70}
                      value={record.city}
                      onChange={(e) =>
                        setRecord({ ...record, city: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label htmlFor="discovery-state">UF da empresa</label>
                    <select
                      id="discovery-state"
                      value={record.state}
                      onChange={(e) =>
                        setRecord({
                          ...record,
                          state: e.target.value as DiscoveryRecord["state"],
                        })
                      }
                    >
                      {states.map((state) => (
                        <option key={state}>{state}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <label htmlFor="discovery-sector">Segmento da empresa</label>
                <input
                  id="discovery-sector"
                  required
                  maxLength={80}
                  value={record.sector}
                  onChange={(e) =>
                    setRecord({ ...record, sector: e.target.value })
                  }
                />
                <label htmlFor="discovery-contact">
                  Contato público (opcional)
                </label>
                <input
                  id="discovery-contact"
                  maxLength={160}
                  value={record.contact}
                  onChange={(e) =>
                    setRecord({ ...record, contact: e.target.value })
                  }
                />
                <label htmlFor="discovery-website">
                  Site informado (opcional)
                </label>
                <input
                  id="discovery-website"
                  type="url"
                  maxLength={1000}
                  value={record.website}
                  onChange={(e) =>
                    setRecord({ ...record, website: e.target.value })
                  }
                />
              </>
            ) : (
              <>
                <p className="small muted">
                  Array JSON com company, city, state e sector. contact e
                  website são opcionais. Até 500 registros e 2 MB. O formato v1
                  é importado no painel de oportunidades.
                </p>
                <button
                  type="button"
                  className="text-button blue"
                  onClick={() => downloadJson([], "descoberta-resultados.json")}
                >
                  Baixar estrutura vazia
                </button>
                <label htmlFor="discovery-file">
                  Arquivo de resultados JSON
                </label>
                <input
                  id="discovery-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    setRecords(null);
                    setError("");
                    if (!file) return;
                    setFileBusy(true);
                    try {
                      if (file.size > MAX_BACKUP_BYTES)
                        throw new Error("O arquivo deve ter no máximo 2 MB.");
                      setRecords(parseDiscoveryFile(await file.text()));
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setFileBusy(false);
                    }
                  }}
                />
                {records && (
                  <p className="small" role="status">
                    {records.length} resultado(s) válido(s) no arquivo.
                  </p>
                )}
              </>
            )}
            <div className="discovery-source-fields">
              <label htmlFor="discovery-source">Fonte dos dados</label>
              <input
                id="discovery-source"
                required
                maxLength={160}
                placeholder="Identifique a origem permitida da coleta"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
              />
              <label htmlFor="discovery-source-url">
                URL pública da fonte (opcional)
              </label>
              <input
                id="discovery-source-url"
                type="url"
                maxLength={1000}
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              />
              <label htmlFor="discovery-collected">Data e hora da coleta</label>
              <input
                id="discovery-collected"
                type="datetime-local"
                required
                value={collected}
                onChange={(e) => setCollected(e.target.value)}
              />
            </div>
            <button className="full" disabled={mode === "file" && !records}>
              Revisar importação
            </button>
          </fieldset>
        </form>
      )}
    </Modal>
  );
}
