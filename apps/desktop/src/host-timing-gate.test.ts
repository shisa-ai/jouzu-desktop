import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script shared with the playbook report and the stable exam
import { hostGateProblem, hostTiming, runLogProblems } from "../e2e/host-timing.mjs";

const line = (ms: number, mark: string, session: string, id: string) =>
  JSON.stringify({ event: "timing", ts: new Date(Date.UTC(2026, 10, 16, 0, 0, 0, ms)).toISOString(), fields: { mark, session, clientMessageId: id } });

/** One session per entry: [first turn ms, later turn ms]. */
function log(sessions: Array<[number, number]>) {
  const lines: string[] = [];
  let t = 0;
  sessions.forEach(([first, later], index) => {
    const s = `s-${index}`;
    lines.push(line(t, "message.accepted", s, `${s}-a`), line(t, "turn.start", s, `${s}-a`), line(t + first, "step.start", s, `${s}-a`));
    t += 5_000;
    lines.push(line(t, "turn.start", s, `${s}-b`), line(t + later, "step.start", s, `${s}-b`));
    t += 5_000;
  });
  lines.push("not json", JSON.stringify({ event: "runtime.warm", ts: new Date().toISOString(), fields: {} }));
  return lines.join("\n");
}

describe("host timing gate (#129)", () => {
  it("separates first turns from later ones and passes fast first turns", () => {
    const timing = hostTiming(log([[40, 30], [60, 35], [50, 40]]));
    expect(timing.first).toEqual({ median: 50, slowest: 60, samples: [40, 50, 60] });
    expect(timing.later.median).toBe(35);
    expect(hostGateProblem(timing)).toBeNull();
  });

  it("fails a slow median", () => {
    expect(hostGateProblem(hostTiming(log([[600, 30], [550, 30], [700, 30]])))).toMatch(/median 600 > 200/);
  });

  it("fails one very slow first turn even with a good median", () => {
    expect(hostGateProblem(hostTiming(log([[40, 30], [50, 30], [900, 30]])))).toMatch(/slowest 900 > 400/);
  });

  it("fails when the log has no first turn, so the gate never passes silently", () => {
    expect(hostGateProblem(hostTiming(""))).toMatch(/no first turn/);
  });

  it("only counts turns inside the run's window", () => {
    const text = log([[600, 30], [40, 30]]);
    const from = Date.UTC(2026, 10, 16, 0, 0, 10);
    expect(hostTiming(text, { from }).first.samples).toEqual([40]);
  });
});

describe("run ownership in host.log", () => {
  const entry = (event: string, fields: object, ms = 0) => JSON.stringify({ event, ts: new Date(Date.UTC(2026, 10, 16, 0, 0, 0, ms)).toISOString(), fields });
  it("passes the expected refusal of a prompt that lost to a runtime run", () => {
    expect(runLogProblems(entry("runtime.response_failed", { command: "prompt", message: "Agent is already processing. Specify streamingBehavior" }))).toEqual([]);
  });
  it("reports an overlap and any other refusal, inside the window only", () => {
    const text = [entry("run.overlap", {}, 10), entry("runtime.response_failed", { command: "steer", message: "boom" }, 20), entry("run.overlap", {}, 5_000)].join("\n");
    const window = { from: Date.UTC(2026, 10, 16), to: Date.UTC(2026, 10, 16) + 1_000 };
    expect(runLogProblems(text, window)).toHaveLength(2);
  });
  it("asks for a steer when one is expected", () => {
    expect(runLogProblems("", { expectSteer: true })).toHaveLength(1);
    expect(runLogProblems(entry("queue.steer_sent", {}), { expectSteer: true })).toEqual([]);
  });
});
