import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdatePreview, hasUpdateMark, type DesktopUpdateState, type RuntimeDetailState } from "./update-preview";

const live = (over: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  version: "1.1.4-rc.1",
  stamp: "81d7bae9a5b9 · 20261119T095741798Z-292c4003",
  phase: "current",
  target: null,
  downgrade: false,
  notes: null,
  error: null,
  configured: true,
  channel: { value: "stable", set: () => {} },
  check: () => {},
  install: () => {},
  ...over,
});

const runtime: RuntimeDetailState = { version: "0.2.5", broken: false };
const render = (state: Partial<DesktopUpdateState>, detail = runtime, repair?: { label: string; run: () => void }) =>
  renderToStaticMarkup(<UpdatePreview locale="en" live={live(state)} runtime={detail} repair={repair} />);

describe("one Jouzu Desktop row (ui-layer §6.2)", () => {
  it("shows the app version once, the build stamp as a tooltip, and the runtime as a detail line", () => {
    const html = render({});
    expect(html.split('aria-label="Jouzu Desktop"').length - 1).toBe(1);
    expect(html).toContain("1.1.4-rc.1");
    expect(html).toContain("title=\"81d7bae9a5b9 · 20261119T095741798Z-292c4003\"");
    // The stamp is not a line of its own.
    expect(html).not.toContain(">81d7bae9a5b9<");
    expect(html).toContain("Runtime 0.2.5");
  });

  it("has no runtime update row, its button, or its unavailable text", () => {
    const html = render({ phase: "available", target: "1.1.5" });
    expect(html).not.toContain("Update Jouzu");
    expect(html).not.toContain("Online updates are unavailable");
    expect(html).not.toContain('aria-label="Jouzu"');
  });

  it("says an older build on the channel is a test build, with a plain install button and no update marks", () => {
    const html = render({ phase: "available", target: "1.0.23", downgrade: true, notes: "### Old notes\n- Already in this build" });
    expect(html).toContain("This is a test build");
    expect(html).toContain("Install Stable 1.0.23 (older)");
    expect(html).not.toContain("Update available");
    expect(html).not.toContain("Update and restart");
    expect(html).not.toContain("What&#x27;s new");
    expect(html).not.toContain("Already in this build");
    // A plain action, not the primary one.
    expect(html).toContain("Install Stable 1.0.23 (older)</button>");
    expect(html.match(/bg-primary[^"]*"[^>]*>Install Stable/g)).toBeNull();
  });

  it("offers a newer build as an update with its notes and the channel", () => {
    const html = render({ phase: "available", target: "1.1.5", notes: "### New notes\n- A change" });
    expect(html.split("Update available").length - 1).toBe(1);
    expect(html).toContain("Update and restart");
    expect(html).toContain("New notes");
    expect(html).toContain("A change");
    expect(html).toContain("Update channel");
  });

  it("says checking without the channel, and up to date with it", () => {
    expect(render({ phase: "checking" })).toContain("Checking…");
    expect(render({ phase: "checking" })).not.toContain("Update channel");
    const current = render({ phase: "current" });
    expect(current).toContain("Up to date");
    expect(current).toContain("Update channel");
  });

  it("shows a failed check with its reason and Retry", () => {
    const html = render({ phase: "error", error: "network" });
    expect(html).toContain("Could not check for updates");
    // The original text stays behind Details, not in the sentence.
    expect(html).toContain(">Details<");
    expect(html).not.toContain(">network<");
    expect(html).toContain('aria-label="Retry"');
  });

  it("shows progress while downloading and installing", () => {
    expect(render({ phase: "downloading", progress: 40 })).toContain("Downloading…");
    expect(render({ phase: "downloading" })).toContain("progressbar");
    expect(render({ phase: "installing" })).toContain("Installing…");
  });
});

describe("the sidebar update mark follows a real update only (#176)", () => {
  it("marks a newer build, and not an older build offered on the channel", () => {
    expect(hasUpdateMark("1.1.5", false)).toBe(true);
    expect(hasUpdateMark("1.0.23", true)).toBe(false);
    expect(hasUpdateMark(null, false)).toBe(false);
  });
});

describe("the runtime is a detail of the app", () => {
  it("names a missing runtime and offers Repair as the row's one action", () => {
    const html = render({ phase: "available", target: "1.1.5" }, { version: null, broken: true }, { label: "Repair", run: () => {} });
    expect(html).toContain("The runtime is missing.");
    expect(html).toContain("Repair");
    // The update action gives way to the repair.
    expect(html).not.toContain("Update and restart");
    expect(html).not.toContain("Update available");
  });

  it("does not show Repair while the runtime works", () => {
    const html = render({ phase: "current" }, runtime, { label: "Repair", run: () => {} });
    expect(html).not.toContain(">Repair<");
  });
});

describe("the test-build words exist in every language", () => {
  const cases = [
    ["ja", "テストビルド", "安定版 1.0.23", "更新があります"],
    ["zh-Hans", "测试版", "正式版 1.0.23", "有可用更新"],
    ["zh-Hant", "測試版", "正式版 1.0.23", "有可用更新"],
  ] as const;
  for (const [locale, state, older, tag] of cases) {
    it(locale, () => {
      const html = renderToStaticMarkup(<UpdatePreview locale={locale} live={live({ phase: "available", target: "1.0.23", downgrade: true })} runtime={runtime} />);
      expect(html).toContain(state);
      expect(html).toContain(older);
      expect(html).not.toContain(tag);
      expect(html.split('aria-label="Jouzu Desktop"').length - 1).toBe(1);
    });
  }
});