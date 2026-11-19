export type TextKind = "json" | "diff" | "text";
export type DiffKind = "add" | "remove" | "hunk" | "header" | "context";

/** Classify a result before choosing a renderer; never parse untrusted text as HTML. */
export function classifyText(text: string): TextKind {
  const value = text.trim();
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try { JSON.parse(value); return "json"; } catch { /* not JSON */ }
  }
  const lines = value.split("\n");
  if (lines.some(line => /^(?:diff --git|@@ )/u.test(line)) && lines.some(line => /^[+-](?![+-])/u.test(line))) return "diff";
  return "text";
}

export function prettyJson(text: string): string | undefined {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return undefined; }
}

export function diffRows(text: string): Array<{ kind: DiffKind; text: string }> {
  return text.split("\n").map(line => {
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (/^(?:diff --git|--- |\+\+\+ |index |new file |deleted file )/u.test(line)) return { kind: "header", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "remove", text: line };
    return { kind: "context", text: line };
  });
}
