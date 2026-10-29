import { useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { api } from "../api";
import { errorText } from "../format";
import { RecoveryRequest } from "./RecoveryRequest";
import type { User } from "../types";
export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      onLogin(result.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (recovering)
    return <RecoveryRequest onCancel={() => setRecovering(false)} />;
  return (
    <form onSubmit={submit}>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label htmlFor="email">E-mail</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="username"
        maxLength={254}
      />
      <label htmlFor="password">Senha</label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        maxLength={256}
      />
      <button className="full" disabled={busy}>
        {busy ? "Entrando…" : "Entrar no workspace"}
        <ArrowUpRight size={17} />
      </button>
      <button
        type="button"
        className="text-button recovery-login"
        onClick={() => setRecovering(true)}
        disabled={busy}
      >
        Esqueci minha senha
      </button>
      <p className="small muted">
        Precisa de acesso? Fale com o administrador.
      </p>
    </form>
  );
}
