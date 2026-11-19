import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { classifyImageSource, HostAttachmentImage, ImageFallbackCard, MessageImage, requestHostAttachment, resolveWorkspacePath } from "./message-image";
import { ApiProvider } from "./api/context";
import type { JouzuApi } from "./api/jouzu-api";

describe("image source classification", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(resolveWorkspacePath("C:/work", "prusalicer-shots/09.png")).toEqual({ absolute: "C:/work/prusalicer-shots/09.png", inside: true });
    expect(classifyImageSource("prusalicer-shots/09.png", { kind: "markdown", workspace: "C:/work" })).toMatchObject({ type: "local", name: "09.png" });
  });

  it("refuses a parent escape before any native read", () => {
    expect(resolveWorkspacePath("C:/work", "../../outside.png").inside).toBe(false);
    expect(classifyImageSource("../../outside.png", { kind: "markdown", workspace: "C:/work" })).toMatchObject({
      type: "card",
      reason: "outside-workspace",
      name: "outside.png",
    });
  });

  it("folds Windows separators and drive-letter case", () => {
    expect(classifyImageSource("C:\\WORK\\shots\\a.png", { kind: "markdown", workspace: "c:\\work" })).toMatchObject({ type: "local" });
    expect(classifyImageSource("D:/shots/a.png", { kind: "markdown", workspace: "C:/work" })).toMatchObject({ type: "card", reason: "outside-workspace" });
  });

  it("keeps http(s) remote without a path read", () => {
    expect(classifyImageSource("https://example.com/x.png", { kind: "markdown", workspace: "C:/work" })).toEqual({
      type: "remote",
      url: "https://example.com/x.png",
      host: "example.com",
      openable: true,
    });
  });

  it("does not offer Open for a remote URL with credentials", () => {
    expect(classifyImageSource("https://user:pass@example.com/x.png", { kind: "markdown", workspace: "C:/work" })).toMatchObject({
      type: "remote",
      host: "example.com",
      openable: false,
    });
  });

  it("does not resolve a local path without a workspace", () => {
    expect(classifyImageSource("shots/a.png", { kind: "markdown" })).toMatchObject({ type: "card", reason: "workspace-unavailable" });
  });
});

describe("transcript image rendering", () => {
  it("renders a data URL inline with the alt as caption, never the old placeholder", () => {
    const html = renderToStaticMarkup(<MessageImage kind="markdown" source="data:image/png;base64,QUJD" alt="Custom G-code page" />);
    expect(html).toContain("<img");
    expect(html).toContain('alt="Custom G-code page"');
    expect(html).toContain("Custom G-code page</figcaption>");
    expect(html).not.toContain("[Image:");
  });

  it("renders an outside-workspace card with the path, Reveal and Copy path", () => {
    const html = renderToStaticMarkup(<MessageImage kind="markdown" source="C:/other/outside.png" alt="diagram" workspace="C:/work" />);
    expect(html).toContain("Outside the workspace");
    expect(html).toContain("outside.png");
    expect(html).toContain("C:/other/outside.png");
    expect(html).toContain("Reveal");
    expect(html).toContain("Copy path");
    expect(html).not.toContain("<img");
  });

  it("renders an oversized tool block as a card with its size", () => {
    const html = renderToStaticMarkup(<MessageImage kind="tool" source="data:image/png;base64,QUJD" bytes={9 * 1024 * 1024} alt="Screenshot" path="C:/work/shots/big.png" />);
    expect(html).toContain("Too large to show");
    expect(html).toContain("9.0 MB");
    expect(html).toContain("C:/work/shots/big.png");
    expect(html).not.toContain("<img");
  });

  it("renders an unsupported data type as a card with the MIME type", () => {
    const html = renderToStaticMarkup(<MessageImage kind="markdown" source="data:image/svg+xml;base64,QUJD" alt="logo" />);
    expect(html).toContain("Preview not supported");
    expect(html).toContain("image/svg+xml");
    expect(html).not.toContain("<img");
  });

  it("renders a remote card with host and Open, and never an image element", () => {
    const html = renderToStaticMarkup(<MessageImage kind="markdown" source="https://example.com/x.png" alt="architecture diagram" />);
    expect(html).toContain("example.com");
    expect(html).toContain("architecture diagram");
    expect(html).toContain("Open");
    expect(html).not.toContain("<img");
  });

  it("renders a message block through the same inline surface", () => {
    const html = renderToStaticMarkup(<MessageImage kind="block" source="data:image/jpeg;base64,QUJD" alt="Conversation attachment" />);
    expect(html).toContain("<img");
    expect(html).toContain("data:image/jpeg;base64,QUJD");
  });

  it("renders each failure reason from the native contract", () => {
    const cases = [
      ["outside-workspace", "Outside the workspace"],
      ["not-found", "File not found"],
      ["too-large", "Too large to show"],
      ["not-an-image", "Preview not supported"],
      ["unreadable", "Unreadable"],
      ["not-a-file", "Not a file"],
    ] as const;
    for (const [reason, text] of cases) {
      const html = renderToStaticMarkup(<ImageFallbackCard reason={reason} name="shot.png" path="C:/work/shot.png" bytes={reason === "too-large" ? 12 * 1024 * 1024 : undefined} />);
      expect(html).toContain(text);
      expect(html).toContain("Reveal");
      expect(html).toContain("Copy path");
    }
  });
});

describe("images the host keeps for a message (#119)", () => {
  const apiWith = (attachment: (sessionId: string, id: string) => Promise<{ mimeType: string; data: string }>) =>
    ({ sessions: { attachment } }) as unknown as JouzuApi;

  it("reads each image from the host once, by session and id", async () => {
    const calls: string[] = [];
    const api = apiWith(async (sessionId, id) => { calls.push(`${sessionId}/${id}`); return { mimeType: "image/png", data: "AAEC" }; });
    const ref = { sessionId: "s-1", id: "att-1" };
    const [first, second] = await Promise.all([requestHostAttachment(api, ref), requestHostAttachment(api, ref)]);
    expect(first).toEqual({ mimeType: "image/png", data: "AAEC" });
    expect(second).toBe(first);
    await requestHostAttachment(api, ref);
    expect(calls).toEqual(["s-1/att-1"]);
  });

  it("does not keep a failed read, so the next showing tries again", async () => {
    let fail = true;
    const api = apiWith(async () => { if (fail) throw new Error("offline"); return { mimeType: "image/png", data: "AAEC" }; });
    const ref = { sessionId: "s-1", id: "att-retry" };
    await expect(requestHostAttachment(api, ref)).rejects.toThrow("offline");
    fail = false;
    await expect(requestHostAttachment(api, ref)).resolves.toEqual({ mimeType: "image/png", data: "AAEC" });
  });

  it("shows a read image at once and a loading line before that", async () => {
    const api = apiWith(async () => ({ mimeType: "image/png", data: "AAEC" }));
    const loading = renderToStaticMarkup(<ApiProvider api={api}><HostAttachmentImage attachment={{ sessionId: "s-2", id: "att-2" }} alt="Conversation attachment" /></ApiProvider>);
    expect(loading).toContain("Loading image");
    await requestHostAttachment(api, { sessionId: "s-2", id: "att-2" });
    const shown = renderToStaticMarkup(<ApiProvider api={api}><HostAttachmentImage attachment={{ sessionId: "s-2", id: "att-2" }} alt="Conversation attachment" /></ApiProvider>);
    expect(shown).toContain('src="data:image/png;base64,AAEC"');
  });
});
