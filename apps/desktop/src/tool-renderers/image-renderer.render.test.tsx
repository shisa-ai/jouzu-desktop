import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageRenderer } from "./image-renderer";
import type { ToolView } from "../chat-projection";

function tool(overrides: Partial<ToolView> = {}): ToolView {
  return {
    id: "call-1",
    name: "generate_image",
    args: { prompt: "a cat" },
    phase: "complete",
    result: {
      content: [
        { type: "text", text: "Generated 1 image." },
        { type: "image", mimeType: "image/png", data: "QUJD" },
      ],
      details: {
        prompt: "a cat",
        provider: "shisa",
        model: "gemini-3-pro-image",
        size: "2K",
        images: [{ id: "abc", path: "C:/artifacts/images/abc.png", mimeType: "image/png", bytes: 3, width: 2816, height: 1536 }],
      },
    },
    ...overrides,
  };
}

describe("image tool view", () => {
  it("shows the image, its caption and artifact actions without expanding", () => {
    const html = renderToStaticMarkup(<ImageRenderer tool={tool()} />);
    expect(html).toContain('alt="a cat"');
    expect(html).toContain("1 image");
    expect(html).toContain("gemini-3-pro-image");
    expect(html).toContain("2816×1536");
    expect(html).toContain("Open large image");
    expect(html).toContain("Download");
    expect(html).toContain("Copy path");
    expect(html).toContain("Show in folder");
    expect(html).toContain("Use as attachment");
  });

  it("still shows the image when the old result has no details", () => {
    const old = tool({ result: { content: [{ type: "image", mimeType: "image/png", data: "QUJD" }] } });
    const html = renderToStaticMarkup(<ImageRenderer tool={old} />);
    expect(html).toContain('alt="Tool output image"');
    expect(html).toContain("Open large image");
    expect(html).not.toContain("Show in folder");
  });

  it("says it is generating before the result exists", () => {
    const html = renderToStaticMarkup(<ImageRenderer tool={tool({ phase: "running", result: undefined })} />);
    expect(html).toContain("Generating");
  });
});
