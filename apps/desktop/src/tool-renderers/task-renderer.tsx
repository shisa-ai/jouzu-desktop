import { ActivityRow, type ActivityState } from "./activity-row";
import { object, type ToolView } from "../chat-projection";
import type { ToolRendererProps } from "./types";
import { fill, useChatText } from "../chat-text";

function argsOf(tool: ToolView): Record<string, unknown> {
  if (object(tool.args)) return tool.args;
  if (typeof tool.args === "string") { try { const value = JSON.parse(tool.args); return object(value) ? value : {}; } catch { return {}; } }
  return {};
}

/** Task mutations are summarized here only. The authoritative task list is the
 * session-scoped Flow dock, so the transcript never renders a second todo list. */
export function TaskRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const args = argsOf(tool);
  const tasks = Array.isArray(args.tasks) ? args.tasks.flatMap(value => object(value) ? [value] : []) : [];
  const count = tasks.length || (typeof args.subject === "string" ? 1 : 0);
  const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
  const phase: ActivityState = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const title = tool.name === "TaskCreateMany" || tool.name === "TaskCreate" ? t.tasksUpdated
    : tool.name === "TaskUpdate" ? t.taskUpdated
      : tool.name === "TaskExecute" ? t.taskExecution : t.tasks;
  const summary = taskId ? `#${taskId}${typeof args.status === "string" ? ` · ${args.status.replaceAll("_", " ")}` : ""}`
    : count ? fill(t.taskCount, { n: count }) : undefined;
  const detail = tasks.slice(0, 8).map(task => [typeof task.subject === "string" ? task.subject : "", typeof task.status === "string" ? task.status.replaceAll("_", " ") : ""].filter(Boolean).join(" · ")).filter(Boolean);
  return <ActivityRow title={title} summary={summary} state={phase}>
    <div className="space-y-1 text-[11px] text-muted-foreground">
      {typeof args.subject === "string" && <p className="text-foreground">{args.subject}</p>}
      {detail.map((line, index) => <p key={index} className="truncate">{line}</p>)}
      {!detail.length && !taskId && <p>{t.noTaskDetails}</p>}
    </div>
  </ActivityRow>;
}
