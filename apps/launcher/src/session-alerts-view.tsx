import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { explainError } from "./runtime-errors";
import type { QueuedMessage } from "./chat-types";
import { fill, useChatText } from "./chat-text";
import { ResultMark, type ControlResult } from "./control-result";

export type AlertLevel = "error" | "warning" | "info";
export interface AlertAction { label: string; run: () => void; title?: string; disabled?: boolean }
/** A notice in a panel or card: what happened, its actions, the original text behind Details. */
export interface SessionAlert {
  id: string;
  level: AlertLevel;
  text: string;
  details?: string;
  actions: AlertAction[];
  dismiss?: () => void;
  label?: string;
}

const tone = {
  error: "border-destructive/30 bg-destructive/5 text-foreground",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  info: "border-border bg-muted/40 text-foreground",
} as const;

/** One notice, in the one form every notice takes. */
export function NoticeRow({ alert }: { alert: SessionAlert }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  return <div role={alert.level === "info" ? "status" : "alert"} aria-label={alert.label} data-alert={alert.id} className={`rounded-lg border px-3 py-2 text-[11px] ${tone[alert.level]}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 break-words">{alert.text}</span>
      {alert.details && <Button variant="ghost" className="h-6 px-2 text-[10px]" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t.hideDetails : t.details}</Button>}
      {alert.actions.map(action => <Button key={action.label} variant="outline" className="h-6 px-2 text-[10px]" title={action.title} disabled={action.disabled} onClick={action.run}>{action.label}</Button>)}
      {alert.dismiss && <Button variant="ghost" className="size-6 p-0" aria-label={t.dismiss} onClick={alert.dismiss}><X className="size-3" /></Button>}
    </div>
    {open && alert.details && <pre className="mt-2 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[10px] text-muted-foreground">{alert.details}</pre>}
  </div>;
}

/**
 * Messages sent while a reply runs, in the order the runtime will read them. Each
 * can be taken back to edit or removed until the runtime has it: one Flow control
 * holds (it delivers that one itself) or one the runtime is answering cannot.
 * After Stop they are returned and wait for Continue (or Discard).
 */
export function SteerQueue({ items, onEdit, onRemove, onContinue, onDiscard, result }: { items: readonly QueuedMessage[]; onEdit: (clientMessageId: string) => void; onRemove: (clientMessageId: string) => void; onContinue: () => void; onDiscard: () => void; result?: ControlResult }) {
  const t = useChatText();
  if (!items.length) return null;
  const paused = items.some(item => item.state === "returned");
  return <section aria-label="Queued messages" className="mb-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px]">
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-muted-foreground">{paused ? fill(t.queueReturned, { n: items.length }) : t.queueNext}</span>
      <ResultMark result={result} />
      {paused && <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={onContinue}>{t.continue}</Button>}
      {paused && <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={onDiscard}>{t.discard}</Button>}
    </div>
    <ol className="mt-1 space-y-0.5">
      {items.map(item => <li key={item.clientMessageId} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-background/60">
        <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}{item.images > 0 && <span className="ml-1 text-muted-foreground">· {item.images === 1 ? "1 image" : `${item.images} images`}</span>}</span>
        {item.state === "held"
          // Flow control took it and releases it when its gate opens; /flow is where it can be changed.
          ? <span className="shrink-0 text-muted-foreground" title={t.codeMessageHeld}>{t.heldByFlow}</span>
          : item.state === "delivering"
          ? null
          : <>
            <Button variant="ghost" className="size-6 p-0" aria-label="Edit queued message" title="Edit" onClick={() => onEdit(item.clientMessageId)}><Pencil className="size-3" /></Button>
            <Button variant="ghost" className="size-6 p-0" aria-label="Remove queued message" title="Remove" onClick={() => onRemove(item.clientMessageId)}><X className="size-3" /></Button>
          </>}
      </li>)}
    </ol>
  </section>;
}

/**
 * A failure inside a panel or card, in the same form as a session notice: what
 * did not happen in plain words, the raw text behind Details.
 */
export function ErrorLine({ raw, failed, onDismiss, onRetry }: { raw: unknown; failed: string; onDismiss?: () => void; onRetry?: () => void }) {
  const { text, details } = explainError(raw, failed);
  return <NoticeRow alert={{ id: "error", level: "error", text, details, actions: onRetry ? [{ label: "Retry", run: onRetry }] : [], dismiss: onDismiss }} />;
}
