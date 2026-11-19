import { ArtifactImage } from "./artifact-image";
import { ToolFrame } from "./tool-frame";
import { imageBlocks } from "./tool-output";
import { toolText, record, type ToolRendererProps } from "./types";
import { artifactPathFromText } from "./artifact-path";
import { fill, useChatText } from "../chat-text";

/**
 * The image tool gets its own view: the picture is the result, so it stays
 * visible in the collapsed state instead of hiding behind a chevron.
 */
export function ImageRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const images = imageBlocks(tool.result, t.toolOutputImage);
  const details = record(record(tool.result)?.details);
  const prompt = typeof details?.prompt === "string" ? details.prompt : "";
  const model = typeof details?.model === "string" ? details.model : "";
  const size = typeof details?.size === "string" ? details.size : "";
  const metas = Array.isArray(details?.images) ? details.images : [];
  const fallbackPath = images.length === 1 ? artifactPathFromText(toolText(tool.result)) : undefined;
  const items = images.map((image, index) => {
    const meta = record(metas[index]);
    return {
      ...image,
      alt: prompt || image.alt,
      path: typeof meta?.path === "string" ? meta.path : fallbackPath,
      width: typeof meta?.width === "number" ? meta.width : undefined,
      height: typeof meta?.height === "number" ? meta.height : undefined,
    };
  });
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const summary = tool.phase === "running" ? t.generating : tool.phase === "error" ? t.failed : `${fill(t.imageCount, { n: items.length })}${[model, size].filter(Boolean).length ? ` · ${[model, size].filter(Boolean).join(" · ")}` : ""}`;
  return <ToolFrame title={t.generatedImage} subtitle={summary} state={state} defaultOpen>
    {items.length ? <div className="grid gap-3 sm:grid-cols-2">
      {items.map((image, index) => <ArtifactImage key={index} image={image} caption={image.width && image.height ? `${image.width}×${image.height}` : undefined} />)}
    </div> : <p className="text-xs text-muted-foreground">{tool.phase === "error" ? t.generationFailed : t.generating}</p>}
  </ToolFrame>;
}
