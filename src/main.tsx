import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { readRecoveryEntry } from "../shared/recovery";
import { UiErrorBoundary } from "./components/UiErrorBoundary";
const recoveryEntry = readRecoveryEntry(window.location, (path) =>
  window.history.replaceState(null, "", path),
);
ReactDOM.createRoot(document.getElementById("root")!, {
  // Boundaries show a safe recovery action. Do not log error objects, props or
  // component stacks that might contain private briefing information.
  onCaughtError: () => {},
}).render(
  <React.StrictMode>
    <UiErrorBoundary>
      <App recoveryEntry={recoveryEntry} />
    </UiErrorBoundary>
  </React.StrictMode>,
);
