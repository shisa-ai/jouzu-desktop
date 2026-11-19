import { CircleGauge, Database, Gauge } from "lucide-react";
import type { SessionStats, SessionTiming } from "./chat-types";
import { StatCard, StatPopover, StatRow } from "./components/stat-popover";
import { fill, useChatText } from "./chat-text";

function compact(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}
function exact(value: number) {
  return value.toLocaleString("en-US");
}
function formatDuration(ms: number) {
  if (ms <= 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}
/** Whole-session counters and their DSH-style detail cards; no wall-clock session timer. */
export function SessionStatsBar({ stats, timing, firstOutputMs }: { stats?: SessionStats; timing?: SessionTiming; firstOutputMs?: number | null }) {
  const t = useChatText();
  // The row is always there, empty or not: stats that come and go (a runtime that
  // restarted has none yet) never move the composer above it (#153).
  const empty = <div aria-hidden="true" data-session-usage-empty className="h-8" />;
  if (!stats) return empty;
  const tokens = stats.tokens ?? {};
  const total = Number.isFinite(tokens.total) ? tokens.total! : (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  const prompt = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  const cached = prompt > 0 ? Math.round((tokens.cacheRead ?? 0) / prompt * 100) : null;
  // Turn and step counts are debug data (host.log and the API), not shown here.
  const modelMs = timing?.modelMs ?? 0;
  const percent = stats.contextUsage?.percent;
  const speed = timing && timing.modelMs > 0 ? timing.outputTokens / (timing.modelMs / 1000) : null;
  if (!total && !modelMs && percent == null) return empty;
  return <div aria-label={t.sessionUsage} className="mx-auto flex min-h-8 max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-[11px] text-muted-foreground">
    {modelMs > 0 && <StatPopover label={<><Gauge className="size-3.5" aria-hidden="true" />{speed !== null && speed > 0 ? `${compact(speed)} tok/s` : formatDuration(modelMs)}</>}>
      <StatCard title={t.sessionStats}>
        <StatRow label={t.modelTime} value={formatDuration(timing?.modelMs ?? 0)} />
        <StatRow label={t.toolTime} value={formatDuration(timing?.toolMs ?? 0)} />
        <StatRow label={t.firstTokenAvg} value={firstOutputMs != null ? formatDuration(firstOutputMs) : "—"} />
        <StatRow label={t.outputSpeed} value={speed !== null ? `${compact(speed)} tok/s` : "—"} />
      </StatCard>
    </StatPopover>}
    {!!total && <StatPopover label={<><Database className="size-3.5" aria-hidden="true" />{compact(total)} tok{cached !== null ? ` · ${fill(t.percentCached, { n: cached })}` : ""}</>}>
      <StatCard title={t.tokenUsage} value={`${exact(total)} tok`}>
        {cached !== null && <StatRow label={t.cacheHit} value={`${cached}%`} />}
        <StatRow label={t.uncachedInput} value={`${exact(tokens.input ?? 0)} tok`} />
        <StatRow label={t.cacheRead} value={`${exact(tokens.cacheRead ?? 0)} tok`} />
        {!!tokens.cacheWrite && <StatRow label={t.cacheWrite} value={`${exact(tokens.cacheWrite)} tok`} />}
        <StatRow label={t.output} value={`${exact(tokens.output ?? 0)} tok`} />
      </StatCard>
    </StatPopover>}
    {percent != null && <StatPopover align="right" label={<><CircleGauge className="size-3.5" aria-hidden="true" />{Math.round(percent)}%</>}>
      <StatCard title={t.contextUsed} value={`~${compact(stats.contextUsage?.tokens ?? 0)} / ${compact(stats.contextUsage?.contextWindow ?? 0)}`}>
        <div className="pt-2"><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div></div>
      </StatCard>
    </StatPopover>}
  </div>;
}
