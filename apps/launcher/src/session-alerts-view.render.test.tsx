import source from "./chat-workspace.tsx?raw";
import appSource from "./App.tsx?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionAlerts, SteerQueue } from "./session-alerts-view";

const noop = () => {};

describe("session notices", () => {
  it("shows one sentence with its actions and keeps the raw text behind Details", () => {
    const html = renderToStaticMarkup(<SessionAlerts alerts={[{ id: "runtime", level: "error", text: "Something in this session failed.", details: "TypeError: boom", actions: [{ label: "Retry", run: noop }], dismiss: noop }]} />);
    expect(html).toContain("Something in this session failed.");
    expect(html).toContain("Details");
    expect(html).toContain("Retry");
    expect(html).toContain("Dismiss");
    // Collapsed until asked for.
    expect(html).not.toContain("TypeError: boom");
  });

  it("renders nothing when there is nothing to say", () => {
    expect(renderToStaticMarkup(<SessionAlerts alerts={[]} />)).toBe("");
  });
});

describe("steer queue", () => {
  it("lists waiting messages in order, each removable and editable", () => {
    const html = renderToStaticMarkup(<SteerQueue items={[{ clientMessageId: "a", text: "first", state: "queued", images: 0 }, { clientMessageId: "b", text: "second", state: "queued", images: 2 }]} onEdit={noop} onRemove={noop} onContinue={noop} onDiscard={noop} />);
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
    expect(html).toContain("2 images");
    expect(html.match(/Remove queued message/g)).toHaveLength(2);
    expect(html.match(/Edit queued message/g)).toHaveLength(2);
    expect(html).not.toContain("Continue");
  });

  it("after Stop offers Continue and Discard", () => {
    const html = renderToStaticMarkup(<SteerQueue items={[{ clientMessageId: "a", text: "first", state: "paused", images: 0 }]} onEdit={noop} onRemove={noop} onContinue={noop} onDiscard={noop} />);
    expect(html).toContain("waiting after the stopped reply");
    expect(html).toContain("Continue");
    expect(html).toContain("Discard");
  });
});

describe("the chat has one place for notices", () => {
  it("has no floating toast or pop-up error", () => {
    expect(source).not.toMatch(/setNotification|className="[^"]*\bfixed\b[^"]*top-16/u);
  });
  it("shows app failures where they happened, not in a floating banner", () => {
    expect(appSource).not.toMatch(/errorBanner|className="[^"]*\bfixed\b[^"]*top-4[^"]*"[^>]*role="alert"|role="alert" className="fixed/u);
  });
  it("asks for nothing through browser dialogs", () => {
    expect(source).not.toMatch(/window\.(prompt|alert)\(/u);
  });
});
