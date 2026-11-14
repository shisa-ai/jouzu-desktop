import { useState } from "react";
import { AlertTriangle, Brain, ChevronDown, LoaderCircle, Square } from "lucide-react";
import { ChatMarkdown } from "./chat-markdown";
import type { ActiveTurn } from "./chat-types";

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
 * One turn status line above the composer. It only carries turn state
 * (reasoning / working / interrupted / failed); tools stay in the activity strip.
 */
export function AgentAction({ thinking, label, running, elapsed, settled }: {
  thinking: string;
  label: string;
  running: boolean;
  elapsed?: string;
  settled?: "interrupted" | "failed";
}) {
  const [open, setOpen] = useState(false);
  const text = thinking.trim();
  if (!running && !text && settled) {
    const Icon = settled === "failed" ? AlertTriangle : Square;
    return <div role="status" aria-live="polite" className={`flex min-h-6 items-center gap-2 px-1 py-1 text-[11px] ${settled === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">{settled === "failed" ? "Failed" : "Interrupted"}</span>
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
