import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { copyText as copyToClipboard } from "../secure-context";
import { useChatText, type ChatText } from "../chat-text";

/** Chips render the same body without a second header/border. */
export const ToolDetailContext = createContext(false);

export type ToolState = "running" | "done" | "error" | "warning" | "idle";

const DOT: Record<ToolState, string> = {
  running: "bg-primary animate-pulse",
  done: "bg-emerald-500",
  error: "bg-destructive",
  warning: "bg-amber-500",
  idle: "bg-muted-foreground/50",
};

const status = (t: ChatText): Record<ToolState, string> => ({
  running: t.running,
  done: t.completed,
  error: t.failed,
  warning: t.warning,
  idle: t.pending,
});

export function StateDot({ state }: { state: ToolState }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />;
}

/** Running and failed tools are useful immediately; finished text is not. */
export function defaultOpenFor(state: ToolState): boolean {
  return state === "running" || state === "error" || state === "warning";
}

/**
 * The one disclosure used by every tool card. The whole header is the button and
 * the body is never nested inside a second `<details>`.
 */
export function ToolFrame({ title, subtitle, state, defaultOpen, actions, children, icon, className = "", autoOpen = true, statusLabel }: {
  title: ReactNode;
  subtitle?: ReactNode;
  state: ToolState;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Tools open while running; a thinking disclosure does not. */
  autoOpen?: boolean;
  statusLabel?: string;
}) {
  const t = useChatText();
  const [manual, setManual] = useState<boolean | null>(null);
  const embedded = useContext(ToolDetailContext);
  const expandable = children !== undefined;
  const initial = (autoOpen ? defaultOpenFor(state) : state === "error" || state === "warning") || defaultOpen === true;
  const open = expandable && (manual ?? initial);
  const bodyId = useId();
  if (embedded) return <div className="space-y-2 text-xs">{children}</div>;
  return <section className={`my-1.5 overflow-hidden rounded-lg border border-border bg-muted/20 ${className}`}>
    <div className="flex items-center gap-2 px-2.5 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs disabled:cursor-default"
        onClick={() => { if (expandable) setManual(!open); }}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? bodyId : undefined}
        disabled={!expandable}
      >
        {icon ?? <StateDot state={state} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          {subtitle !== undefined && subtitle !== "" && <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{subtitle}</span>}
        </span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
          state === "running" ? "border-primary/40 text-primary"
            : state === "error" ? "border-destructive/40 text-destructive"
              : state === "warning" ? "border-amber-500/40 text-amber-600"
                : "border-border text-muted-foreground"
        }`}>{statusLabel ?? status(t)[state]}</span>
        {expandable && <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />}
      </button>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
    {open && <div id={bodyId} role="region" className="space-y-2 border-t border-border px-3 py-2 text-xs">{children}</div>}
  </section>;
}

/** One body section. The optional copy button is the only copy affordance. */
export function ToolSection({ label, copyText, children, maxHeight = "max-h-96" }: {
  label: string;
  copyText?: string;
  children: ReactNode;
  maxHeight?: string;
}) {
  const t = useChatText();
  const [copied, setCopied] = useState(false);
  return <div className="space-y-1">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      {copyText !== undefined && <button
        type="button"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={async () => {
          try {
            await copyToClipboard(copyText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          } catch {
            setCopied(false);
          }
        }}
      >{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? t.copied : t.copy}</button>}
    </div>
    <div className={`overflow-auto ${maxHeight}`}>{children}</div>
  </div>;
}
