import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolView } from "../chat-projection";
import { GenericRenderer } from "./generic-renderer";
import { ToolRenderer } from "./index";
import { ToolFrame, defaultOpenFor } from "./tool-frame";

function tool(overrides: Partial<ToolView> = {}): ToolView {
  return { id: "call-1", name: "bash", args: { command: "ls" }, phase: "complete", result: { content: [{ type: "text", text: "a.txt" }] }, ...overrides };
}

describe("tool folding", () => {
  it("opens running and failed tools, and closes completed text tools", () => {
    expect(defaultOpenFor("running")).toBe(true);
    expect(defaultOpenFor("error")).toBe(true);
    expect(defaultOpenFor("warning")).toBe(true);
    expect(defaultOpenFor("done")).toBe(false);
  });

  it("renders the body only when the derived state is open", () => {
    const running = renderToStaticMarkup(<ToolFrame title="Command" state="running"><p>live output</p></ToolFrame>);
    expect(running).toContain('aria-expanded="true"');
    expect(running).toContain("live output");

    const done = renderToStaticMarkup(<ToolFrame title="Command" state="done"><p>finished output</p></ToolFrame>);
    expect(done).toContain('aria-expanded="false"');
    expect(done).not.toContain("finished output");
  });

  it("honours an explicit open for rich completed content", () => {
    const html = renderToStaticMarkup(<ToolFrame title="Generated image" state="done" defaultOpen><p>image</p></ToolFrame>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("image");
  });
});

describe("tool coverage", () => {
  it("gives an unknown tool a complete fallback card", () => {
    const html = renderToStaticMarkup(<GenericRenderer tool={tool({ name: "future_tool", args: { x: 1 }, phase: "error", result: undefined })} />);
    expect(html).toContain("future_tool");
    expect(html).toContain("Arguments");
    expect(html).toContain("Failed");
  });

  it("renders a card for every observed tool family", () => {
    for (const name of ["bash", "read", "write", "edit", "apply_patch", "web_fetch", "batch_web_fetch", "tff-search_web", "future_tool"]) {
      const html = renderToStaticMarkup(<ToolRenderer tool={tool({ name })} />);
      expect(html, name).toContain("aria-expanded");
      expect(html, name).toContain("Completed");
    }
  });
});
