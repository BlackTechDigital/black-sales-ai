import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  title?: string;
}
// Render/lifecycle failures stay within their panel. Event handlers and async
// operations retain their existing explicit try/catch and authorization checks.
export class UiErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section
          className="panel"
          role="alert"
          aria-label="Painel indisponível"
        >
          <h2>{this.props.title ?? "Não foi possível abrir este painel."}</h2>
          <p>
            O painel foi interrompido para evitar continuar com um estado
            incompleto. Consulte novamente a versão salva antes de continuar.
          </p>
          <p className="small muted">
            Alterações não salvas podem ter sido perdidas. Nenhum detalhe
            interno do erro é exibido aqui.
          </p>
          <button onClick={() => this.setState({ failed: false })}>
            Tentar abrir novamente
          </button>
        </section>
      );
    return this.props.children;
  }
}
