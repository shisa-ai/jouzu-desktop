import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { hostTiming, hostGateProblem, HOST_GATE_LIMIT_MS } from "./host-timing.mjs";

/**
 * Build one report for two consumers:
 * - humans: a readable HTML dashboard;
 * - agents: the same data as stable JSON, embedded and written beside the HTML.
 */
const files = (process.env.PLAYBOOK_JSON ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (!files.length) throw new Error("set PLAYBOOK_JSON to one or more playbook JSON files");
const out = process.env.PLAYBOOK_OUT ?? "playbook-report.html";
const title = process.env.PLAYBOOK_TITLE ?? "Jouzu playbook report";
const runs = [];
for (const file of files) runs.push(JSON.parse(await readFile(file, "utf8")));

const missingBase = (process.env.PLAYBOOK_MISSING ?? [
  "coldProcessLaunch",
  "workingInteractivity",
  "stop",
  "visibleStreaming",
  "toolApprovalAttachment",
  "sessionLoad5",
  "sessionLoad10",
  "mixedClients",
  "remoteBrowser",
].join(",")).split(",").map(value => value.trim()).filter(Boolean);

const issues = JSON.parse(process.env.PLAYBOOK_ISSUES
  ? await readFile(process.env.PLAYBOOK_ISSUES, "utf8")
  : JSON.stringify([
    { id: 48, title: "Warm first readable 4.475 s exceeds 1 s", timestamp: "2026-11-12T21:50:35+09:00", class: "product/performance" },
    { id: 49, title: "New sessions missing from sidebar", timestamp: "2026-11-12T21:54:00+09:00", class: "product" },
    { id: 50, title: "Own message echo 167 ms once", timestamp: "2026-11-12T21:53:00+09:00", class: "unclear" },
    { id: 51, title: "Running turn has no Stop and appears stuck", timestamp: "2026-11-12T22:19:44+09:00", class: "product" },
  ]));

const labels = {
  reloadToReady: ["Reload to ready", 3000],
  coldStartToInteractive: ["Cold start to interactive", null],
  coldFirstReadable: ["Cold first readable", null],
  newSessionUsable: ["New session usable", 2000],
  modelMenuVisible: ["Model menu visible", 1000],
  ownMessageVisible: ["Own message visible (median of new sessions; click to frame, in the page)", 100],
  ownMessageVisibleSlowest: ["Own message visible, slowest", null],
  workingVisible: ["Turn visibly working (median; click to frame, in the page)", 100],
  workingVisibleSlowest: ["Turn visibly working, slowest", null],
  // The same moments from the test driver's side; recorded, not gated.
  ownMessageVisibleDriver: ["Own message visible as the driver sees it (median)", null],
  ownMessageVisibleDriverSlowest: ["Own message visible as the driver sees it, slowest", null],
  workingVisibleDriver: ["Turn visibly working as the driver sees it (median)", null],
  workingVisibleDriverSlowest: ["Turn visibly working as the driver sees it, slowest", null],
  warmFirstReadableSlowest: ["Answer readable, slowest (provider + model)", null],
  turnObservedEndSlowest: ["Turn observed end, slowest", null],
  ownMessage: ["Own message visible", 100],
  warmOwnMessage: ["Warm own message visible", 100],
  // Waits for the provider and the model's reasoning; recorded, not gated (#97).
  warmFirstReadable: ["Answer readable (median; provider + model)", null],
  turnObservedEnd: ["Turn observed end", null],
  stopToIdle: ["Stop to idle", 2000],
  secondNewSessionUsable: ["Second session usable", 2000],
  savedSessionSwitch: ["Saved-session switch", 2000],
  newRowCount: ["New session rows visible", null],
};
/** Host part of a reply (#117), read from PLAYBOOK_HOST_LOG after the run; see host-timing.mjs. */
async function readHostTiming(run) {
  const path = process.env.PLAYBOOK_HOST_LOG;
  if (!path) return null;
  return hostTiming(await readFile(path, "utf8"), { from: Date.parse(run.startedAt ?? 0), to: Date.parse(run.finishedAt ?? new Date().toISOString()) });
}

const fmt = value => value == null ? "not measured" : `${Math.round(value)} ms`;
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const run = runs[0];
const allMetrics = Object.entries(run.metrics ?? {}).map(([id, value]) => {
  const [label, fallbackLimit] = labels[id] ?? [id, null];
  const gate = run.gates?.[id];
  const limit = gate?.limit ?? fallbackLimit;
  const status = gate ? (gate.ok ? "pass" : "fail") : limit == null ? "record" : value <= limit ? "pass" : "fail";
  return { id, label, valueMs: value, limitMs: limit, status };
});
const host = await readHostTiming(run);
if (host?.first) {
  const limit = HOST_GATE_LIMIT_MS;
  const ok = hostGateProblem(host, limit) === null;
  allMetrics.push({ id: "sendToModelRequest", label: "Send to model request, first turn (host.log, median)", valueMs: host.first.median, limitMs: limit, status: ok ? "pass" : "fail", slowestMs: host.first.slowest, samples: host.first.samples });
}
if (host?.later) allMetrics.push({ id: "sendToModelRequestLater", label: "Send to model request, later turns (host.log, median)", valueMs: host.later.median, limitMs: null, status: "record" });
const gates = allMetrics.filter(metric => metric.limitMs != null);
const observations = allMetrics.filter(metric => metric.limitMs == null).map(({ id, label, valueMs }) => ({ id, label, valueMs }));
const failed = gates.filter(gate => gate.status === "fail").map(gate => gate.id);
const scenarios = (run.scenarios ?? []).map(item => {
  const name = item.name ?? item.id ?? "scenario";
  return {
    id: /^P\d-\d+/.test(name) ? name.split(" ")[0] : slug(String(name)),
    name,
    status: item.ok ? "pass" : "fail",
    evidence: item.detail ?? "",
  };
});
const ranStop = scenarios.some(item => /stop/i.test(`${item.id} ${item.name}`));
const missing = [...missingBase, ...(host?.first ? [] : ["hostTiming"])].filter(id => {
  if (id === "coldProcessLaunch") return run.metrics?.coldStartToInteractive == null;
  if (id === "stop") return !ranStop;
  if (id === "hostTiming") return true;
  return true;
});
const coverage = { complete: missing.length === 0, missing };
const releaseReleasable = run.pass === true && failed.length === 0 && coverage.complete;
const report = {
  schemaVersion: 1,
  runId: run.startedAt ?? new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  title,
  build: { version: "1.0.23", kind: "build-test", commit: process.env.PLAYBOOK_COMMIT ?? "e35b22c" },
  verdict: { status: releaseReleasable ? "pass" : failed.length || scenarios.some(s => s.status === "fail") ? "fail" : "incomplete", releaseReleasable, blocking: failed },
  coverage,
  gates,
  observations,
  scenarios,
  issues,
  source: files.map(file => basename(file)),
  errors: run.errors ?? [],
};
const reportJson = JSON.stringify(report, null, 2).replaceAll("<", "\\u003c");

const css = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#c9d1d9;--muted:#8b949e;--bad:#f85149;--good:#3fb950;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
main{max-width:1120px;margin:0 auto;padding:32px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}
.sub{color:var(--muted);margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.v{font-size:24px;font-weight:650;margin-top:4px}.bad{color:var(--bad)}.good{color:var(--good)}.warn{color:var(--warn)}
.bar{position:relative;height:22px;background:#0b1220;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:8px}
.fill{height:100%;background:var(--bad)}.fill.ok{background:var(--good)}.mark{position:absolute;top:0;bottom:0;width:2px;background:#fff;opacity:.8}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}code{background:#0b1220;border:1px solid var(--line);padding:1px 5px;border-radius:4px}
.pill{display:inline-block;border-radius:99px;padding:1px 8px;font-size:12px;border:1px solid currentColor}
ul{margin:8px 0 0;padding-left:20px}li{margin:4px 0}.muted{color:var(--muted)}
.summary{display:grid;grid-template-columns:2fr 1fr;gap:12px}@media(max-width:760px){.summary{grid-template-columns:1fr}}
`;

function latencySection() {
  return `<section><h2>Gate profile</h2><div class="grid">${gates.map(gate => {
    const ratio = gate.limitMs ? gate.valueMs / gate.limitMs : 0;
    const cls = gate.status === "pass" ? "good" : gate.status === "fail" ? "bad" : "warn";
    return `<div class="card"><div class="k">${gate.label} <span class="pill ${cls}">${gate.status.toUpperCase()}</span></div>
      <div class="v ${cls}">${fmt(gate.valueMs)}</div><div class="muted">limit: ${gate.limitMs ? fmt(gate.limitMs) : "record only"}</div>
      <div class="bar"><div class="fill ${gate.status === "pass" ? "ok" : ""}" style="width:${Math.min(100, ratio * 50)}%"></div>
      ${gate.limitMs ? '<div class="mark" style="left:50%"></div>' : ""}</div></div>`;
  }).join("")}</div>
  ${observations.length ? `<p class="muted">Recorded only: ${observations.map(item => `${item.label} ${item.id === "newRowCount" ? `${item.valueMs} row(s)` : fmt(item.valueMs)}`).join(" · ")}</p>` : ""}
  </section>`;
}

function scenarioSection() {
  return `<section><h2>Scenarios</h2><table><thead><tr><th>ID</th><th>Scenario</th><th>Status</th><th>Visible evidence</th></tr></thead><tbody>
    ${scenarios.map(s => `<tr><td><code>${s.id}</code></td><td>${s.name}</td><td class="${s.status === "pass" ? "good" : "bad"}">${s.status.toUpperCase()}</td><td class="muted">${s.evidence}</td></tr>`).join("") || "<tr><td colspan=4>No scenarios recorded</td></tr>"}
  </tbody></table>
  <h2>Not run</h2><ul>${missing.map(id => `<li><code>${id}</code></li>`).join("") || "<li>none</li>"}</ul></section>`;
}

function issueSection() {
  return `<section><h2>Issues</h2><table><thead><tr><th>ID</th><th>Observation</th><th>Timestamp</th><th>Class</th></tr></thead><tbody>
    ${issues.map(issue => `<tr><td>#${issue.id}</td><td>${issue.title}</td><td><code>${issue.timestamp}</code></td><td>${issue.class}</td></tr>`).join("")}
  </tbody></table></section>`;
}

const body = `<main>
<h1>${title}</h1>
<div class="sub">Build ${report.build.version} · ${report.build.kind} · commit <code>${report.build.commit}</code><br>
Run ${report.runId} · generated ${report.generatedAt}<br>
Black-box evidence: accessible actions, visible text, unique reply sentinel. The one host figure (send to model request) is read from host.log after the run. Repeated timings are judged by median, with the slowest sample allowed up to twice the limit.</div>
<div class="summary">
  <div class="card"><div class="k">Release decision</div><div class="v ${releaseReleasable ? "good" : "bad"}">${releaseReleasable ? "PASS" : report.verdict.status.toUpperCase()}</div>
  <div class="muted">${releaseReleasable ? "All recorded gates and required coverage passed." : `Not releasable. Blocking gates: ${failed.length ? failed.join(", ") : "none recorded"}; missing coverage: ${missing.length}.`}</div></div>
  <div class="card"><div class="k">Next actions</div><ul>
    ${issues.slice(0, 3).map(issue => `<li>#${issue.id} ${issue.title}</li>`).join("")}
    ${missing.length ? `<li>Run ${missing.length} missing scenario groups</li>` : ""}
  </ul></div>
</div>
${latencySection()}
${scenarioSection()}
${issueSection()}
<section><h2>Method</h2><p class="muted">Generated from playbook JSON. Timing is the user-visible action-to-result interval. A green chart from an incomplete run is still not a release sign-off. The embedded JSON is the agent-readable contract; color and bar width are only human aids.</p>
<p class="muted">Sources: ${report.source.join(", ")}.</p></section>
</main>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body>${body}<script type="application/json" id="report-data">${reportJson}</script></body></html>`;
await writeFile(out, html);
await writeFile(out.replace(/\.html?$/i, ".json"), `${reportJson}\n`);
console.log(out);
