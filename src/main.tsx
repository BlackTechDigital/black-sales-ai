import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { readRecoveryEntry } from "../shared/recovery";
const recoveryEntry = readRecoveryEntry(window.location, (path) =>
  window.history.replaceState(null, "", path),
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App recoveryEntry={recoveryEntry} />
  </React.StrictMode>,
);
