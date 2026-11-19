import { ActivityRow, type ActivityState } from "./activity-row";
import { record, toolText, type ToolRendererProps } from "./types";
import { useChatText } from "../chat-text";

export interface FlowResultRow { title: string; state: ActivityState; reference?: string; warnings: string[] }
export type FlowReport =
  | { kind: "result"; rows: FlowResultRow[]; omitted: number }
  | { kind: "work" | "alert"; title: string; state: ActivityState }
  | { kind: "wait"; state: ActivityState; reason?: string; observations: string[] };
export function flowReport(text: string): FlowReport | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const envelope = record(parsed);
  if (!envelope || typeof envelope.kind !== "string") return undefined;
  const content = record(envelope.content);
  if (envelope.kind === "result" && content && Array.isArray(content.sample)) {
    const rows = content.sample.flatMap(value => {
      const item = record(value);
      if (!item) return [];
      return [{
        title: typeof item.title === "string" ? item.title : "",
        state: (item.status === "success" ? "done" : item.status === "failure" ? "error" : "idle") as ActivityState,
        reference: typeof item.reference === "string" ? item.reference : undefined,
        warnings: Array.isArray(item.warnings) ? item.warnings.filter((warning): warning is string => typeof warning === "string") : [],
      }];
    });
    return { kind: "result" as const, rows, omitted: typeof content.omitted === "number" ? content.omitted : 0 };
  }
  if ((envelope.kind === "work" || envelope.kind === "alert") && typeof envelope.content === "string") {
    return { kind: envelope.kind, title: envelope.content, state: (envelope.kind === "alert" ? "warning" : "idle") as ActivityState };
  }
  const wait = record(content?.wait);
  if (envelope.kind === "wait" && wait) {
    return {
      kind: "wait" as const,
      state: (wait.state === "resolved" ? "done" : wait.state === "failed" ? "error" : "idle") as ActivityState,
      reason: typeof wait.reason === "string" ? wait.reason : undefined,
      observations: Array.isArray(wait.observations) ? wait.observations.flatMap(value => {
        const item = record(value);
        const text = [item?.handle, item?.state, item?.health].filter(value => typeof value === "string").join(" · ");
        return text ? [text] : [];
      }) : [],
    };
  }
  return undefined;
}

export function FlowReportSummary({ text }: { text: string }) {
  const t = useChatText();
  const report = flowReport(text);
  if (!report) return null;
  if (report.kind === "result") return <section aria-label={t.flowResults} className="space-y-1">
    {report.rows.map((row, index) => <ActivityRow key={index} title={row.title || t.result} state={row.state} defaultOpen={row.warnings.length > 0}>
      {row.reference && <p className="text-muted-foreground">Log: {row.reference}</p>}
      {row.warnings.map((warning, position) => <p key={position} role="alert" className="text-destructive">{warning}</p>)}
    </ActivityRow>)}
    {report.omitted > 0 && <p className="px-1 text-[11px] text-muted-foreground">{report.omitted} more omitted</p>}
  </section>;
  if (report.kind === "wait") return <ActivityRow title={t.waiting} summary={report.reason} state={report.state} defaultOpen={report.observations.length > 0}>
    <ul className="space-y-1">{report.observations.map((observation, index) => <li key={index} className="truncate text-muted-foreground">{observation}</li>)}</ul>
  </ActivityRow>;
  return <ActivityRow title={report.kind === "alert" ? t.flowAlert : t.flowWork} summary={report.title} state={report.state} />;
}
export function FlowReportRenderer({ tool }: ToolRendererProps) {
  return <FlowReportSummary text={toolText(tool.result)} />;
}
