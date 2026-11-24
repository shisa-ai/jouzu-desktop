import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./chat-markdown";
import { ApiProvider } from "./api/context";
import type { JouzuApi } from "./api/jouzu-api";

const client = (native: boolean) => ({ capabilities: { native } }) as unknown as JouzuApi;
const render = (text: string, native: boolean) =>
  renderToStaticMarkup(<ApiProvider api={client(native)}><ChatMarkdown text={text} /></ApiProvider>);
/** The first anchor in the transcript, which is the link under test. */
const anchor = (html: string) => /<a [^>]*>[\s\S]*?<\/a>/u.exec(html)?.[0] ?? "";

describe("a link in the transcript (#201)", () => {
  it("a browser client opens it in a new tab, with no native call in the way", () => {
    const link = anchor(render("see [the docs](https://example.com/a?b=1)", false));
    expect(link).toContain('href="https://example.com/a?b=1"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
  });

  it("the desktop shell keeps the link for its own validated command", () => {
    const link = anchor(render("see [the docs](https://example.com/a)", true));
    expect(link).toContain('href="https://example.com/a"');
    // The shell's window never navigates: its command opens the link outside.
    expect(link).not.toContain("target=");
  });

  it("leaves a link with credentials or another scheme inert", () => {
    const html = render("[x](https://user:pass@example.com/) and [y](mailto:a@b.c)", false);
    expect(html).toContain("x");
    expect(html).not.toContain("href=");
  });
});
