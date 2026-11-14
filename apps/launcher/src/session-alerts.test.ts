import { describe, expect, it, vi } from "vitest";
import { sessionAlerts, type SessionAlertHandlers } from "./session-alerts";
import { explainError } from "./runtime-errors";
import { ApiError } from "./api/jouzu-api";

const handlers = (): SessionAlertHandlers => ({
  newSession: vi.fn(), clearFlowHistory: vi.fn(), removeRefusedImage: vi.fn(), retryHistory: vi.fn(),
  retrySend: vi.fn(), discardSend: vi.fn(), retryTurn: vi.fn(), flowResume: vi.fn(), flowRelease: vi.fn(),
  flowOff: vi.fn(), dismissFlowHold: vi.fn(), textguardOff: vi.fn(), dismissTextGuard: vi.fn(),
  dismissRuntimeError: vi.fn(), dismissReplyError: vi.fn(), dismissAttachmentError: vi.fn(), dismissNote: vi.fn(), dismissNotice: vi.fn(),
});

// Text a person should never read as the message itself.
const technical = /Error:|exception|stack|ECONN|status code|\{|\}|undefined|null/iu;

describe("explainError", () => {
  it("says what failed and keeps the technical text for Details", () => {
    const raw = new Error("Error: invoke export_html: EACCES: permission denied, open 'C:\\x.html'");
    const explained = explainError(raw, "Could not export the conversation.");
    expect(explained.text).toBe("Could not export the conversation.");
    expect(explained.details).toContain("EACCES");
  });

  it("uses the fixed sentence for a known host code", () => {
    expect(explainError(new ApiError("runtime-unavailable", "pool exhausted"), "Could not send.").text).toMatch(/not available/u);
  });

  it("keeps a refusal the host wrote for people", () => {
    expect(explainError(new ApiError("invalid-request", "Attach at most 4 images"), "Your message was not sent.").text)
      .toBe("Your message was not sent. Attach at most 4 images.");
  });

  it("names the recoverable runtime failures", () => {
    expect(explainError("Request history is full (62 records). Run /flow clear, then retry.", "x").text).not.toMatch(/\/flow/u);
    expect(explainError("Submission retention limit reached", "x").text).toMatch(/new session/iu);
  });
});

describe("sessionAlerts", () => {
  it("shows nothing when nothing needs attention", () => {
    expect(sessionAlerts({}, handlers())).toEqual([]);
  });

  it("shows a runtime error that used to be invisible while connected, without its raw text", () => {
    const [alert] = sessionAlerts({ runtimeError: "TypeError: Cannot read properties of undefined (reading 'x')" }, handlers());
    expect(alert.level).toBe("error");
    expect(alert.text).not.toMatch(technical);
    expect(alert.details).toContain("Cannot read properties");
    expect(alert.dismiss).toBeTypeOf("function");
  });

  it("reports one blocking failure once, whichever source reported it", () => {
    const raw = "Submission retention limit reached; admission is held.";
    const alerts = sessionAlerts({ openError: raw, runtimeError: raw, replyError: raw }, handlers());
    expect(alerts.map(alert => alert.id)).toEqual(["capacity"]);
    expect(alerts[0].actions.map(action => action.label)).toEqual(["New session"]);
  });

  it("offers the image repair when the model refuses an image", () => {
    const on = handlers();
    const alerts = sessionAlerts({ replyError: "400 image must be larger than 10x10 pixels" }, on);
    expect(alerts.map(alert => alert.id)).toEqual(["image"]);
    alerts[0].actions[0].run();
    expect(on.removeRefusedImage).toHaveBeenCalled();
  });

  it("puts a message that was not sent here, with Retry and Discard", () => {
    const on = handlers();
    const [alert] = sessionAlerts({ failedSends: [{ clientMessageId: "c-1", text: "hello", error: "Cannot reach Jouzu. Check that the app is still running." }] }, on);
    expect(alert.text).toMatch(/^Not sent: “hello”/u);
    alert.actions.find(action => action.label === "Retry")!.run();
    alert.actions.find(action => action.label === "Discard")!.run();
    expect(on.retrySend).toHaveBeenCalledWith("c-1");
    expect(on.discardSend).toHaveBeenCalledWith("c-1");
  });

  it("orders what blocks the session before what informs", () => {
    const alerts = sessionAlerts({
      notice: { id: 1, text: "MCP servers reloaded", level: "info" },
      note: { id: 2, level: "error", text: "Could not compact the conversation.", details: "boom" },
      flowHold: { text: "Flow is holding your message.", paused: true },
      offline: "",
      historyError: "500",
    }, handlers());
    expect(alerts.map(alert => alert.id)).toEqual(["offline", "history", "flow-hold", "note:2", "notice:1"]);
    expect(alerts[0].details).toBeUndefined();
  });

  it("disables commands that cannot run while the session is busy", () => {
    const [alert] = sessionAlerts({ flowHold: { text: "held", paused: false }, busy: true }, handlers());
    expect(alert.actions.every(action => action.disabled)).toBe(true);
  });
});
