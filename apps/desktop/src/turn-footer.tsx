import { useState } from "react";
import { ResultMark, type ControlResult } from "./control-result";
import { Check, Copy, Database, GitFork } from "lucide-react";
import { Button } from "./components/ui/button";
import { StatCard, StatPopover, StatRow } from "./components/stat-popover";
import type { ChatMessage } from "./chat-projection";
import { providerLabel } from "./provider-label";
import { copyText } from "./secure-context";
import { fill, useChatText } from "./chat-text";

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
export function TurnFooter({ message, usage, startedAt, onFork, forkDisabled = false, forkResult }: { message: ChatMessage; usage?: ChatMessage["usage"]; startedAt?: number; onFork?: () => void; forkDisabled?: boolean; forkResult?: ControlResult }) {
  const t = useChatText();
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
      await copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard unavailable; leave the transcript unchanged. */ }
  };
  return <div role="group" aria-label={t.turnActions} className="mt-2 flex items-center gap-1 text-muted-foreground">
    <Button type="button" variant="ghost" className="size-7 p-0" aria-label={t.copyResponse} title={t.copyResponse} onClick={() => void copy()}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>
    {onFork && <Button type="button" variant="ghost" className="size-7 p-0" aria-label={t.branchConversation} title={forkDisabled ? t.waitForLoading : t.branchConversation} disabled={forkDisabled} onClick={onFork}><GitFork className="size-3.5" /></Button>}
    {onFork && <ResultMark result={forkResult} align="left" />}
    {!!total && <span className="ml-2"><StatPopover label={<><Database className="size-3.5" aria-hidden="true" />{fill(t.usageTokens, { n: compact(total) })}{elapsed !== undefined && elapsed >= 0 ? ` · ${duration(elapsed)}` : ""}</>}>
      <StatCard title={t.turnUsage} value={`${exact(total)} tok`}>
        <StatRow label={t.providerModel} value={`${providerLabel(message.provider)} / ${message.model ?? "—"}`} />
        {cacheHit !== null && <StatRow label={t.cacheHit} value={percentage(cacheHit)} />}
        <StatRow label={t.uncachedInput} value={`${exact(turnUsage?.input ?? 0)} tok`} />
        <StatRow label={t.cacheRead} value={`${exact(turnUsage?.cacheRead ?? 0)} tok`} />
        <StatRow label={t.cacheWrite} value={`${exact(turnUsage?.cacheWrite ?? 0)} tok`} />
        <StatRow label={t.output} value={`${exact(turnUsage?.output ?? 0)} tok`} />
      </StatCard>
    </StatPopover></span>}
    {!total && elapsed !== undefined && elapsed >= 0 && <span className="ml-2 text-[11px] tabular-nums">{duration(elapsed)}</span>}
  </div>;
}
