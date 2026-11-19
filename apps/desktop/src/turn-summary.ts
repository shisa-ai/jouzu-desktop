import type { ChatMessage, ToolView } from "./chat-projection";

export interface TurnArtifact {
  id: string;
  mime: string;
  data: string;
  path?: string;
  width?: number;
  height?: number;
  prompt?: string;
}

export interface TurnSummaryData {
  artifacts: TurnArtifact[];
  files: string[];
}

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const IMAGE_PATH = /[A-Za-z]:[\\/][^\n\r"]+?\.(?:png|jpe?g|webp|gif)\b/iu;

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

/**
 * Everything a turn produced: image tool results become artifact thumbnails, file
 * tools contribute edited paths, and the workspace diff contributes the files those
 * tools could not see (a file created by a shell command, for example).
 */
export function summarizeTurn(messages: ChatMessage[], tools: Record<string, ToolView>, end: number, changed: readonly string[] = []): TurnSummaryData {
  let start = 0;
  for (let index = Math.min(end, messages.length - 1); index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { start = index; break; }
  }
  const artifacts: TurnArtifact[] = [];
  const transcriptFiles: string[] = [];
  for (let index = start; index <= end && index < messages.length; index += 1) {
    for (const block of messages[index]?.content ?? []) {
      if (block.type !== "toolCall" || typeof block.id !== "string") continue;
      const view = tools[block.id];
      const result = record(view?.result);
      const content = Array.isArray(result?.content) ? result.content : [];
      const args = record(block.arguments);
      if (block.name === "generate_image") {
        const details = record(result?.details);
        const metas = Array.isArray(details?.images) ? details.images : [];
        const images = content.filter(item => item?.type === "image" && typeof item.data === "string");
        const fallback = content.find(item => item?.type === "text" && typeof item.text === "string");
        const path = fallback ? IMAGE_PATH.exec(fallback.text)?.[0] : undefined;
        images.forEach((image, position) => {
          const meta = record(metas[position]) ?? {};
          artifacts.push({
            id: typeof meta.id === "string" ? meta.id : `${block.id}-${position}`,
            mime: typeof image.mimeType === "string" ? image.mimeType : "image/png",
            data: image.data,
            path: typeof meta.path === "string" ? meta.path : path,
            width: typeof meta.width === "number" ? meta.width : undefined,
            height: typeof meta.height === "number" ? meta.height : undefined,
            prompt: typeof details?.prompt === "string" ? details.prompt : typeof args?.prompt === "string" ? args.prompt : undefined,
          });
        });
      }
      if (typeof block.name === "string" && EDIT_TOOLS.has(block.name)) {
        const args = record(block.arguments);
        const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
        if (path) transcriptFiles.push(path);
      }
    }
  }
  // Workspace changes come first: they are evidence of what the turn produced. Tool
  // arguments fill in anything the snapshot could not see, without duplicating paths.
  const seen = new Set<string>();
  const files: string[] = [];
  const push = (path: string) => {
    const key = path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    files.push(path);
  };
  for (const path of changed) push(path);
  for (const path of transcriptFiles) push(path);
  return { artifacts, files };
}

