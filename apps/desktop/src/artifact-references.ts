import type { ChatMessage } from "./chat-projection";

/** A file the turn produced in place; it is shown in Artifacts but not frozen. */
export interface OutputReference {
  path: string;
  name: string;
  sessionId?: string;
}

const PATH_TOOLS = new Set(["write", "edit", "apply_patch"]);

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function normalize(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+/gu, "/").toLowerCase();
}

/**
 * Every file path the transcript says the turn wrote. These are references to
 * the workspace original, not artifacts; the Artifacts panel offers Save to
 * freeze a copy into the store.
 */
export function collectOutputReferences(messages: ChatMessage[], sessionId?: string): OutputReference[] {
  const seen = new Set<string>();
  const result: OutputReference[] = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall" || typeof block.name !== "string" || !PATH_TOOLS.has(block.name)) continue;
      const args = record(block.arguments);
      const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
      if (!path || seen.has(normalize(path))) continue;
      seen.add(normalize(path));
      result.push({ path, name: path.split(/[\\/]/u).pop() ?? path, sessionId });
    }
  }
  return result;
}