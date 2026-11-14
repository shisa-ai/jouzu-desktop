import { useState } from "react";
import { Check, Copy, Database, GitFork } from "lucide-react";
import { Button } from "./components/ui/button";
import { StatCard, StatPopover, StatRow } from "./components/stat-popover";
import type { ChatMessage } from "./chat-projection";
import { providerLabel } from "./provider-label";

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}
function exact(value: number) {
  return value.toLocaleString("en-US");
}
function percentage(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function messageText(message: ChatMessage) {
  return message.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n").trim();
}
/** End-of-turn actions: copy, fork and the turn's own usage. Feedback is intentionally omitted. */
export function TurnFooter({ message, usage, startedAt, onFork, forkDisabled = false }: { message: ChatMessage; usage?: ChatMessage["usage"]; startedAt?: number; onFork?: () => void; forkDisabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = messageText(message);
  const turnUsage = usage ?? message.usage;
  const total = turnUsage ? (turnUsage.total ?? turnUsage.totalTokens ?? (turnUsage.input ?? 0) + (turnUsage.output ?? 0) + (turnUsage.cacheRead ?? 0) + (turnUsage.cacheWrite ?? 0)) : 0;
  const prompt = turnUsage ? (turnUsage.input ?? 0) + (turnUsage.cacheRead ?? 0) + (turnUsage.cacheWrite ?? 0) : 0;
  const cacheHit = prompt > 0 ? (turnUsage!.cacheRead ?? 0) / prompt * 100 : null;
  const elapsed = message.endedAt && startedAt ? message.endedAt - startedAt : undefined;
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard unavailable; leave the transcript unchanged. */ }
  };
  return <div role="group" aria-label="Turn actions" className="mt-2 flex items-center gap-1 text-muted-foreground">
    <Button type="button" variant="ghost" className="size-7 p-0" aria-label="Copy response" title="Copy response" onClick={() => void copy()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>
    {onFork && <Button type="button" variant="ghost" className="size-7 p-0" aria-label="Branch into a new conversation" title={forkDisabled ? "Wait for the session to finish loading" : "Branch into a new conversation"} disabled={forkDisabled} onClick={onFork}><GitFork className="size-3.5" /></Button>}
    {!!total && <span className="ml-2"><StatPopover label={<><Database className="size-3.5" aria-hidden="true" />Usage {compact(total)} tok{elapsed !== undefined && elapsed >= 0 ? ` · ${duration(elapsed)}` : ""}</>}>
      <StatCard title="Turn usage" value={`${exact(total)} tok`}>
        <StatRow label="Provider / model" value={`${providerLabel(message.provider)} / ${message.model ?? "—"}`} />
        {cacheHit !== null && <StatRow label="Cache hit" value={percentage(cacheHit)} />}
        <StatRow label="Uncached input" value={`${exact(turnUsage?.input ?? 0)} tok`} />
        <StatRow label="Cache read" value={`${exact(turnUsage?.cacheRead ?? 0)} tok`} />
        <StatRow label="Cache write" value={`${exact(turnUsage?.cacheWrite ?? 0)} tok`} />
        <StatRow label="Output" value={`${exact(turnUsage?.output ?? 0)} tok`} />
      </StatCard>
    </StatPopover></span>}
    {!total && elapsed !== undefined && elapsed >= 0 && <span className="ml-2 text-[11px] tabular-nums">{duration(elapsed)}</span>}
  </div>;
}
