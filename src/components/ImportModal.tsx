import { useState } from "react";
import { FileJson } from "lucide-react";
import {
  LEGACY_STORAGE_KEY,
  MAX_BACKUP_BYTES,
  parseBackupText,
  type ImportSummary,
  type LegacyLead,
} from "../../shared/leads";
import { importLeads } from "../api";
import { errorText } from "../format";
import { Modal } from "./Ui";
export function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [records, setRecords] = useState<LegacyLead[] | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState("");
  async function preview(raw: string, filename: string) {
    setError("");
    setSummary(null);
    setRecords(null);
    setConfirmed(false);
    setBusy(true);
    try {
      const data = parseBackupText(raw);
      const result = await importLeads(data, false);
      setName(filename);
      setRecords(data);
      setSummary(result.summary);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Importar backup da versão 1.0" onClose={onClose} busy={busy}>
      <p className="muted">
        Adicione registros sem substituir seus dados. Duplicidades e conflitos
        serão separados para revisão.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label className="file-input" htmlFor="backup-file">
        <FileJson size={26} />
        <strong>Selecionar arquivo JSON</strong>
        <span>Até 2 MB · até 5.000 registros por arquivo</span>
      </label>
      <input
        id="backup-file"
        type="file"
        accept=".json,application/json"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.size > MAX_BACKUP_BYTES) {
            setError("O backup deve ter no máximo 2 MB.");
            setRecords(null);
            setSummary(null);
            return;
          }
          try {
            await preview(await file.text(), file.name);
          } catch (err) {
            setError(errorText(err));
          }
        }}
      />
      <button
        className="text-button"
        disabled={busy}
        onClick={() => {
          try {
            const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (!raw) {
              setError(
                "Nenhum backup v1 encontrado nesta origem. Selecione o arquivo exportado no navegador original.",
              );
              return;
            }
            void preview(raw, "Dados locais v1");
          } catch {
            setError("Não foi possível ler o armazenamento local.");
          }
        }}
      >
        Ler dados locais v1, sem removê-los
      </button>
      {busy && <p role="status">Processando com segurança…</p>}
      {summary && (
        <div className="import-summary">
          <strong>
            {summary.committed ? "Importação concluída" : `Prévia · ${name}`}
          </strong>
          <dl>
            <div>
              <dt>{summary.committed ? "Adicionados" : "Novos registros"}</dt>
              <dd>{summary.created}</dd>
            </div>
            <div>
              <dt>Duplicidades ignoradas</dt>
              <dd>{summary.duplicates}</dd>
            </div>
            <div>
              <dt>Conflitos preservados</dt>
              <dd>{summary.conflicts}</dd>
            </div>
          </dl>
          {summary.conflict_rows.length > 0 && (
            <p className="small">
              Registros em conflito: {summary.conflict_rows.join(", ")}. Os
              dados existentes não foram substituídos. Revise esses itens no
              arquivo original.
            </p>
          )}
          {!summary.committed && (
            <>
              <p className="small muted">
                A confirmação revalida a base. Registros arquivados também
                impedem duplicações. Nenhuma classificação importada é uma
                análise verificada.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={busy}
                />
                Revisei a prévia e autorizo adicionar os registros novos.
              </label>
              <button
                className="full"
                disabled={
                  !confirmed || busy || !records || summary.created === 0
                }
                onClick={async () => {
                  if (!records) return;
                  setBusy(true);
                  setError("");
                  try {
                    const result = await importLeads(records, true);
                    setSummary(result.summary);
                    await onImported();
                  } catch (e) {
                    setError(errorText(e));
                    setConfirmed(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Confirmar importação
              </button>
            </>
          )}
        </div>
      )}
      <p className="small muted">
        O arquivo original e os dados locais não são alterados.
      </p>
    </Modal>
  );
}
