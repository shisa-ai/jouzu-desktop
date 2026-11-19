import { ActivityRow } from "./activity-row";
import { ToolOutput } from "./tool-output";
import { record, toolText, type ToolRendererProps } from "./types";
import { useChatText, type ChatText } from "../chat-text";

const NAMED = ["compact_context", "subagent", "schedule_prompt", "agent_no_reply"] as const;
const named = (t: ChatText) => ({
  compact_context: { title: t.contextCompaction, summary: t.requestedNextTurn },
  subagent: { title: t.subagent, summary: t.delegatedWork },
  schedule_prompt: { title: t.scheduledPrompt, summary: t.queuedLater },
  agent_no_reply: { title: t.noReply, summary: t.notificationOnly },
});
export type NamedTool = typeof NAMED[number];
export function isNamedTool(name: string): name is NamedTool { return (NAMED as readonly string[]).includes(name); }
export function NamedRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const definition = named(t)[tool.name as NamedTool];
  const args = record(tool.args) ?? {};
  const detail = tool.name === "subagent"
    ? [args.op, args.role, args.task].filter(value => typeof value === "string").join(" · ")
    : tool.name === "schedule_prompt" && typeof args.prompt === "string" ? args.prompt : undefined;
  const text = toolText(tool.result);
  return <ActivityRow title={definition.title} summary={detail || definition.summary} state={tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done"} defaultOpen={!!text}>
    {text && <ToolOutput tool={tool} />}
  </ActivityRow>;
}
