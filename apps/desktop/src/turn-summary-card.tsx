import { useState } from "react";
import { ExternalLink, FileCode2, FileImage, FileText, Image as ImageIcon, PencilLine } from "lucide-react";
import { ImageViewer } from "./components/image-viewer";
import { Button } from "./components/ui/button";
import { FilePreview } from "./file-preview";
import type { TurnArtifact, TurnSummaryData } from "./turn-summary";
import { useChatText } from "./chat-text";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "c", "h", "cpp", "css", "html", "json", "toml", "yaml", "yml", "sh", "ps1"]);

/** The secondary line of a file card. It names the format, never invents a summary. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1).toUpperCase();
}

function fileIcon(extension: string) {
  const key = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(key)) return FileImage;
  if (CODE_EXTENSIONS.has(key)) return FileCode2;
  return FileText;
}

/**
 * The turn-end summary: what the turn produced, so images and edited files are
 * visible without scrolling back through the transcript. Files render as cards with
 * a type icon, the name and the format; opening one previews it.
 */
export function TurnSummary({ data, workspace, onOpenArtifacts }: { data: TurnSummaryData; workspace?: string; onOpenArtifacts?: () => void }) {
  const t = useChatText();
  const [open, setOpen] = useState<TurnArtifact | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  if (!data.artifacts.length && !data.files.length) return null;
  return <section aria-label={t.turnSummary} className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {data.artifacts.length > 0 && <span className="flex items-center gap-1.5"><ImageIcon className="size-3.5" aria-hidden="true" />{data.artifacts.length} image{data.artifacts.length === 1 ? "" : "s"}</span>}
      {data.files.length > 0 && <span className="flex items-center gap-1.5"><PencilLine className="size-3.5" aria-hidden="true" />{data.files.length} file{data.files.length === 1 ? "" : "s"} edited</span>}
      {data.artifacts.length > 0 && onOpenArtifacts && <Button variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={onOpenArtifacts}>{t.viewInArtifacts}</Button>}
    </div>
    {data.artifacts.length > 0 && <div className="mt-2 flex flex-wrap gap-2">
      {data.artifacts.map(artifact => artifact.data
        ? <button key={artifact.id} type="button" className="overflow-hidden rounded-md border border-border" title={artifact.prompt ?? artifact.path ?? t.generatedImage} aria-label={artifact.prompt ?? t.generatedImage} onClick={() => setOpen(artifact)}>
          <img src={`data:${artifact.mime};base64,${artifact.data}`} alt={artifact.prompt ?? t.generatedImage} className="size-20 object-cover" />
        </button>
        : <span key={artifact.id} className="max-w-48 truncate rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">{artifact.path ?? "image"}</span>)}
    </div>}
    {data.files.length > 0 && <ul aria-label={t.editedFiles} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {data.files.map(file => {
        const name = file.split(/[\\/]/u).pop() ?? file;
        const extension = fileExtension(name);
        const Icon = fileIcon(extension);
        return <li key={file}>
          <button type="button" className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={file} onClick={() => setPreview(file)}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground"><Icon className="size-3.5" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">{name}</span>
              <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">{extension}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </li>;
      })}
    </ul>}
    {open && <ImageViewer src={`data:${open.mime};base64,${open.data}`} alt={open.prompt ?? ""} title={open.path?.split(/[\\/]/u).pop() ?? t.image} onClose={() => setOpen(null)} />}
    {preview && <FilePreview path={preview} workspace={workspace} onClose={() => setPreview(null)} />}
  </section>;
}