import { useState } from "react";
import { AlertTriangle, Brain, ChevronDown, Info, LoaderCircle, Square, X } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown";
import type { ActiveTurn } from "./chat-types";
import { Button } from "./components/ui/button";
import { DetailsPopover } from "./control-result";
import { useChatText } from "./chat-text";

type RecoveryAction = { label: string; run: () => void; disabled?: boolean };

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * The status line's words for a running turn, as the host reports it: which step,
 * what it is doing, and for how long when the wait is the point.
 */
export function turnLabel(turn: ActiveTurn | null | undefined, now: number): string {
  if (!turn) return "Working…";
  if (turn.phase === "starting") return "Starting session…";
  if (turn.phase === "cancelling") return "Stopping…";
  const step = turn.step;
  if (!step) return "Working…";
  // The status line already shows the turn's own clock; a second one is only worth showing
  // once this state started later than the turn did.
  const ownClock = step.since !== undefined && (turn.startedAt === undefined || step.since - turn.startedAt >= 1000);
  const waited = ownClock ? ` · ${clock(Math.max(0, now - step.since!))}` : "";
  switch (step.state) {
    case "waiting_model": return `Waiting for model${waited}`;
    case "thinking": return "Thinking";
    case "writing": return "Writing";
    case "calling_tool": return "Preparing tool call";
    case "tools": {
      const names = [...new Set(step.tools.map(tool => tool.name))];
      return names.length ? `Running ${names.join(", ")}${waited}` : "Tools done";
    }
    case "retrying": {
      const attempt = step.retry?.attempt !== undefined ? ` ${step.retry.attempt}${step.retry.maxAttempts !== undefined ? `/${step.retry.maxAttempts}` : ""}` : "";
      return `Model request failed, retrying${attempt}${step.retry?.error ? ` (${step.retry.error})` : ""}`;
    }
    case "compacting": return `Compacting context${waited}`;
    default: return "Working…";
  }
}

/**
 * One turn status line at the end of the conversation, above the composer. It
 * carries the latest turn's state (reasoning / working / interrupted / failed),
 * the message that got no reply, or else the runtime's latest notice: one line,
 * one thing at a time, never a list. Tools stay in the activity strip.
 */
export function AgentAction({ thinking, label, running, elapsed, settled, failure, noReply, notice }: {
  thinking: string;
  label: string;
  running: boolean;
  elapsed?: string;
  settled?: "interrupted" | "failed";
  /** The failed reply's own words, and the one action that recovers when one is known. */
  failure?: { details?: string; action?: RecoveryAction };
  /** The last message got no reply: its text, the runtime's reason, and Retry. */
  noReply?: { text: string; details?: string; onRetry: () => void; action?: RecoveryAction } | null;
  /** The runtime's latest word to the person (a command reply, an extension failure). */
  notice?: { text: string; level: "info" | "warning" | "error"; extension?: boolean; onDismiss: () => void } | null;
}) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const text = thinking.trim();
  if (!running && !text && noReply) {
    return <div role="alert" data-no-reply className="flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] text-destructive">
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium">{t.noReply}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={noReply.text}>{noReply.text}</span>
      {noReply.details && <DetailsPopover details={noReply.details} />}
      {noReply.action
        ? <Button type="button" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" disabled={noReply.action.disabled} onClick={noReply.action.run}>{noReply.action.label}</Button>
        : <Button type="button" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" onClick={noReply.onRetry}>{t.retry}</Button>}
    </div>;
  }
  if (!running && !text && settled) {
    const Icon = settled === "failed" ? AlertTriangle : Square;
    return <div role="status" aria-live="polite" className={`flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] ${settled === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 font-medium">{settled === "failed" ? t.failed : t.interrupted}</span>
      {settled === "failed" && failure?.details && <DetailsPopover details={failure.details} />}
      {settled === "failed" && failure?.action && <Button type="button" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" disabled={failure.action.disabled} onClick={failure.action.run}>{failure.action.label}</Button>}
    </div>;
  }
  if (!running && !text && notice) {
    const tone = notice.level === "error" ? "text-destructive" : notice.level === "warning" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground";
    const Icon = notice.level === "info" ? Info : AlertTriangle;
    return <div role={notice.level === "info" ? "status" : "alert"} data-runtime-notice className={`flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] ${tone}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {notice.extension && <span className="shrink-0 font-medium">{t.extension}</span>}
      <span className="min-w-0 flex-1 truncate" title={notice.text}>{notice.text}</span>
      {notice.text.length > 80 && <DetailsPopover details={notice.text} />}
      <Button type="button" variant="ghost" className="size-6 shrink-0 p-0" aria-label={t.dismiss} onClick={notice.onDismiss}><X className="size-3" /></Button>
    </div>;
  }
  if (!running && !text) return null;
  if (!text) return <div role="status" aria-live="polite" className="flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] text-muted-foreground">
    <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    <span>{label}</span>
    {elapsed && <span className="tabular-nums">{elapsed}</span>}
  </div>;
  const last = text.split(/\r?\n/u).filter(line => line.trim()).at(-1) ?? "";
  return <div className="px-1 pb-1">
    <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/40" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Brain className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium text-foreground">Reasoning</span>
      <span className="min-w-0 flex-1 truncate">{last}</span>
      <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div className="max-h-40 overflow-auto rounded-md border border-border bg-background px-3 py-2 text-xs"><ChatMarkdown text={text} /></div>}
  </div>;
}
