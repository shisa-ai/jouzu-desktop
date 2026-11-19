import { object, type ChatMessage, type ToolView } from "../chat-projection";
import { toolText } from "./types";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface FlowTask { id: string; subject: string; status: TaskStatus; blockedBy: string[] }
export interface FlowWait { reason: string; deadline?: string; handles: string[]; state: "running" | "done" | "error" }
export interface FlowBackground { command: string; state: "running" | "done" | "error" }
export interface FlowSubagent { id: string; title: string; state: "running" | "done" | "error" }
export interface FlowState { tasks: FlowTask[]; waits: FlowWait[]; background: FlowBackground[] }

const taskLine = /^#?(\d+)\s+\[(pending|in_progress|completed|deleted)\]\s+(.+?)(?:\s+\[blocked by ([^\]]+)\])?$/gmu;
const simpleTaskLine = /^\s*#(\d+)\s+(?!\[)(.+)$/gmu;
export function parseTaskLines(text: string): FlowTask[] {
  const tasks: FlowTask[] = [];
  for (const match of text.matchAll(taskLine)) {
    tasks.push({
      id: match[1]!,
      subject: match[3]!.trim(),
      status: match[2] as TaskStatus,
      blockedBy: match[4] ? match[4].split(",").map(value => value.replace(/#/g, "").trim()).filter(Boolean) : [],
    });
  }
  if (!tasks.length) {
    for (const match of text.matchAll(simpleTaskLine)) {
      tasks.push({ id: match[1]!, subject: match[2]!.trim(), status: "pending", blockedBy: [] });
    }
  }
  return tasks;
}
function argumentsOf(tool: ToolView): Record<string, unknown> {
  if (object(tool.args)) return tool.args;
  if (typeof tool.args === "string") {
    try { const value = JSON.parse(tool.args); return object(value) ? value : {}; } catch { return {}; }
  }
  return {};
}
function statusOf(value: unknown): TaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted" ? value : undefined;
}
function applyTasks(existing: Map<string, FlowTask>, incoming: readonly FlowTask[]) {
  for (const task of incoming) {
    if (task.status === "deleted") existing.delete(task.id);
    else existing.set(task.id, task);
  }
}
export function deriveFlow(tools: Record<string, ToolView>): FlowState {
  const tasks = new Map<string, FlowTask>();
  const waits: FlowWait[] = [];
  const background: FlowBackground[] = [];
  const ordered = Object.values(tools);
  for (const tool of ordered) {
    const args = argumentsOf(tool);
    const text = toolText(tool.result);
    const parsedTasks = parseTaskLines(text);
    if (/^Task/u.test(tool.name) && parsedTasks.length) applyTasks(tasks, parsedTasks);
    if (tool.name === "TaskCreateMany" && Array.isArray(args.tasks) && !parsedTasks.length) {
      args.tasks.forEach((value, index) => {
        const item = object(value) ? value : {};
        const id = `new-${index + 1}`;
        if (!tasks.has(id) && typeof item.subject === "string") tasks.set(id, { id, subject: item.subject, status: "pending", blockedBy: [] });
      });
    }
    if (tool.name === "TaskCreate" && typeof args.subject === "string" && !parsedTasks.length) {
      const id = `new-${tasks.size + 1}`;
      if (!tasks.has(id)) tasks.set(id, { id, subject: args.subject, status: "pending", blockedBy: [] });
    }
    const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
    const update = statusOf(args.status);
    if (tool.name === "TaskUpdate" && taskId && update) {
      if (update === "deleted") tasks.delete(taskId);
      else {
        const current = tasks.get(taskId);
        tasks.set(taskId, { id: taskId, subject: current?.subject ?? `Task #${taskId}`, status: update, blockedBy: current?.blockedBy ?? [] });
      }
    }
    if (tool.name === "agent_wait") {
      const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
      waits.push({
        reason: typeof args.reason === "string" ? args.reason : "Waiting for dependencies",
        deadline: typeof args.deadline === "string" ? args.deadline : undefined,
        handles: Array.isArray(args.on) ? args.on.flatMap(value => { const item = object(value) ? value : {}; return typeof item.handle === "string" ? [item.handle] : []; }) : [],
        state,
      });
    }
    if (tool.name === "bg_task") {
      background.push({
        command: typeof args.command === "string" ? args.command : "Background task",
        state: tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done",
      });
    }
  }
  return {
    tasks: [...tasks.values()].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true })),
    waits,
    background,
  };
}
export function deriveSubagents(tools: Record<string, ToolView>): FlowSubagent[] {
  return Object.values(tools).flatMap(tool => {
    if (!/^(?:subagent|agent)$/u.test(tool.name)) return [];
    const args = argumentsOf(tool);
    const title = typeof args.task === "string" ? args.task : typeof args.role === "string" ? args.role : "Subagent";
    return [{ id: tool.id, title, state: tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done" }];
  });
}
export function latestFlowError(messages: readonly ChatMessage[]): string | undefined {
  const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
  const error = lastAssistant?.errorMessage?.trim();
  if (!error) return undefined;
  return /(?:flow|continuation|ledger|admission|task\s+(?:stale|attach|continuation))/iu.test(error) ? error : undefined;
}
export function isFlowKey(key: string) {
  return /(flow|multi-?loop|task|wait|agent|background|loop)/i.test(key);
}
export function hasFlow(state: FlowState) {
  return state.tasks.length > 0 || state.waits.length > 0 || state.background.length > 0;
}
export function flowStatusEntries(statuses: Record<string, string>): Array<[string, string]> {
  return Object.entries(statuses).filter(([key, text]) => isFlowKey(key) && !isBackgroundActivityKey(key) && !isSubagentActivityKey(key) && text.trim().length > 0);
}
export function flowWidgetEntries(widgets: Record<string, string[]>): Array<[string, string[]]> {
  return Object.entries(widgets).filter(([key, lines]) => isFlowKey(key) && !isBackgroundActivityKey(key) && !isSubagentActivityKey(key) && key !== "tasks" && lines.length > 0);
}
export function isBackgroundActivityKey(key: string) {
  return /(?:background|bg[-_]?jobs?|jobs?)/iu.test(key);
}
export function isSubagentActivityKey(key: string) {
  return /(?:subagents?|delegated-agents?|agents?)/iu.test(key) && !/wait/iu.test(key);
}
export function backgroundWidgetEntries(widgets: Record<string, string[]>): Array<[string, string[]]> {
  return Object.entries(widgets).filter(([key, lines]) => isBackgroundActivityKey(key) && lines.length > 0);
}
export function subagentWidgetEntries(widgets: Record<string, string[]>): Array<[string, string[]]> {
  return Object.entries(widgets).filter(([key, lines]) => isSubagentActivityKey(key) && lines.length > 0);
}
export function backgroundStatusEntries(statuses: Record<string, string>): Array<[string, string]> {
  return Object.entries(statuses).filter(([key, text]) => isBackgroundActivityKey(key) && text.trim().length > 0);
}
export function subagentStatusEntries(statuses: Record<string, string>): Array<[string, string]> {
  return Object.entries(statuses).filter(([key, text]) => isSubagentActivityKey(key) && text.trim().length > 0);
}
export function widgetLabel(key: string) {
  return key.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}
