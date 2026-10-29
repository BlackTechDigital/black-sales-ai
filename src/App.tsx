import { useEffect, useState } from "react";
import {
  Database,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Users,
  Check,
} from "lucide-react";
import { api, ApiError } from "./api";
import { errorText } from "./format";
import type { User } from "./types";
import Dashboard from "./Dashboard";
import { Brand } from "./components/Ui";
import { Login } from "./components/Login";
import { LegacyRecovery } from "./components/LegacyRecovery";
import type { RecoveryEntry } from "../shared/recovery";
import { RecoveryPage } from "./components/RecoveryPage";
export default function App({
  recoveryEntry = null,
}: {
  recoveryEntry?: RecoveryEntry | null;
}) {
  if (recoveryEntry) return <RecoveryPage entry={recoveryEntry} />;
  return <WorkspaceEntry />;
}
function WorkspaceEntry() {
  const [session, setSession] = useState<{
    configured: boolean;
    user: User | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setSession(await api("/session"));
    } catch (e) {
      if (e instanceof ApiError && [401, 403].includes(e.status))
        setSession({ configured: true, user: null });
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  if (session?.user)
    return (
      <Dashboard
        key={session.user.id}
        user={session.user}
        onLogout={() => setSession({ configured: true, user: null })}
      />
    );
  return (
    <div className="entry">
      <header className="entry-header">
        <Brand />
        <span className="eyebrow">BLACK TECH · WORKSPACE COMERCIAL</span>
      </header>
      <main className="entry-layout">
        <section className="entry-copy">
          <span className="eyebrow blue">INTELIGÊNCIA PARA CRIAR CONEXÕES</span>
          <h1>
            Boas oportunidades.
            <br />
            <span>Próximos passos claros.</span>
          </h1>
          <p>
            Organize sua prospecção, prepare abordagens e acompanhe cada
            oportunidade em um só lugar.
          </p>
          <div className="entry-features">
            <span>
              <ShieldCheck size={18} /> Acesso protegido
            </span>
            <span>
              <Database size={18} /> Dados centralizados
            </span>
            <span>
              <Users size={18} /> Controle humano
            </span>
          </div>
        </section>
        <section className="entry-card">
          <span className="lock-mark">
            <LockKeyhole size={23} />
          </span>
          <h2>
            {session?.configured
              ? "Entre no seu workspace"
              : "Seu workspace começa aqui"}
          </h2>
          <p className="muted">
            {session?.configured
              ? "Use o acesso liberado pelo administrador da Black Tech."
              : "A conexão segura com o Supabase precisa ser configurada no servidor."}
          </p>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {!session ? (
            <button onClick={refresh} disabled={loading}>
              {loading ? "Verificando conexão…" : "Verificar conexão"}
            </button>
          ) : session.configured ? (
            <Login onLogin={(user) => setSession({ configured: true, user })} />
          ) : (
            <>
              <div className="setup-note">
                <Check size={18} />
                <div>
                  <strong>Interface pronta para conectar</strong>
                  <p>
                    Nenhuma empresa foi criada. Seus dados antigos continuam no
                    navegador de origem.
                  </p>
                </div>
              </div>
              <p className="muted small">
                Configuração documentada em <code>docs/SUPABASE.md</code>.
                Nenhuma chave é solicitada nesta tela.
              </p>
              <button
                className="secondary full"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw size={16} /> Verificar conexão
              </button>
              <LegacyRecovery />
            </>
          )}
        </section>
      </main>
      <footer className="entry-footer">
        BLACK TECH <span>Sites · Inteligência artificial · Automações</span>
      </footer>
    </div>
  );
}
