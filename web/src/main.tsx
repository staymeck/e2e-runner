import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    {/* BASE_URL mirrors vite.config.ts's own "base" (e.g. "/orchestrator/") — a deployment behind a
        path-prefixing reverse proxy needs client-side routes to match it too, or a link like
        /mobile/escenarios resolves outside the prefix the proxy actually forwards. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
