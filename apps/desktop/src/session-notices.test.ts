import { describe, expect, it } from "vitest";
import { classifyNotice, withoutCommandAdvice } from "./session-notices";

describe("classifyNotice", () => {
  it("reads TextGuard mode replies", () => {
    expect(classifyNotice("TextGuard now withholds every flagged input until you approve it with /textguard.")).toMatchObject({ kind: "textguard-mode", mode: "strict" });
    expect(classifyNotice("TextGuard is off for this session. Content is admitted unscanned until you run /textguard on.")).toMatchObject({ kind: "textguard-mode", mode: "off" });
    expect(classifyNotice("TextGuard scans again. Flagged web results reach the model labelled as untrusted data.")).toMatchObject({ kind: "textguard-mode", mode: "on" });
    expect(classifyNotice("TextGuard is already set to strict.")).toMatchObject({ kind: "textguard-mode", mode: "strict" });
  });

  it("turns withheld content into an alert without terminal advice", () => {
    const notice = classifyNotice("TextGuard withheld web_fetch https://x: prompt injection. Approve it with /textguard in an interactive session.", "warning");
    expect(notice).toEqual({ kind: "textguard-alert", text: "TextGuard withheld web_fetch https://x: prompt injection.", withheld: true });
  });

  it("recognises a Flow hold and strips /flow advice", () => {
    expect(classifyNotice("Flow control is holding your message: budget exhausted. Run /flow for the control that releases it.")).toEqual({ kind: "flow-hold", text: "Flow control is holding your message: budget exhausted.", paused: false });
    expect(classifyNotice("Flow control paused after an admission failure. Pending work is held. Run /flow for details, /flow clear to release the hold, or /flow reset to reset delivery.")).toMatchObject({ kind: "flow-hold", paused: true, text: "Flow control paused after an admission failure. Pending work is held." });
  });

  it("does not read a pause that the next message resumes as a hold (#151)", () => {
    expect(classifyNotice("Flow control paused after provider request failed: 401 Unauthorized. Automated work resumes on your next message. Run /flow for details.")).toEqual({ kind: "flow-paused", text: "Flow control paused after provider request failed: 401 Unauthorized. Automated work resumes on your next message." });
    expect(classifyNotice("Flow control paused after an interrupt. Automated work resumes on your next message. Run /flow for details.")).toMatchObject({ kind: "flow-paused" });
    expect(classifyNotice("Flow control is paused after reopening this session. Inspect with /flow; resume automation with /flow resume or your next message.")).toMatchObject({ kind: "flow-paused" });
    // Held work still needs a control.
    expect(classifyNotice("Flow control paused after an admission failure. Pending work is held. Run /flow for details, /flow clear to release the hold, or /flow reset to reset delivery.")).toMatchObject({ kind: "flow-hold" });
    expect(classifyNotice("Flow control is holding automated work: recovery needs a decision. Run /flow for the control that releases it.")).toMatchObject({ kind: "flow-hold" });
  });

  it("keeps command replies as toasts", () => {
    expect(classifyNotice("Flow clear completed. No active reservation was found; continue with a new message.")).toMatchObject({ kind: "toast", level: "info" });
    expect(classifyNotice("Automated turns are not paused for this session.")).toMatchObject({ kind: "toast" });
    expect(classifyNotice("Flow clear needs an idle session. Interrupt the running turn, then run /flow clear again.", "error")).toMatchObject({ kind: "toast", level: "error" });
  });

  it("strips clause-style advice", () => {
    expect(withoutCommandAdvice("TextGuard flagged a page; /textguard reports shows the report. The content reached the model.", "textguard")).toBe("TextGuard flagged a page. The content reached the model.");
  });
});
