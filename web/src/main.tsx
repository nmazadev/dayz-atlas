import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";
import { guardAgainstTranslation } from "./lib/translateGuard";
import { ErrorBoundary } from "./ui/ErrorBoundary";

guardAgainstTranslation();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
