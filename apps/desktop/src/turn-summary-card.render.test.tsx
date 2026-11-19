import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnSummary } from "./turn-summary-card";

const data = {
  artifacts: [{ id: "abc", mime: "image/png", data: "QUJD", path: "C:/artifacts/abc.png", width: 10, height: 20, prompt: "a cat" }],
  files: [],
};

describe("turn summary card", () => {
  it("offers View in artifacts when a turn produced artifacts", () => {
    const html = renderToStaticMarkup(<TurnSummary data={data} onOpenArtifacts={() => {}} />);
    expect(html).toContain("1 image");
    expect(html).toContain("View in artifacts");
    expect(html).toContain('alt="a cat"');
  });

  it("omits the action when no callback is provided", () => {
    const html = renderToStaticMarkup(<TurnSummary data={data} />);
    expect(html).not.toContain("View in artifacts");
  });
});
