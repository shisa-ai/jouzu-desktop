import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolReviewDialog } from "./tool-review-dialog";

const structured = JSON.stringify({ tool: "generate_image", images: 1, prompt: "a cat on a mat", provider: "shisa", model: "gemini-3-pro-image", size: "2K" });

describe("tool review dialog", () => {
  it("renders structured review fields and the options the runtime sent", () => {
    const html = renderToStaticMarkup(<ToolReviewDialog title="Review tool call" body={structured} options={["Approve", "Approve for this session", "Deny"]} disabled={false} onSelect={() => {}} onCancel={() => {}} />);
    expect(html).toContain("Review tool call");
    expect(html).toContain("generate_image · 1 image");
    expect(html).toContain("a cat on a mat");
    expect(html).toContain("shisa · gemini-3-pro-image · 2K");
    expect(html).toContain("This runs 1 paid image generation");
    expect(html).toContain("Approve for this session");
    expect(html).toContain("Deny");
    expect(html).toContain("Cancel");
  });

  it("falls back to plain text for a body that is not structured", () => {
    const html = renderToStaticMarkup(<ToolReviewDialog title="Review tool call" body="A plain review body" options={["Deny"]} disabled={false} onSelect={() => {}} onCancel={() => {}} />);
    expect(html).toContain("A plain review body");
  });

  it("disables every action while the runtime is busy", () => {
    const html = renderToStaticMarkup(<ToolReviewDialog title="Review tool call" body="" options={["Deny"]} disabled onSelect={() => {}} onCancel={() => {}} />);
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
