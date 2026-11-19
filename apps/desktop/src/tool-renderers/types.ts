import type { ToolView } from "../chat-projection";

export interface ToolRendererProps { tool: ToolView }
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function toolText(result: unknown): string {
  const value = record(result);
  const content = value && Array.isArray(value.content) ? value.content : [];
  return content.map(block => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}
