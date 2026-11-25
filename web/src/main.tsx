import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";
import { hideBoot } from "./lib/boot";
import { guardAgainstTranslation } from "./lib/translateGuard";
import { ErrorBoundary } from "./ui/ErrorBoundary";

guardAgainstTranslation();
// Never leave the boot screen up if something stalls before the map is ready.
window.setTimeout(hideBoot, 10_000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
