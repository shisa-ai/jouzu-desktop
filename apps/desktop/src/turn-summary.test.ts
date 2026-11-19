import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolView } from "./chat-projection";
import { summarizeTurn } from "./turn-summary";

const messages: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "generate and write" }] },
  { role: "assistant", content: [
    { type: "toolCall", id: "c1", name: "generate_image", arguments: { prompt: "a cat" } },
    { type: "toolCall", id: "c2", name: "write", arguments: { path: "C:/work/a.md" } },
    { type: "text", text: "done" },
  ] },
];

const tools: Record<string, ToolView> = {
  c1: { id: "c1", name: "generate_image", args: { prompt: "a cat" }, phase: "complete", result: {
    content: [{ type: "image", mimeType: "image/png", data: "QUJD" }],
    details: { prompt: "a cat", images: [{ id: "abc", path: "C:/artifacts/images/abc.png", width: 10, height: 20 }] },
  } },
  c2: { id: "c2", name: "write", args: { path: "C:/work/a.md" }, phase: "complete", result: { content: [{ type: "text", text: "ok" }] } },
};

describe("turn summary", () => {
  it("collects images and edited files from the transcript alone", () => {
    const summary = summarizeTurn(messages, tools, 1);
    expect(summary.artifacts).toHaveLength(1);
    expect(summary.artifacts[0]).toMatchObject({ id: "abc", mime: "image/png", path: "C:/artifacts/images/abc.png", width: 10, height: 20, prompt: "a cat" });
    expect(summary.files).toEqual(["C:/work/a.md"]);
  });

  it("recovers the path for a result that predates details", () => {
    const old: Record<string, ToolView> = {
      c1: { id: "c1", name: "generate_image", args: {}, phase: "complete", result: { content: [
        { type: "text", text: "Generated an image and saved it to C:/artifacts/images/image-1.jpg" },
        { type: "image", mimeType: "image/jpeg", data: "QUJD" },
      ] } },
    };
    const summary = summarizeTurn(messages.slice(0, 2), old, 1);
    expect(summary.artifacts[0].path).toBe("C:/artifacts/images/image-1.jpg");
    expect(summary.artifacts[0].prompt).toBe("a cat");
  });

  it("ignores a turn with nothing produced", () => {
    const plain: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "text", text: "hello" }] }];
    expect(summarizeTurn(plain, {}, 1)).toEqual({ artifacts: [], files: [] });
  });

  it("includes a file that only a shell command created", () => {
    // The transcript mentions write for a.md; the pdf came from a bash command and
    // is only visible through the workspace diff.
    const summary = summarizeTurn(messages, tools, 1, ["C:/work/hello.pdf", "C:/work/a.md"]);
    expect(summary.files).toEqual(["C:/work/hello.pdf", "C:/work/a.md"]);
  });

  it("ignores case and separator differences when merging", () => {
    const summary = summarizeTurn(messages, tools, 1, ["c:\\work\\A.MD"]);
    expect(summary.files).toEqual(["c:\\work\\A.MD"]);
  });
});
