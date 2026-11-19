import { ActivityRow, type ActivityState } from "./activity-row";
import { object, type ToolView } from "../chat-projection";
import { toolText, type ToolRendererProps } from "./types";
import { useChatText } from "../chat-text";

function argsOf(tool: ToolView): Record<string, unknown> {
  if (object(tool.args)) return tool.args;
  if (typeof tool.args === "string") { try { const value = JSON.parse(tool.args); return object(value) ? value : {}; } catch { return {}; } }
  return {};
}
export function WaitRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const args = argsOf(tool);
  const state: ActivityState = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const handles = Array.isArray(args.on) ? args.on.flatMap(value => { const item = object(value) ? value : {}; return typeof item.handle === "string" ? [item.handle] : []; }) : [];
  const text = toolText(tool.result);
  return <ActivityRow title={tool.name === "agent_wait_cancel" ? t.waitReleased : t.waitingDependencies} summary={typeof args.reason === "string" ? args.reason : typeof args.deadline === "string" ? `Deadline ${args.deadline}` : undefined} state={state} defaultOpen={!!text}>
    {handles.length > 0 && <ul className="mb-1 space-y-1">{handles.map(handle => <li key={handle} className="truncate font-mono text-[11px] text-muted-foreground">{handle}</li>)}</ul>}
    {text && <p className="whitespace-pre-wrap select-text">{text}</p>}
  </ActivityRow>;
}
