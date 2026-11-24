import { describe, expect, it, vi, afterEach } from "vitest";
import { externalLinkTarget, openExternalLink } from "./external-link";
import type { JouzuApi } from "./api/jouzu-api";

const client = (native: boolean, openExternalUrl = vi.fn(async (_url: string) => undefined)) =>
  ({ capabilities: { native }, native: { openExternalUrl } }) as unknown as JouzuApi;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the link policy a transcript link passes (ADR 0005)", () => {
  it("allows ordinary http and https links, on any host", () => {
    expect(externalLinkTarget("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(externalLinkTarget("http://localhost:8100/")).toBe("http://localhost:8100/");
    expect(externalLinkTarget("http://127.0.0.1:5173/x")).toBe("http://127.0.0.1:5173/x");
  });

  it("refuses another scheme, embedded credentials and anything that is not a URL", () => {
    for (const href of ["mailto:a@b.c", "javascript:alert(1)", "file:///C:/x", "data:text/html,x", "tel:+1", "https://user:pass@example.com/", "/relative", "", undefined]) {
      expect(externalLinkTarget(href)).toBeNull();
    }
  });
});

describe("opening a link from content (#201)", () => {
  it("the desktop shell hands it to the app's validated command", async () => {
    const openExternalUrl = vi.fn(async (_url: string) => undefined);
    await openExternalLink(client(true, openExternalUrl), "https://example.com/x");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/x");
  });

  it("a browser client opens a new tab itself", async () => {
    const opened: Array<Record<string, string>> = [];
    vi.stubGlobal("document", {
      createElement: () => ({
        click() { opened.push({ href: this.href, target: this.target, rel: this.rel }); },
        href: "",
        target: "",
        rel: "",
      }),
    });
    const openExternalUrl = vi.fn(async (_url: string) => undefined);
    await openExternalLink(client(false, openExternalUrl), "https://example.com/x");
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(opened).toEqual([{ href: "https://example.com/x", target: "_blank", rel: "noopener noreferrer" }]);
  });

  it("refuses to open what the policy refuses, on either client", async () => {
    await expect(openExternalLink(client(true), "mailto:a@b.c")).rejects.toThrow();
    await expect(openExternalLink(null, "javascript:alert(1)")).rejects.toThrow();
  });
});
