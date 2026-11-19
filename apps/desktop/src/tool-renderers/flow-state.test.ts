import { describe, expect, it } from "vitest";
import { backgroundWidgetEntries, deriveFlow, deriveSubagents, flowWidgetEntries, hasFlow, latestFlowError, parseTaskLines, subagentWidgetEntries, widgetLabel } from "./flow-state";
import { flowReport } from "./flow-report";
import type { ToolView } from "../chat-projection";

const tool = (id: string, name: string, args: unknown, text = "", phase: ToolView["phase"] = "complete"): ToolView => ({
  id,
  name,
  args,
  phase,
  result: text ? { content: [{ type: "text", text }] } : undefined,
});

describe("flow tool projection", () => {
  it("parses task list lines and blocked-by dependencies", () => {
    expect(parseTaskLines("#1 [pending] Fix auth\n#2 [in_progress] Add tests [blocked by #1]\n#3 [completed] Docs")).toEqual([
      { id: "1", subject: "Fix auth", status: "pending", blockedBy: [] },
      { id: "2", subject: "Add tests", status: "in_progress", blockedBy: ["1"] },
      { id: "3", subject: "Docs", status: "completed", blockedBy: [] },
    ]);
    expect(parseTaskLines("Created 2 tasks:\n  #1 Implement flow UI\n  #2 Test task renderer")).toEqual([
      { id: "1", subject: "Implement flow UI", status: "pending", blockedBy: [] },
      { id: "2", subject: "Test task renderer", status: "pending", blockedBy: [] },
    ]);
  });
  it("derives tasks, waits and background jobs from tool calls", () => {
    const flow = deriveFlow({
      a: tool("a", "TaskCreate", { subject: "Review shell" }, "#1 [pending] Review shell"),      b: tool("b", "TaskUpdate", { taskId: "1", status: "in_progress" }),
      c: tool("c", "TaskList", {}, "#1 [in_progress] Review shell\n#2 [pending] Add tests [blocked by #1]"),
      d: tool("d", "agent_wait", { reason: "Wait for CI", deadline: "10m", on: [{ handle: "job-7" }] }, "", "running"),
      e: tool("e", "bg_task", { command: "npm test" }, "started", "running"),
    });
    expect(flow.tasks).toEqual([
      { id: "1", subject: "Review shell", status: "in_progress", blockedBy: [] },
      { id: "2", subject: "Add tests", status: "pending", blockedBy: ["1"] },
    ]);
    expect(flow.waits[0]).toMatchObject({ reason: "Wait for CI", state: "running", handles: ["job-7"] });
    expect(flow.background[0]).toMatchObject({ command: "npm test", state: "running" });
  });
  it("uses IDs from a TaskCreateMany result instead of inventing duplicates", () => {
    const flow = deriveFlow({
      a: tool("a", "TaskCreateMany", { tasks: [{ subject: "Implement flow UI" }, { subject: "Test task renderer" }] }, "Created 2 tasks:\n  #1 Implement flow UI\n  #2 Test task renderer"),
    });
    expect(flow.tasks).toEqual([
      { id: "1", subject: "Implement flow UI", status: "pending", blockedBy: [] },
      { id: "2", subject: "Test task renderer", status: "pending", blockedBy: [] },
    ]);
  });
  it("recognizes structured Flow reports without treating raw text as commands", () => {
    expect(flowReport(JSON.stringify({ kind: "work", content: "Scanning files" }))).toMatchObject({ kind: "work", title: "Scanning files" });
    expect(flowReport(JSON.stringify({ kind: "result", content: { sample: [{ title: "Build", status: "success" }], omitted: 2 } }))).toMatchObject({ kind: "result", omitted: 2 });
    expect(flowReport("not json")).toBeUndefined();
  });
  it("derives subagent activity separately from tasks and background jobs", () => {
    const agents = deriveSubagents({
      a: tool("a", "subagent", { op: "run", role: "reviewer", task: "Review the diff" }, "", "running"),
      b: tool("b", "subagent", { task: "Inspect tests" }, "", "complete"),
      c: tool("c", "bg_task", { command: "npm test" }, "started", "running"),
    });
    expect(agents).toEqual([
      { id: "a", title: "Review the diff", state: "running" },
      { id: "b", title: "Inspect tests", state: "done" },
    ]);
  });
  it("keeps background and subagent widgets out of Flow", () => {
    const widgets = { background: ["job 1 running"], subagents: ["reviewer"], multiloop: ["1 running"] };
    expect(flowWidgetEntries(widgets)).toEqual([["multiloop", ["1 running"]]]);
    expect(backgroundWidgetEntries(widgets)).toEqual([["background", ["job 1 running"]]]);
    expect(subagentWidgetEntries(widgets)).toEqual([["subagents", ["reviewer"]]]);
  });
  it("surfaces Flow-scoped transcript errors without promoting ordinary turn errors", () => {
    expect(latestFlowError([{ role: "assistant", content: [], errorMessage: "Consumed task continuation is no longer attached." }])).toContain("Consumed task continuation");
    expect(latestFlowError([{ role: "assistant", content: [], errorMessage: "Request was aborted" }])).toBeUndefined();
    expect(latestFlowError([{ role: "assistant", content: [], errorMessage: "Flow state is stale" }, { role: "assistant", content: [] }])).toBeUndefined();
  });
  it("labels runtime widget keys for the panel", () => {
    expect(widgetLabel("schedule-prompts")).toBe("Schedule Prompts");
    expect(widgetLabel("multiloop_resume")).toBe("Multiloop Resume");
  });
  it("opens Flow only for real flow semantics, not arbitrary status widgets", () => {
    expect(hasFlow({ tasks: [], waits: [], background: [] })).toBe(false);
    expect(hasFlow({ tasks: [], waits: [{ reason: "waiting", handles: [], state: "running" }], background: [] })).toBe(true);
    expect(flowWidgetEntries({ multiloop: ["1 running"], theme: ["dark"] })).toEqual([["multiloop", ["1 running"]]]);
  });
});
