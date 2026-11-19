/**
 * The host's own part of a reply, read from host.log after a playbook run: from
 * `message.accepted` (the `turn.start` timing line of the same message) to the
 * runtime asking the model (`step.start`, step 1). This is the app's work before
 * the provider is involved. The playbook stays black-box; the stable exam and the
 * report both read the log afterwards through this module, so they agree (#129).
 *
 * Limit 200 ms for the median of first turns in new sessions, slowest <= 400 ms:
 * a later turn in the same session does the same work in about 40 ms on Windows,
 * so a first turn has no reason to be slower once its runtime is attached before
 * the send (#117).
 */
export const HOST_GATE_LIMIT_MS = 200;

/** Turns in `text` (host.log contents) between `from` and `to` (ms since epoch). */
export function hostTiming(text, { from = 0, to = Number.POSITIVE_INFINITY } = {}) {
  const turns = new Map();
  const seenSessions = new Set();
  for (const line of text.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.event !== "timing") continue;
    const at = Date.parse(entry.ts), f = entry.fields ?? {};
    if (!(at >= from && at <= to) || !f.clientMessageId) continue;
    if (f.mark === "turn.start" && !turns.has(f.clientMessageId)) {
      turns.set(f.clientMessageId, { session: f.session, accepted: at, first: !seenSessions.has(f.session) });
      seenSessions.add(f.session);
    }
    const turn = turns.get(f.clientMessageId);
    if (f.mark === "step.start" && turn && turn.modelAsked == null) turn.modelAsked = at - turn.accepted;
  }
  const pick = first => [...turns.values()].filter(t => t.first === first && t.modelAsked != null).map(t => t.modelAsked).sort((a, b) => a - b);
  const stat = list => list.length ? { median: list[Math.floor((list.length - 1) / 2)], slowest: list[list.length - 1], samples: list } : null;
  return { first: stat(pick(true)), later: stat(pick(false)) };
}

/** The gate: a problem in words, or null when it passes. No first turn is a problem too. */
export function hostGateProblem(timing, limit = HOST_GATE_LIMIT_MS) {
  const first = timing?.first;
  if (!first) return "gate sendToModelRequest: no first turn found in host.log";
  if (first.median > limit) return `gate sendToModelRequest: median ${first.median} > ${limit}`;
  if (first.slowest > limit * 2) return `gate sendToModelRequest: slowest ${first.slowest} > ${limit * 2}`;
  return null;
}

/**
 * Run ownership, read from host.log after the run scenarios: the host never had
 * two runs at once (`run.overlap`), and the runtime refused nothing the host
 * sent (`runtime.response_failed`), except the one refusal the design expects:
 * a prompt that lost the race to a run the runtime started, which is then
 * steered ("Agent is already processing"). With `expectSteer`, at least one
 * message must have been handed to a running reply (`queue.steer_sent`).
 * Returns problems in words.
 */
export function runLogProblems(text, { from = 0, to = Number.POSITIVE_INFINITY, expectSteer = false } = {}) {
  const problems = [];
  let steered = 0;
  for (const line of text.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.ts);
    if (!(at >= from && at <= to)) continue;
    const f = entry.fields ?? {};
    if (entry.event === "queue.steer_sent") steered += 1;
    if (entry.event === "run.overlap") problems.push(`run.overlap at ${entry.ts}`);
    if (entry.event === "runtime.response_failed" && !(f.command === "prompt" && /already processing/i.test(String(f.message)))) {
      problems.push(`runtime.response_failed (${f.command}): ${String(f.message).slice(0, 120)}`);
    }
  }
  // A message sent during a reply must reach it as a steer, not wait for the reply's end.
  if (expectSteer && steered === 0) problems.push("no queue.steer_sent: nothing sent during a reply was handed to it");
  return problems;
}
