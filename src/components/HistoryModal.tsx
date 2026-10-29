import { useState, useEffect } from "react";
import { Clock3 } from "lucide-react";
import type { Lead, LeadEvent, LeadInput } from "../../shared/leads";
import { getHistory } from "../api";
import { errorText, dateText, labels } from "../format";
import { Modal } from "./Ui";
export function HistoryModal({
  lead,
  onClose,
}: {
  lead: Lead;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<LeadEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getHistory(lead.id)
      .then((data) => {
        if (active) setEvents(data);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [lead.id]);
  const titles = {
    created: "Cadastro realizado",
    imported: "Importação da versão 1.0",
    updated: "Dados atualizados",
    archived: "Movida para a lixeira",
    restored: "Oportunidade restaurada",
  };
  return (
    <Modal title={`Histórico · ${lead.company}`} onClose={onClose}>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!events && !error && <p>Carregando histórico…</p>}
      <ol className="timeline">
        {events?.map((event) => (
          <li key={event.id}>
            <Clock3 size={16} />
            <div>
              <strong>{titles[event.action]}</strong>
              <time dateTime={event.occurred_at}>
                {dateText(event.occurred_at)}
              </time>
              {event.action === "imported" && (
                <p className="small muted">
                  Data de entrada no sistema. A data do cadastro original e a
                  análise digital não foram verificadas.
                </p>
              )}
              <details>
                <summary>Ver dados e alterações</summary>
                {(Object.keys(labels) as (keyof LeadInput)[])
                  .filter(
                    (key) =>
                      !event.before_data ||
                      event.before_data[key] !== event.after_data[key],
                  )
                  .map((key) => (
                    <p className="history-value" key={key}>
                      <b>{labels[key]}:</b>{" "}
                      {event.before_data && (
                        <>
                          <s>
                            {String(event.before_data[key] ?? "Não informado")}
                          </s>{" "}
                          →{" "}
                        </>
                      )}
                      {String(event.after_data[key] ?? "Não informado")}
                    </p>
                  ))}
              </details>
            </div>
          </li>
        ))}
      </ol>
      {events?.length === 0 && <p>Nenhum evento disponível.</p>}
    </Modal>
  );
}
