import { useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { LEGACY_STORAGE_KEY } from "../../shared/leads";
export function LegacyRecovery() {
  const [notice, setNotice] = useState("");
  function recover() {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) {
        setNotice(
          "Nenhum backup v1 encontrado nesta origem. Exporte o JSON no navegador onde usava a versão anterior.",
        );
        return;
      }
      // Download the exact raw bytes. Do not parse, filter, truncate, or write to localStorage.
      const url = URL.createObjectURL(
        new Blob([raw], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "black-sales-ai-v1-original.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Cópia original baixada. Os dados locais foram preservados.");
    } catch {
      setNotice(
        "O navegador não permitiu ler os dados locais. Use a exportação da versão anterior.",
      );
    }
  }
  return (
    <div className="legacy-recovery">
      <button className="text-button" onClick={recover}>
        <ArrowDownToLine size={15} /> Recuperar cópia local da v1
      </button>
      {notice && (
        <p className="small muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
