import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolView } from "../chat-projection";
import { ActivityStrip, isRichTool, ToolChipGroup } from "./tool-chip";

function tool(overrides: Partial<ToolView>): ToolView {
  return { id: "call-1", name: "bash", args: { command: "ls" }, phase: "complete", result: { content: [{ type: "text", text: "a" }] }, ...overrides };
}

describe("tool chips", () => {
  it("renders a compact group without a full card", () => {
    const html = renderToStaticMarkup(<ToolChipGroup tools={[tool({ id: "a" }), tool({ id: "b", name: "read" })]} />);
    expect(html).toContain('aria-label="Activity"');
    expect(html).toContain('aria-label="bash · done"');
    expect(html).toContain('aria-label="read · done"');
    expect(html).not.toContain("Completed");
  });

  it("puts thinking in the same strip as tools", () => {
    const html = renderToStaticMarkup(<ActivityStrip items={[
      { kind: "thinking", id: "think-1", text: "weighing options", streaming: false },
      { kind: "tool", tool: tool({ id: "a" }) },
    ]} />);
    expect(html).toContain('aria-label="Thinking · done"');
    expect(html).toContain('aria-label="bash · done"');
    expect(html).not.toContain("weighing options");
  });

  it("only keeps generated images as cards", () => {
    expect(isRichTool(tool({ name: "generate_image" }))).toBe(true);
    expect(isRichTool(tool({ name: "TaskUpdate" }))).toBe(false);
    expect(isRichTool(tool({ name: "bg_task" }))).toBe(false);
    expect(isRichTool(tool({ name: "bash" }))).toBe(false);
    expect(isRichTool(tool({ name: "web_fetch" }))).toBe(false);
  });
});
