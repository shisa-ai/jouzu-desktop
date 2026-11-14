// Fake pi RPC runtime for host tests. It speaks the real wire shapes:
// {id,type:"response",...}, extension_ui_request, and agent/message events.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const delay = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? 15);
const startDelay = Number(process.env.FAKE_RUNTIME_START_DELAY_MS ?? 0);
const exitOnStart = Number(process.env.FAKE_RUNTIME_EXIT_ON_START_MS ?? 0);
const crashOnPrompt = process.env.FAKE_RUNTIME_CRASH_ON_PROMPT === "1";
const tool = process.env.FAKE_RUNTIME_TOOL === "1";
// Real runtimes answer "handled" when Flow keeps the input and no run starts.
const handledPrompts = process.env.FAKE_RUNTIME_HANDLED === "1";
const garbage = process.env.FAKE_RUNTIME_GARBAGE === "1";
const uiMethod = process.env.FAKE_RUNTIME_UI ?? "";
const uiTimeout = Number(process.env.FAKE_RUNTIME_UI_TIMEOUT_MS ?? 0);
// A run of several steps, each a model call (reasoning, words, a tool call) and
// its tool, as the real runtime reports it. Optional: one provider retry before
// step 2, and a last tool that never finishes (only an abort ends the run).
const steps = Number(process.env.FAKE_RUNTIME_STEPS ?? 0);
const stepRetry = process.env.FAKE_RUNTIME_STEP_RETRY === "1";
const hangTool = process.env.FAKE_RUNTIME_HANG_TOOL === "1";
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, command, data) =>
  out({ id, type: "response", command, success: true, data });
const failure = (id, command, error) =>
  out({ id, type: "response", command, success: false, error });

let busy = false;
let interrupted = false;
let timer = null;
let current = null;
let pendingUi = null;
const messages = [];
// Messages the user sent while a run was going (the runtime's steering queue).
// The real runtime delivers them one per step, before the next model call, and
// keeps going until the queue is empty; abort leaves them queued.
let steering = [];
const queueUpdate = () => out({ type: "queue_update", steering: steering.map(item => item.text), followUp: [] });
const promptLog = text => { if (process.env.FAKE_RUNTIME_PROMPT_LOG) appendFileSync(process.env.FAKE_RUNTIME_PROMPT_LOG, `${text}\n`); };
function userMessage(text, images) {
  const content = [{ type: "text", text }, ...(images ?? [])];
  out({ type: "message_start", message: { role: "user", content } });
  out({ type: "message_end", message: { role: "user", content } });
  messages.push({ role: "user", content });
}
// Deliver the next steered message, as the runtime does at a step boundary.
function deliverSteer() {
  const next = steering.shift();
  if (!next) return null;
  queueUpdate();
  userMessage(next.text, next.images);
  return next;
}

if (startDelay > 0) {
  await new Promise(resolve => setTimeout(resolve, startDelay));
}

if (garbage) {
  process.stdout.write("this is not json\n");
}

if (exitOnStart > 0) {
  setTimeout(() => process.exit(7), exitOnStart);
}

if (process.env.FAKE_RUNTIME_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.FAKE_RUNTIME_CHILD_PID_FILE, String(child.pid));
}

function settled(aborted) {
  busy = false;
  clearTimeout(timer);
  current = null;
  pendingUi = null;
  out({ type: "agent_settled", aborted });
}

function tick() {
  if (!busy || !current) return;
  if (interrupted) {
    settled(true);
    return;
  }
  const { parts, index } = current;
  if (index < parts.length) {
    out({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: parts[index],
      },
    });
    current.index += 1;
    timer = setTimeout(tick, delay);
    return;
  }
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: parts.join("") }], model: "fixture-model", provider: "fixture" },
  });
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: parts.join("") }],
    model: "fixture-model",
    provider: "fixture",
  });
  if (steering.length > 0) {
    out({ type: "turn_end" });
    out({ type: "turn_start" });
    const next = deliverSteer();
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    current = { parts: Array.from(next.text), index: 0 };
    timer = setTimeout(tick, delay);
    return;
  }
  settled(false);
}

function runSteps(text, images) {
  const script = [{ type: "agent_start" }, { type: "echo", text, images }];
  for (let n = 1; n <= steps; n += 1) {
    const last = n === steps;
    if (stepRetry && n === 2) {
      script.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" });
      script.push({ type: "auto_retry_end", success: true, attempt: 1 });
    }
    script.push({ type: "turn_start" });
    if (n > 1) script.push({ type: "steer-point" });
    script.push({ type: "message_start", message: { role: "assistant", content: [] } });
    script.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: `think ${n}` } });
    script.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `say ${n}` } });
    const content = [{ type: "thinking", thinking: `think ${n}` }, { type: "text", text: `say ${n}` }];
    if (!last) {
      script.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });
      content.push({ type: "toolCall", id: `call-${n}`, name: "bash", arguments: { command: `echo ${n}` } });
    }
    const reply = { role: "assistant", content, model: "fixture-model", provider: "fixture", usage: { input: 10 * n, output: n }, stopReason: last ? "stop" : "toolUse" };
    script.push({ type: "message_end", message: reply, record: reply });
    if (!last) {
      script.push({ type: "tool_execution_start", toolCallId: `call-${n}`, toolName: "bash", args: { command: `echo ${n}` } });
      if (hangTool && n === steps - 1) { script.push({ type: "hang" }); break; }
      const result = { content: [{ type: "text", text: `out ${n}` }] };
      script.push({ type: "tool_execution_end", toolCallId: `call-${n}`, toolName: "bash", isError: false, result, record: { role: "toolResult", toolCallId: `call-${n}`, toolName: "bash", content: result.content, isError: false } });
    }
    script.push({ type: "turn_end" });
  }
  script.push({ type: "last-steer-point" });
  script.push({ type: "agent_end" });
  const next = () => {
    if (!busy) return;
    if (interrupted) { settled(true); return; }
    const event = script.shift();
    if (!event) { settled(false); return; }
    if (event.type === "hang") return;
    if (event.type === "echo") {
      // The prompt, then anything steered before the run began.
      userMessage(event.text, event.images);
      deliverSteer();
      timer = setTimeout(next, delay);
      return;
    }
    if (event.type === "steer-point") { deliverSteer(); timer = setTimeout(next, delay); return; }
    if (event.type === "last-steer-point") {
      // The run would end, but steered messages remain: one more step answers them.
      if (steering.length > 0) {
        const answer = { role: "assistant", content: [{ type: "text", text: "ack" }], model: "fixture-model", provider: "fixture", usage: { input: 1, output: 1 }, stopReason: "stop" };
        script.unshift(
          { type: "turn_start" },
          { type: "steer-point" },
          { type: "message_start", message: { role: "assistant", content: [] } },
          { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ack" } },
          { type: "message_end", message: answer, record: answer },
          { type: "turn_end" },
          { type: "last-steer-point" },
        );
      }
      timer = setTimeout(next, delay);
      return;
    }
    const { record, ...wire } = event;
    if (record) messages.push(record);
    out(wire);
    timer = setTimeout(next, delay);
  };
  next();
}

function beginTurn(text) {
  current = { parts: Array.from(String(text)), index: 0 };
  tick();
}

function requestUi(text) {
  const id = "ui-1";
  pendingUi = { text };
  const request = { type: "extension_ui_request", id };
  if (uiMethod === "confirm") {
    request.method = "confirm";
    request.title = "Allow test?";
    request.message = "Run the test tool?";
  } else if (uiMethod === "select") {
    request.method = "select";
    request.title = "Pick one";
    request.options = ["A", "B"];
  } else if (uiMethod === "input") {
    request.method = "input";
    request.title = "Name";
    request.placeholder = "type here";
  } else if (uiMethod === "editor") {
    request.method = "editor";
    request.title = "Edit";
    request.prefill = "seed";
  }
  if (uiTimeout > 0) request.timeout = uiTimeout;
  out(request);
}

function prompt(id, text, images) {
  if (handledPrompts || String(text).startsWith("/flow ")) {
    promptLog(text);
    response(id, "prompt", { disposition: "handled" });
    return;
  }
  promptLog(text);
  // "EXTERR <text>" first reports an extension failure, like a real extension would.
  if (String(text).startsWith("EXTERR ")) out({ type: "extension_error", extensionPath: "fake", event: "turn_start", error: String(text).slice(7) });
  busy = true;
  interrupted = false;
  response(id, "prompt", { disposition: "started" });
  if (crashOnPrompt) {
    setTimeout(() => process.exit(8), 10);
  }
  if (steps > 0) {
    runSteps(String(text), images);
    return;
  }
  if (tool) {
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
    out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
    out({ type: "tool_execution_end", toolCallId: "call-1", isError: false, result: { output: "hi" } });
  }
  out({ type: "agent_start" });
  out({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  userMessage(String(text), images);
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  if (uiMethod === "noise") {
    out({ type: "extension_ui_request", id: "noise-1", method: "setWidget", widgetKey: "x" });
    out({ type: "extension_ui_request", id: "noise-2", method: "setStatus", statusKey: "x" });
    beginTurn(text);
    return;
  }
  if (uiMethod === "notices") {
    out({ type: "extension_ui_request", id: "n-1", method: "notify", message: "Flow control is holding your message: test.", notifyType: "warning" });
    out({ type: "extension_ui_request", id: "n-2", method: "setStatus", statusKey: "flow", statusText: "held 1" });
    out({ type: "extension_ui_request", id: "n-3", method: "setWidget", widgetKey: "flow", widgetLines: ["line a", "line b"] });
    beginTurn(text);
    return;
  }
  if (uiMethod) {
    requestUi(text);
    return;
  }
  beginTurn(text);
}

let currentModel = { name: "fixture-model", provider: "fixture", id: "model" };

const lines = readline.createInterface({ input: process.stdin });
if (process.env.FAKE_RUNTIME_IGNORE_STDIN === "1") {
  lines.pause();
  process.stdin.pause();
}
lines.on("line", line => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.type === "extension_ui_response") {
    if (!pendingUi) return;
    const pending = pendingUi;
    pendingUi = null;
    let label = "cancelled";
    if (value.cancelled) label = "cancelled";
    else if ("confirmed" in value) label = value.confirmed ? "approved" : "denied";
    else if ("value" in value) label = String(value.value ?? "");
    beginTurn(label);
    return;
  }
  switch (value.type) {
    case "get_messages":
      response(value.id, "get_messages", { messages });
      break;
    case "get_state":
      response(value.id, "get_state", { sessionId: "fixture", isStreaming: busy, model: currentModel, thinkingLevel: "off", sessionFile: null });
      break;
    case "get_available_models":
      response(value.id, "get_available_models", { models: [] });
      break;
    case "get_available_thinking_levels":
      response(value.id, "get_available_thinking_levels", { levels: ["off"] });
      break;
    case "set_model":
      if (typeof value.modelId !== "string") {
        failure(value.id, "set_model", "set_model requires modelId");
        break;
      }
      if (value.modelId === "missing") {
        failure(value.id, "set_model", "Model not found: missing");
        break;
      }
      currentModel = { name: "fixture-model", provider: String(value.provider ?? "fixture"), id: value.modelId };
      response(value.id, "set_model", { model: currentModel });
      break;
    case "set_thinking_level":
      response(value.id, "set_thinking_level", { level: String(value.level ?? "off") });
      break;
    case "switch_session":
      response(value.id, "switch_session", { cancelled: false });
      break;
    case "prompt":
      if (busy) {
        failure(value.id, "prompt", "prompt while busy");
        break;
      }
      prompt(value.id, String(value.message ?? ""), value.images);
      break;
    case "steer": {
      const text = String(value.message ?? "");
      if (process.env.FAKE_RUNTIME_STEER_LOG) appendFileSync(process.env.FAKE_RUNTIME_STEER_LOG, `${text}\n`);
      if (handledPrompts || text.startsWith("/flow ")) {
        response(value.id, "steer", { disposition: "handled" });
        break;
      }
      if (text.startsWith("/ext ")) {
        failure(value.id, "steer", `Extension command "${text}" cannot be queued`);
        break;
      }
      steering.push({ text, images: value.images });
      queueUpdate();
      response(value.id, "steer", { disposition: "queued" });
      break;
    }
    case "clear_queue": {
      const cleared = steering.map(item => item.text);
      steering = [];
      queueUpdate();
      response(value.id, "clear_queue", { steering: cleared, followUp: [] });
      break;
    }
    case "abort":
      response(value.id, "abort", {});
      if (busy) {
        interrupted = true;
        if (current) clearTimeout(timer);
        settled(true);
      }
      break;
    default:
      failure(value.id, String(value.type ?? "unknown"), "unsupported command");
      break;
  }
});
lines.on("close", () => process.exit(0));
