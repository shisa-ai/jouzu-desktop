import workspaceSource from "./chat-workspace.tsx?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./composer";
import { AgentAction } from "./chat-live";
import { SessionStatsBar } from "./session-stats-bar";
import { ErrorLine } from "./session-alerts-view";
import { ChatConversation } from "./chat-conversation";
import { emptyProjection, type ChatMessage } from "./chat-projection";
import { ResultMark } from "./control-result";
import { ChatTextProvider, chatTexts, explain, failureText } from "./chat-text";
import { ApiError } from "./api/jouzu-api";

const noop = () => {};
const composer = (extra: Partial<Parameters<typeof Composer>[0]> = {}) => renderToStaticMarkup(<Composer connected pending={false} running={false} draft="" onDraft={noop} onSend={noop} onStop={noop} models={[]} modelState="ready" onSelectModel={noop} thinkingLevels={[]} onThinkingLevel={noop} {...extra} />);

describe("words for errors, in every interface language", () => {
  it("every language has every sentence", () => {
    const keys = Object.keys(chatTexts.en).sort();
    for (const [locale, texts] of Object.entries(chatTexts)) {
      expect(Object.keys(texts).sort(), locale).toEqual(keys);
      for (const key of keys) expect((texts as Record<string, string>)[key], `${locale}.${key}`).toMatch(/\S/u);
    }
  });

  it("localizes from the host's code and keeps the original text for Details only", () => {
    const ja = chatTexts.ja;
    const refused = explain(ja, new ApiError("no-model" as never, "Session has no model", false, 409), ja.modelFailed);
    expect(refused).toEqual({ text: ja.codeNoModel, details: "Session has no model" });
    // An unknown failure says what did not happen, in the interface language.
    expect(explain(ja, new Error("socket hang up"), ja.exportFailed)).toEqual({ text: ja.exportFailed, details: "socket hang up" });
    expect(failureText(ja, "runtime-crashed")).toBe(ja.failureRuntimeCrashed);
    expect(failureText(ja, "something-new")).toBe(ja.failureDefault);
  });
});

describe("the session's one error takes the composer's place", () => {
  it("shows why and the one action that recovers, and no composer", () => {
    const html = composer({ blocked: { text: "This session's runtime stopped and could not recover.", details: "runtime exited", action: { label: "Restart session", run: noop } } });
    expect(html).toContain("data-session-blocked");
    expect(html).toContain("Restart session");
    // The composer is kept only for its size, hidden and out of reach (#156).
    expect(html).toMatch(/<form[^>]*aria-hidden="true"[^>]*inert=""[^>]*class="[^"]*\binvisible\b/u);
    // The original text waits behind Details.
    expect(html).not.toContain("runtime exited");
  });

  it("a restart that failed says so beside its button", () => {
    const html = composer({ blocked: { text: "x", action: { label: "Restart session", run: noop }, result: { ok: false, text: "This session could not be opened." } } });
    expect(html).toContain('aria-label="This session could not be opened."');
  });

  it("an image that could not be attached is marked at the + menu, not written into the composer", () => {
    const html = composer({ results: { attach: { ok: false, text: "The images were not attached.", details: "too large" } } });
    expect(html).toContain('aria-label="The images were not attached."');
    expect(html).not.toContain("too large");
    expect(html).not.toContain('<p role="alert"');
  });

  it("is otherwise the composer, with results at their controls only", () => {
    const html = composer({ results: { model: { ok: false, text: "The model was not changed." } } });
    expect(html).toContain("<textarea");
    expect(html).toContain('data-result="failed"');
    expect(html).toContain('aria-label="The model was not changed."');
  });
});

describe("a failure is shown on the thing that failed", () => {
  it("a message that got no reply says so on one line with Retry, in the interface language", () => {
    const html = renderToStaticMarkup(<ChatTextProvider value={chatTexts["zh-Hans"]}><AgentAction thinking="" label="" running={false} noReply={{ text: "hello", details: "Request history is full", onRetry: noop }} /></ChatTextProvider>);
    expect(html).toContain(chatTexts["zh-Hans"].noReply);
    expect(html).toContain(chatTexts["zh-Hans"].retry);
    expect(html).not.toContain("Request history is full");
  });

  const failedReply = (code: string, running = false, extra: ChatMessage[] = []) => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }], turn: 1 },
      { role: "assistant", content: [], turn: 1, stopReason: "error", errorMessage: "401 Unauthorized: raw provider words", errorCode: code },
      ...extra,
    ];
    return renderToStaticMarkup(<ChatTextProvider value={chatTexts.ja}><ChatConversation projection={{ ...emptyProjection(), messages, running }} replyAction={{ label: chatTexts.ja.signIn, run: noop }} /></ChatTextProvider>);
  };

  it("a failed reply says once, on the reply, why it failed and what recovers it (#151, #152)", () => {
    const html = failedReply("auth");
    expect(html.match(/data-reply-failed/gu)).toHaveLength(1);
    expect(html).toContain(chatTexts.ja.replyAuth);
    expect(html).toContain(`>${chatTexts.ja.signIn}</button>`);
    // The provider's own words are behind Details only.
    expect(html).not.toContain("raw provider words");
  });

  it("a request the runtime is still retrying is not shown as a failed reply", () => {
    expect(failedReply("rate-limit", true)).not.toContain("data-reply-failed");
  });

  it("only the latest failed reply offers its recovery", () => {
    const html = failedReply("auth", false, [{ role: "user", content: [{ type: "text", text: "again" }], turn: 2 }, { role: "assistant", content: [{ type: "text", text: "ok" }], turn: 2, stopReason: "stop" }]);
    expect(html.match(/data-reply-failed/gu)).toHaveLength(1);
    expect(html).not.toContain(`>${chatTexts.ja.signIn}</button>`);
  });

  it("a session that cannot go on shows that one cause, not also its message's No reply", () => {
    expect(workspaceSource).toMatch(/const noReply = failedTurn && [^?]*!blocked \?/u);
  });

  it("the status line never shows a failed reply a second time", () => {
    expect(workspaceSource).not.toMatch(/settled=\{[^}]*failed/u);
  });

  it("an error line says what its code means, never guessing a refused image from its words (#157)", () => {
    const html = renderToStaticMarkup(<ChatTextProvider value={chatTexts.ja}><ErrorLine raw={new ApiError("tools-unavailable" as never, "The image tool is not installed yet", true, 503)} failed={chatTexts.ja.toolsChangeFailed} /></ChatTextProvider>);
    expect(html).toContain(chatTexts.ja.codeToolsUnavailable);
    expect(html).not.toContain(chatTexts.ja.replyImage);
    expect(html).not.toContain("rejected a request because of an image");
  });

  it("the runtime's notice is one line, never a list", () => {
    const html = renderToStaticMarkup(<AgentAction thinking="" label="" running={false} notice={{ text: "flow guard crashed", level: "error", extension: true, onDismiss: noop }} />);
    // Said in the interface language; the extension's own words are behind Details.
    expect(html).toContain(chatTexts.en.extensionFailed);
    expect(html).not.toContain("flow guard crashed");
    expect(html.match(/data-runtime-notice/gu)).toHaveLength(1);
  });

  it("a result at a control is a badge that takes no room, whose words are its label", () => {
    const html = renderToStaticMarkup(<ResultMark result={{ ok: true, text: "Conversation exported." }} />);
    expect(html).toContain('data-result="ok"');
    expect(html).toMatch(/data-result-anchor="true" class="[^"]*\bh-0 w-0\b/u);
    expect(html).toMatch(/data-result="ok"[^>]*class="absolute /u);
  });

  it("the usage row under the composer keeps its height with or without numbers (#153)", () => {
    const empty = renderToStaticMarkup(<SessionStatsBar />);
    const full = renderToStaticMarkup(<SessionStatsBar stats={{ tokens: { total: 10, input: 10 }, contextUsage: { percent: 42 } } as never} />);
    expect(empty).toContain("h-8");
    expect(full).toContain("min-h-8");
  });

  it("an idle status line keeps its row, so a failure appearing moves nothing", () => {
    const idle = renderToStaticMarkup(<AgentAction thinking="" label="" running={false} />);
    const stopped = renderToStaticMarkup(<AgentAction thinking="" label="" running={false} settled="interrupted" />);
    expect(idle).toContain("h-8");
    expect(stopped).toContain("h-8");
  });

  it("a message that got no reply offers Retry beside the recovery its text points to", () => {
    const html = renderToStaticMarkup(<AgentAction thinking="" label="" running={false} noReply={{ text: "hi", onRetry: noop, action: { label: "Clear Flow history", run: noop } }} />);
    expect(html).toContain("Clear Flow history");
    expect(html).toContain(">Retry<");
  });

  it("a Flow hold is on the status line with what lets it go", () => {
    const html = renderToStaticMarkup(<AgentAction thinking="" label="" running={false} hold={{ details: "budget", paused: true, onResume: noop, onRelease: noop, onOff: noop }} />);
    expect(html).toContain(chatTexts.en.flowHolding);
    expect(html).toContain(">Resume<");
    expect(html).toContain(">Release<");
    expect(html).not.toContain("budget");
  });
});

describe("no list of notices above the composer", () => {
  it("the chat builds no aggregated notice list and parses no host error events", () => {
    expect(workspaceSource).not.toMatch(/sessionAlerts\(|SessionAlerts|snapshot\.error\b/u);
  });
  it("the chat layout is never a scroll container (#113)", () => {
    expect(workspaceSource).toMatch(/ref=\{chatRoot\} className="[^"]*\boverflow-clip\b/u);
  });
});
