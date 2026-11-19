import { useEffect, useRef, useState } from "react";
import { ResultMark, type ControlResult } from "../control-result";
import { Bot, CheckCircle2, ChevronDown, Circle, CircleSlash, ListTodo, LoaderCircle, Terminal } from "lucide-react";
import { Button } from "../components/ui/button";
import { ActivityRow } from "./activity-row";
import { FlowReportSummary } from "./flow-report";
import { backgroundStatusEntries, backgroundWidgetEntries, flowStatusEntries, flowWidgetEntries, subagentStatusEntries, subagentWidgetEntries, widgetLabel, type FlowBackground, type FlowState, type FlowSubagent, type FlowTask } from "./flow-state";
import type { FlowReportRecord } from "../chat-projection";
import { fill, useChatText } from "../chat-text";

function TaskIcon({ status }: { status: FlowTask["status"] }) {
  const t = useChatText();
  if (status === "completed") return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label={t.completed} />;
  if (status === "in_progress") return <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" aria-label={t.inProgress} />;
  if (status === "deleted") return <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={t.deleted} />;
  return <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={t.pending} />;
}

function useDismiss(open: boolean, setOpen: (open: boolean) => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open, setOpen]);
  return root;
}

export function SubagentMenu({ agents, widgets = {}, statuses = {} }: { agents: readonly FlowSubagent[]; widgets?: Record<string, string[]>; statuses?: Record<string, string> }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, setOpen);
  const widgetEntries = subagentWidgetEntries(widgets);
  const statusEntries = subagentStatusEntries(statuses);
  const total = agents.length + widgetEntries.length + statusEntries.length;
  if (!total) return null;
  const active = agents.filter(agent => agent.state === "running").length;
  return <div ref={root} className="relative">
    <button type="button" onClick={() => setOpen(value => !value)} aria-label={`Subagents (${total})`} aria-haspopup="dialog" aria-expanded={open} className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/50 ${active ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Bot className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="whitespace-nowrap" aria-live="polite">{total} subagent{total === 1 ? "" : "s"}</span>
      <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div role="dialog" aria-label={t.subagents} className="absolute right-0 top-full z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold">{t.subagents}</div>
      <div className="max-h-[min(24rem,60vh)] overflow-y-auto px-3 py-2">
        {agents.map(agent => <ActivityRow key={agent.id} title={agent.title} summary={agent.state === "running" ? t.running : agent.state === "error" ? t.failed : t.completed} state={agent.state} />)}
        {widgetEntries.map(([key, lines]) => <div key={key} className="mb-2"><p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{widgetLabel(key)}</p><ul className="space-y-0.5">{lines.slice(0, 12).map((line, index) => <li key={index} className="truncate whitespace-pre text-[11px] text-muted-foreground">{line}</li>)}</ul></div>)}
        {statusEntries.map(([key, text]) => <p key={key} className="mb-1 text-[11px] text-muted-foreground">{text}</p>)}
      </div>
    </div>}
  </div>;
}

export function BackgroundMenu({ jobs, widgets = {}, statuses = {} }: { jobs: readonly FlowBackground[]; widgets?: Record<string, string[]>; statuses?: Record<string, string> }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, setOpen);
  const widgetEntries = backgroundWidgetEntries(widgets);
  const statusEntries = backgroundStatusEntries(statuses);
  const total = jobs.length + widgetEntries.length + statusEntries.length;
  if (!total) return null;
  const active = jobs.filter(job => job.state === "running").length;
  return <div ref={root} className="relative">
    <button type="button" onClick={() => setOpen(value => !value)} aria-label={fill(t.backgroundJobsCount, { n: total })} aria-haspopup="dialog" aria-expanded={open} className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/50 ${active ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Terminal className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="whitespace-nowrap" aria-live="polite">{total} background job{total === 1 ? "" : "s"}</span>
      <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div role="dialog" aria-label={t.backgroundJobs} className="absolute right-0 top-full z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold">{t.backgroundJobs}</div>
      <div className="max-h-[min(24rem,60vh)] overflow-y-auto px-3 py-2">
        {jobs.map((job, index) => <ActivityRow key={index} title={t.backgroundTask} summary={job.command} state={job.state} />)}
        {widgetEntries.map(([key, lines]) => <div key={key} className="mb-2"><p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{widgetLabel(key)}</p><ul className="space-y-0.5">{lines.slice(0, 12).map((line, index) => <li key={index} className="truncate whitespace-pre text-[11px] text-muted-foreground">{line}</li>)}</ul></div>)}
        {statusEntries.map(([key, text]) => <p key={key} className="mb-1 text-[11px] text-muted-foreground">{text}</p>)}
      </div>
    </div>}
  </div>;
}

/** Session status chip in the header. Its trigger is layout-stable; task/report
 * changes only affect the popover, never the conversation layout. */
export function FlowMenu({ flow, widgets, statuses, reports = [], notice, error, onCommand, busy = false, result }: {
  flow: FlowState;
  widgets: Record<string, string[]>;
  statuses: Record<string, string>;
  reports?: readonly FlowReportRecord[];
  notice?: string;
  error?: string;
  onCommand?: (command: string) => void;
  busy?: boolean;
  /** What the last Flow command run from here did, shown at this control. */
  result?: ControlResult;
}) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [page, setPage] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const tasks = flow.tasks.filter(task => task.status !== "deleted");
  const completed = tasks.filter(task => task.status === "completed").length;
  const active = tasks.find(task => task.status === "in_progress");
  const running = tasks.filter(task => task.status === "in_progress").length;
  const pending = tasks.filter(task => task.status === "pending").length;
  const waiting = flow.waits.filter(wait => wait.state === "running").length;
  const summary = [
    active ? active.subject : tasks.length ? fill(t.tasksDone, { done: completed, n: tasks.length }) : "",
    running ? fill(t.nRunning, { n: running }) : "",
    pending ? fill(t.nPending, { n: pending }) : "",
    waiting ? fill(t.nWaiting, { n: waiting }) : "",
  ].filter(Boolean).join(" · ") || t.sessionActivity;
  const live = tasks.some(task => task.status !== "completed") || waiting > 0;
  const hasContent = tasks.length > 0 || flow.waits.length > 0 || reports.length > 0 || !!notice || !!error || flowWidgetEntries(widgets).length > 0 || flowStatusEntries(statuses).length > 0 || !!result;
  if (!hasContent) return null;
  return <div ref={root} className="relative flex items-center">
    <button type="button" onClick={() => setOpen(value => !value)} aria-label="Flow" aria-haspopup="dialog" aria-expanded={open} className={`flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/50 ${live ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      {live ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <ListTodo className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="hidden min-w-0 flex-1 truncate sm:inline" aria-live="polite">{summary}</span>
      <span className="flex-1 sm:hidden">{tasks.length ? `${completed}/${tasks.length}` : "Flow"}</span>
      <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    <ResultMark result={result} side="bottom" />
    {open && <div role="dialog" aria-label={t.flowDetails} className="absolute right-0 top-full z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListTodo className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-semibold">{t.tasks}</span>
        {tasks.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{completed}/{tasks.length}</span>}
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{summary}</span>
      </div>
      {notice && <p role="status" className="border-b border-border bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">{notice}</p>}
      {error && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"><p className="font-medium">{t.flowNeedsRecovery}</p><p className="mt-1 break-words">{error}</p><p className="mt-1 text-muted-foreground">{t.flowResetHint}</p></div>}
      {onCommand && <div className="space-y-2 border-b border-border px-2 py-2" aria-label={t.flowCommands}>
        <div className="flex flex-wrap gap-1">
          {[["/flow", t.status], ["/flow pause", t.pause], ["/flow resume", t.resume], ["/flow clear", t.clear], ["/flow runtime", t.runtime]].map(([command, label]) => <Button key={command} variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { setOpen(false); onCommand(command); }}>{label}</Button>)}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { setOpen(false); onCommand("/flow off"); }}>{t.off}</Button>
          <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { setOpen(false); onCommand("/flow on"); }}>{t.textguardOn}</Button>
          <input aria-label={t.flowDetailsPage} inputMode="numeric" placeholder={t.page} value={page} onChange={event => setPage(event.target.value.replace(/[^\d]/gu, ""))} className="h-6 w-14 rounded border border-border bg-background px-1 text-[10px]" />
          <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { setOpen(false); onCommand(`/flow details${page ? ` ${page}` : ""}`); }}>{t.details}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <input aria-label={t.flowTarget} placeholder={t.flowTargetPlaceholder} value={target} onChange={event => setTarget(event.target.value)} className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 text-[10px]" />
          <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={busy || !target.trim()} onClick={() => { setOpen(false); onCommand(`/flow retry ${target.trim()}`); }}>{t.retry}</Button>
          <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={busy || !target.trim()} onClick={() => { setOpen(false); onCommand(`/flow cancel ${target.trim()}`); }}>{t.cancel}</Button>
        </div>
        <Button variant={resetArmed ? "default" : "outline"} className="h-6 px-2 text-[10px]" disabled={busy} onClick={() => { if (!resetArmed) { setResetArmed(true); return; } setResetArmed(false); setOpen(false); onCommand("/flow reset confirm"); }}>{resetArmed ? t.confirmReset : t.resetArm}</Button>
      </div>}
      <div className="max-h-[min(24rem,60vh)] overflow-y-auto px-3 py-2">
        {tasks.length > 0 && <ul className="space-y-1" aria-label={t.sessionTasks}>{tasks.map(task => <li key={task.id} className="flex items-start gap-2 rounded-md px-1 py-1 text-xs">
          <TaskIcon status={task.status} />
          <span className="min-w-0 flex-1">
            <span className={`block break-words ${task.status === "completed" ? "text-muted-foreground line-through" : ""}`}>{task.subject}</span>
            <span className="block text-[10px] text-muted-foreground">#{task.id}{task.status === "in_progress" ? " · in progress" : ""}{task.blockedBy.length ? ` · blocked by #${task.blockedBy.join(", #")}` : ""}</span>
          </span>
        </li>)}</ul>}
        {flow.waits.map((wait, index) => <ActivityRow key={index} title={t.waiting} summary={wait.reason} state={wait.state} defaultOpen={wait.handles.length > 0}>
          {wait.handles.length > 0 && <ul className="space-y-0.5">{wait.handles.map(handle => <li key={handle} className="truncate font-mono text-[10px] text-muted-foreground">{handle}</li>)}</ul>}
        </ActivityRow>)}
        {reports.filter((report, index, all) => all.findIndex(item => item.text === report.text) === index).slice(-3).map((report, index) => <FlowReportSummary key={`${report.timestamp ?? index}-${report.kind}`} text={report.text} />)}
        {flowWidgetEntries(widgets).map(([key, lines]) => <div key={key} className="mb-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{widgetLabel(key)}</p>
          <ul className="space-y-0.5">{lines.slice(0, 12).map((line, index) => <li key={index} className="truncate whitespace-pre text-[11px] text-muted-foreground">{line}</li>)}</ul>
        </div>)}
        {flowStatusEntries(statuses).map(([key, text]) => <p key={key} className="mb-1 text-[11px] text-muted-foreground">{text}</p>)}
        {!tasks.length && !flow.waits.length && !reports.length && !flowWidgetEntries(widgets).length && !flowStatusEntries(statuses).length && <p className="py-2 text-xs text-muted-foreground">{t.noFlowActivity}</p>}
      </div>
    </div>}
  </div>;
}
