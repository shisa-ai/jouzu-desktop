/**
 * Every session-level notice, in one list, in the order a person should act on
 * them. The chat shows this list in one place (above the composer) and in one
 * form: a sentence, the actions that fix it, "Details" with the raw text, and
 * dismiss where dismissing is safe. Nothing else in a session shows errors.
 */
import { CAPACITY_MESSAGE, explainError, isCapacityError, isFlowHistoryError, isImageRefused } from "./runtime-errors";

export type AlertLevel = "error" | "warning" | "info";
export interface AlertAction { label: string; run: () => void; title?: string; disabled?: boolean }
export interface SessionAlert {
  id: string;
  level: AlertLevel;
  text: string;
  details?: string;
  actions: AlertAction[];
  dismiss?: () => void;
  label?: string;
}

/** A note from something the user just did (a failed command, a refused send). */
export interface ActionNote {
  id: number;
  level: AlertLevel;
  text: string;
  details?: string;
  action?: { label: string; run: () => void };
  /** What clears it on its own: "model" once a model is chosen, "turn" when the next turn starts. */
  until?: "model" | "turn";
}

export interface SessionAlertInputs {
  /** The session lost its connection (the host's reason, if any). */
  offline?: string | null;
  /** The session could not be opened. */
  openError?: string | null;
  /** An error the runtime or host reported for this session. */
  runtimeError?: string | null;
  historyError?: string | null;
  imageRefused?: boolean;
  /** The last reply ended with a model error (only while nothing runs). */
  replyError?: string | null;
  failedSends?: readonly { clientMessageId: string; text: string; error?: string }[];
  failedTurn?: { text: string } | null;
  flowHold?: { text: string; paused: boolean } | null;
  textguard?: { alert: string; canTurnOff: boolean } | null;
  attachmentError?: string | null;
  note?: ActionNote | null;
  /** A runtime command's reply (shown until the next turn). */
  notice?: { id: number; text: string; level: AlertLevel } | null;
  busy?: boolean;
}

export interface SessionAlertHandlers {
  retryOpen?: () => void;
  newSession: () => void;
  clearFlowHistory: () => void;
  removeRefusedImage: () => void;
  retryHistory: () => void;
  retrySend: (clientMessageId: string) => void;
  discardSend: (clientMessageId: string) => void;
  retryTurn: () => void;
  flowResume: () => void;
  flowRelease: () => void;
  flowOff: () => void;
  dismissFlowHold: () => void;
  textguardOff: () => void;
  dismissTextGuard: () => void;
  dismissRuntimeError: () => void;
  dismissReplyError: () => void;
  dismissAttachmentError: () => void;
  dismissNote: () => void;
  dismissNotice: () => void;
}

const quote = (text: string) => `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`;

export function sessionAlerts(input: SessionAlertInputs, on: SessionAlertHandlers): SessionAlert[] {
  const alerts: SessionAlert[] = [];
  const busy = !!input.busy;
  const errors = [input.openError, input.runtimeError, input.replyError].filter((value): value is string => !!value);
  // Failures that block every message come first, once, whatever reported them.
  const capacity = errors.find(isCapacityError);
  const flowFull = errors.find(isFlowHistoryError);
  const refused = input.imageRefused || errors.some(isImageRefused);
  const special = (value: string | null | undefined) => !!value && (isCapacityError(value) || isFlowHistoryError(value) || isImageRefused(value));
  if (input.offline !== undefined && input.offline !== null) {
    alerts.push({ id: "offline", level: "warning", text: "Lost the connection to this session.", details: input.offline || undefined, actions: [] });
  }
  if (input.openError && !special(input.openError)) {
    const { text, details } = explainError(input.openError, "This session could not be opened.");
    alerts.push({ id: "open", level: "error", text, details, actions: [...(on.retryOpen ? [{ label: "Retry", run: on.retryOpen }] : []), { label: "New session", run: on.newSession }] });
  }
  if (capacity) alerts.push({ id: "capacity", level: "error", text: CAPACITY_MESSAGE, details: capacity, actions: [{ label: "New session", run: on.newSession }] });
  if (flowFull) alerts.push({ id: "flow-history", level: "error", text: "Flow request history is full. Clear it before sending again.", details: flowFull, actions: [{ label: "Clear Flow history", run: on.clearFlowHistory, disabled: busy }] });
  if (refused) {
    alerts.push({
      id: "image",
      level: "error",
      text: "This session contains an image the model refuses, so every request fails. Removing it keeps the rest of the conversation.",
      details: errors.find(isImageRefused),
      actions: [{ label: "Remove the image", run: on.removeRefusedImage, disabled: busy }],
    });
  }
  if (input.historyError) {
    alerts.push({ id: "history", level: "error", text: "This session is connected, but its conversation could not be loaded.", details: input.historyError, actions: [{ label: "Retry", run: on.retryHistory }] });
  }
  for (const item of input.failedSends ?? []) {
    const { text, details } = explainError(item.error ?? "", "Your message was not sent.");
    alerts.push({
      id: `send:${item.clientMessageId}`,
      level: "error",
      text: text === "Your message was not sent." ? `Not sent: ${quote(item.text)}` : `Not sent: ${quote(item.text)}. ${text}`,
      details,
      actions: [{ label: "Retry", run: () => on.retrySend(item.clientMessageId) }, { label: "Discard", run: () => on.discardSend(item.clientMessageId) }],
    });
  }
  if (input.failedTurn) {
    alerts.push({
      id: "failed-turn",
      level: "error",
      text: `This message did not get a reply${input.failedTurn.text ? `: ${quote(input.failedTurn.text)}` : "."}`,
      actions: [{ label: "Retry", run: on.retryTurn }],
    });
  }
  if (input.replyError && !special(input.replyError)) {
    alerts.push({ id: "reply", level: "error", text: "The last reply stopped because the model returned an error.", details: input.replyError, actions: [], dismiss: on.dismissReplyError });
  }
  if (input.runtimeError && !special(input.runtimeError) && input.runtimeError !== input.replyError) {
    const { text, details } = explainError(input.runtimeError, "Something in this session failed.");
    alerts.push({ id: "runtime", level: "error", text, details, actions: [], dismiss: on.dismissRuntimeError });
  }
  if (input.flowHold) {
    alerts.push({
      id: "flow-hold",
      label: "Flow control",
      level: "warning",
      text: input.flowHold.text,
      actions: [
        ...(input.flowHold.paused ? [{ label: "Resume", run: on.flowResume, disabled: busy }] : []),
        { label: "Release", run: on.flowRelease, disabled: busy },
        { label: "Turn off Flow", run: on.flowOff, disabled: busy, title: "Turn Flow control off for this session; held messages run normally" },
      ],
      dismiss: on.dismissFlowHold,
    });
  }
  if (input.textguard) {
    alerts.push({
      id: "textguard",
      label: "TextGuard",
      level: "error",
      text: input.textguard.alert,
      actions: input.textguard.canTurnOff ? [{ label: "Turn off TextGuard", run: on.textguardOff, disabled: busy, title: "Admit content unscanned for this session, then retry" }] : [],
      dismiss: on.dismissTextGuard,
    });
  }
  if (input.attachmentError) {
    alerts.push({ id: "attachment", level: "error", text: input.attachmentError, actions: [], dismiss: on.dismissAttachmentError });
  }
  if (input.note) {
    alerts.push({ id: `note:${input.note.id}`, level: input.note.level, text: input.note.text, details: input.note.details, actions: input.note.action ? [input.note.action] : [], dismiss: on.dismissNote });
  }
  if (input.notice) {
    alerts.push({ id: `notice:${input.notice.id}`, level: input.notice.level, text: input.notice.text, actions: [], dismiss: on.dismissNotice });
  }
  return alerts;
}
