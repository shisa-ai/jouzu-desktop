/**
 * Runtime notices (`session.notice`) sorted into what the UI does with them.
 *
 * The runtime has one plain-text channel for command replies and alerts. Two
 * features depend on it: TextGuard (mode replies, withheld content) and Flow
 * control (held messages, pauses). Everything else is a transient toast.
 * Their wording names terminal commands (`/flow`, `/textguard`); the UI offers
 * buttons for those instead, so that advice is removed from the text shown.
 */
export type TextGuardMode = "on" | "strict" | "off";

export type SessionNotice =
  | { kind: "textguard-mode"; mode: TextGuardMode; text: string }
  | { kind: "textguard-alert"; text: string; withheld: boolean }
  | { kind: "flow-hold"; text: string; paused: boolean }
  | { kind: "toast"; text: string; level: "info" | "warning" | "error" };

const level = (value: unknown): "info" | "warning" | "error" => value === "error" || value === "warning" ? value : "info";

/** Remove sentences and clauses that tell the user to type a slash command. */
export function withoutCommandAdvice(message: string, command: "flow" | "textguard"): string {
  const name = command === "flow" ? "flow" : "textguard";
  const sentence = new RegExp(`\\s*(?:Run|Use|Inspect with|Approve it with|Review with|Release it with|Turn it back on with)\\s+\\/${name}\\b[^.]*\\.?`, "giu");
  const clause = new RegExp(`\\s*;\\s*\\/${name}\\b[^.;]*`, "giu");
  return message.replace(sentence, "").replace(clause, "").replace(/\s{2,}/gu, " ").trim();
}

const TEXTGUARD_MODE: Array<[RegExp, TextGuardMode]> = [
  [/^TextGuard scans again\b/u, "on"],
  [/^TextGuard now withholds every flagged input\b/u, "strict"],
  [/^TextGuard is off for this session\b/u, "off"],
];

const FLOW_HOLD = /\bholding\b|\bpaused\b|needs a decision|reconciliation|withheld request/iu;

export function classifyNotice(message: string, notifyLevel?: unknown): SessionNotice {
  const text = message.trim();
  for (const [pattern, mode] of TEXTGUARD_MODE) {
    if (pattern.test(text)) return { kind: "textguard-mode", mode, text: withoutCommandAdvice(text, "textguard") };
  }
  const already = /^TextGuard is already set to (on|strict|off)\b/u.exec(text);
  if (already) return { kind: "textguard-mode", mode: already[1] as TextGuardMode, text };
  if (/^TextGuard (?:withheld|flagged)\b/u.test(text) || /^TextGuard: \d+ items?\b/u.test(text)) {
    return { kind: "textguard-alert", text: withoutCommandAdvice(text, "textguard"), withheld: !/^TextGuard flagged\b/u.test(text) };
  }
  if (/^TextGuard\b/u.test(text)) return { kind: "toast", text: withoutCommandAdvice(text, "textguard") || text, level: level(notifyLevel) };
  if (/\/flow\b/u.test(text) && FLOW_HOLD.test(text) && !/\bnot paused\b/iu.test(text)) {
    return { kind: "flow-hold", text: withoutCommandAdvice(text, "flow") || "Flow control is holding your message.", paused: /paused/iu.test(text) };
  }
  if (/\/flow\b/u.test(text)) return { kind: "toast", text: withoutCommandAdvice(text, "flow") || text, level: level(notifyLevel) };
  return { kind: "toast", text, level: level(notifyLevel) };
}
