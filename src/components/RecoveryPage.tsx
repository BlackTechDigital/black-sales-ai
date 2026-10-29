import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, LockKeyhole, Mail, RefreshCw } from "lucide-react";
import {
  recoveryPasswordSchema,
  type RecoveryEntry,
} from "../../shared/recovery";
import { api, ApiError } from "../api";
import { errorText } from "../format";
import { Brand } from "./Ui";
import { RecoveryRequest } from "./RecoveryRequest";
type Ready = { ready: true; email?: string; expiresAt: number };
const invalidMessage =
  "Este link de recuperação é inválido, expirou ou já foi utilizado. Solicite um novo link.";
export function RecoveryPage({ entry }: { entry: RecoveryEntry }) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(Boolean(entry.invalid));
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState("");
  const [requesting, setRequesting] = useState(false);
  const proof = useRef(entry.proof);
  const verification = useRef<Promise<Ready> | null>(null);
  function verify() {
    if (entry.invalid)
      return Promise.reject(
        new ApiError(invalidMessage, 400, "recovery_invalid"),
      );
    if (proof.current)
      return api<Ready>("/recovery/verify", {
        method: "POST",
        body: JSON.stringify(proof.current),
      });
    return api<Ready>("/recovery/session");
  }
  function verified(data: Ready) {
    proof.current = undefined;
    entry.proof = undefined;
    setReady(data);
    setInvalid(false);
    setLoading(false);
    setError("");
  }
  function failed(err: unknown, validating = true) {
    setLoading(false);
    setError(errorText(err));
    if (
      err instanceof ApiError &&
      (err.code === "recovery_invalid" ||
        [401, 403].includes(err.status) ||
        (validating && err.status === 400))
    ) {
      proof.current = undefined;
      entry.proof = undefined;
      setInvalid(true);
      setReady(null);
    }
  }
  useEffect(() => {
    let active = true;
    // React StrictMode must never redeem a single-use email token twice.
    verification.current ??= verify();
    verification.current
      .then((data) => {
        if (active) verified(data);
      })
      .catch((err) => {
        if (active) failed(err);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(
      () => {
        setReady(null);
        setInvalid(true);
        setError(invalidMessage);
      },
      Math.max(0, ready.expiresAt * 1000 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [ready]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const fields = new FormData(form);
    const parsed = recoveryPasswordSchema.safeParse({
      password: fields.get("new-password"),
      confirmation: fields.get("confirm-password"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ updated: true; message: string }>(
        "/recovery/password",
        { method: "POST", body: JSON.stringify(parsed.data) },
      );
      form.reset();
      setReady(null);
      setSuccess(result.message);
    } catch (err) {
      failed(err, false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="entry">
      <header className="entry-header">
        <Brand />
        <span className="eyebrow">BLACK TECH · ACESSO SEGURO</span>
      </header>
      <main className="recovery-layout">
        <section className="entry-card">
          <span className="lock-mark">
            {success ? <Check size={23} /> : <LockKeyhole size={23} />}
          </span>
          <h1>
            {success
              ? "Senha atualizada"
              : requesting
                ? "Recuperar acesso"
                : "Redefinir senha"}
          </h1>
          {success ? (
            <>
              <p role="status" className="notice success">
                {success}
              </p>
              <a className="button-link full" href="/">
                Voltar ao login
              </a>
            </>
          ) : requesting ? (
            <RecoveryRequest onCancel={() => setRequesting(false)} />
          ) : (
            <>
              {loading ? (
                <p role="status" className="muted">
                  Validando seu link com segurança…
                </p>
              ) : (
                <>
                  {error && (
                    <p role="alert" className="notice error">
                      {error}
                    </p>
                  )}
                  {ready && !invalid ? (
                    <>
                      <p className="muted small">
                        Defina uma nova senha
                        {ready.email ? (
                          <>
                            {" "}
                            para <strong>{ready.email}</strong>
                          </>
                        ) : null}
                        . Depois, entre novamente no painel.
                      </p>
                      <form onSubmit={submit}>
                        <fieldset disabled={busy}>
                          <label htmlFor="new-password">Nova senha</label>
                          <input
                            id="new-password"
                            name="new-password"
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={12}
                            maxLength={128}
                          />
                          <p className="field-help">
                            Use de 12 a 128 caracteres. Prefira uma frase longa
                            e exclusiva.
                          </p>
                          <label htmlFor="confirm-password">
                            Confirmar nova senha
                          </label>
                          <input
                            id="confirm-password"
                            name="confirm-password"
                            type="password"
                            autoComplete="new-password"
                            required
                            maxLength={128}
                          />
                          <button className="full" disabled={busy}>
                            {busy ? "Salvando…" : "Salvar nova senha"}
                          </button>
                        </fieldset>
                      </form>
                    </>
                  ) : (
                    <>
                      {!invalid && (
                        <button
                          className="secondary full"
                          onClick={() => {
                            setLoading(true);
                            setError("");
                            verify().then(verified).catch(failed);
                          }}
                        >
                          <RefreshCw size={16} />
                          Tentar validar novamente
                        </button>
                      )}
                      <button
                        className="full"
                        onClick={() => setRequesting(true)}
                      >
                        <Mail size={16} />
                        Solicitar novo link
                      </button>
                    </>
                  )}
                </>
              )}
              <a className="text-button recovery-login" href="/">
                Voltar ao login
              </a>
            </>
          )}
        </section>
      </main>
      <footer className="entry-footer">
        BLACK TECH <span>Seu acesso, protegido.</span>
      </footer>
    </div>
  );
}
