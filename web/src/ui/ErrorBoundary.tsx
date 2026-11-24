import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../i18n";
import { Panel } from "./primitives";

/**
 * Shows what broke instead of an empty page. Without it a render error unmounts the whole
 * app and a phone shows only the dark page background, with nothing to report.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; report: string }> {
  state = { error: null as Error | null, report: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const head = `${error.name}: ${error.message}`;
    // Chrome's stack already starts with the message; Firefox and Safari's don't.
    const stack = (error.stack ?? "").split("\n").slice(0, 8).join("\n");
    const where = (info.componentStack ?? "").trim().split("\n").slice(0, 6).join("\n");
    const parts = stack.startsWith(head) ? [stack] : [head, stack];
    this.setState({ report: [...parts, where, navigator.userAgent].filter(Boolean).join("\n\n") });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = i18n.t.bind(i18n);
    const report = this.state.report || String(this.state.error);
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg p-4 text-fg">
        <Panel className="w-[min(520px,100%)] p-4">
          <h1 className="text-[15px] font-semibold">{t("errorBoundary.title")}</h1>
          <p className="mt-1 text-[13px] text-muted">{t("errorBoundary.hint")}</p>
          <pre className="scroll-thin mt-3 max-h-[45vh] overflow-auto rounded-md border border-line bg-raised p-2.5 text-[11.5px] whitespace-pre-wrap select-text">
            {report}
          </pre>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1.5 text-[13px] hover:bg-hover"
              onClick={() => navigator.clipboard?.writeText(report).catch(() => {})}
            >
              {t("errorBoundary.copy")}
            </button>
            <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-fg" onClick={() => location.reload()}>
              {t("errorBoundary.reload")}
            </button>
          </div>
        </Panel>
      </div>
    );
  }
}
