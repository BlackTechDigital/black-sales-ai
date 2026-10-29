import { useState } from "react";
import { makeDraft, type Lead } from "../../shared/leads";
import { Modal } from "./Ui";
export function DraftModal({
  lead,
  onClose,
}: {
  lead: Lead;
  onClose: () => void;
}) {
  const [text, setText] = useState(makeDraft(lead));
  const [approved, setApproved] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <Modal title="Preparar abordagem" onClose={onClose}>
      <p className="muted">
        {lead.company} · Modelo de texto para revisão, sem geração por IA.
      </p>
      <label htmlFor="draft">Mensagem comercial</label>
      <textarea
        id="draft"
        rows={9}
        maxLength={4000}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setApproved(false);
          setNotice("");
        }}
      />
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={approved}
          onChange={(e) => setApproved(e.target.checked)}
        />
        Revisei o texto e os dados antes de copiar.
      </label>
      <div className="modal-actions">
        <button
          disabled={!approved || !text.trim()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setNotice("Mensagem copiada. O envio continua manual.");
            } catch {
              setNotice(
                "Cópia indisponível. Selecione o texto e copie manualmente.",
              );
            }
          }}
        >
          Copiar mensagem
        </button>
      </div>
      {notice && (
        <p role="status" className="small muted">
          {notice}
        </p>
      )}
      <p className="small muted">
        Este rascunho e a revisão não são gravados nesta etapa. Copiar não
        altera o funil nem confirma envio.
      </p>
    </Modal>
  );
}
