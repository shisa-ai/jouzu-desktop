import { ActivityRow } from "./activity-row";
import { object, type ToolView } from "../chat-projection";
import { toolText, type ToolRendererProps } from "./types";
import { useChatText } from "../chat-text";

function argsOf(tool: ToolView): Record<string, unknown> {
  if (object(tool.args)) return tool.args;
  if (typeof tool.args === "string") { try { const value = JSON.parse(tool.args); return object(value) ? value : {}; } catch { return {}; } }
  return {};
}
export function BackgroundRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const args = argsOf(tool);
  const text = toolText(tool.result);
  return <ActivityRow title={t.backgroundTask} summary={typeof args.command === "string" ? args.command : undefined} state={tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done"} defaultOpen={!!text}>
    {text && <pre className="max-h-72 overflow-auto whitespace-pre-wrap select-text text-[11px]">{text}</pre>}
  </ActivityRow>;
}
