import { useState, type FormEvent } from "react";
import { api } from "../api";
import { errorText } from "../format";
export function RecoveryRequest({ onCancel }: { onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get("recovery-email");
    setBusy(true);
    setError("");
    try {
      const result = await api<{ message: string }>("/recovery/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      form.reset();
      setMessage(result.message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {message ? (
        <p className="notice success" role="status">
          {message}
        </p>
      ) : (
        <>
          <p className="muted small">
            Informe o e-mail usado no seu acesso à Black Tech.
          </p>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <form onSubmit={submit}>
            <label htmlFor="recovery-email">E-mail de recuperação</label>
            <input
              id="recovery-email"
              name="recovery-email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              disabled={busy}
            />
            <button className="full" disabled={busy}>
              {busy ? "Solicitando…" : "Enviar link de recuperação"}
            </button>
          </form>
        </>
      )}
      <button
        className="text-button recovery-login"
        onClick={onCancel}
        disabled={busy}
      >
        Voltar
      </button>
    </>
  );
}
