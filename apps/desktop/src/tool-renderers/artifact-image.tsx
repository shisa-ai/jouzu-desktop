import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Download, FolderOpen, Maximize2, Quote } from "lucide-react";
import { Button } from "../components/ui/button";
import { ImageViewer, type ViewerAction } from "../components/image-viewer";
import { MAX_TOOL_IMAGE_BYTES, MessageImage } from "../message-image";
import { copyText } from "../secure-context";
import { useChatText } from "../chat-text";

export interface ArtifactImageData {
  mime: string;
  data: string;
  alt: string;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
}

const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const action = "size-7 shrink-0 p-0";

/**
 * One image result: the picture, a dimensions line and the artifact actions.
 * Opening the picture uses the shared top-level ImageViewer, and the viewer's
 * toolbar is the same action list as the inline one.
 */
export function ArtifactImage({ image, caption, onUse }: { image: ArtifactImageData; caption?: string; onUse?: (path: string) => void }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const src = `data:${image.mime};base64,${image.data}`;
  const name = image.path?.split(/[\\/]/u).pop() ?? "image.png";
  const bytes = image.bytes ?? Math.floor(image.data.length * 0.75);
  const oversized = bytes > MAX_TOOL_IMAGE_BYTES;
  const unsupported = !SUPPORTED_MIME.includes(image.mime);

  async function download() {
    if (!image.path) {
      const anchor = document.createElement("a");
      anchor.href = src;
      anchor.download = name;
      anchor.click();
      return;
    }
    // WebView2 ignores an anchor download, so pick a destination and copy the file.
    const target = await save({ defaultPath: name });
    if (target) await invoke("save_copy", { from: image.path, to: target });
  }

  // Never drop an oversized or unsupported block: the shared image card says
  // why it is not inline and keeps the path actions available.
  if (oversized || unsupported) {
    return <figure className="space-y-1">
      <MessageImage kind="tool" source={src} alt={image.alt} bytes={bytes} path={image.path} showCaption={false} />
      {caption && <figcaption className="text-[10px] text-muted-foreground">{caption}</figcaption>}
    </figure>;
  }

  const actions: (ViewerAction & { icon: ReactNode })[] = [
    { id: "download", label: t.download, icon: <Download className="size-3.5" />, onSelect: () => { void download().catch(() => {}); } },
  ];
  if (image.path) {
    actions.push({
      id: "copy",
      label: copied ? t.pathCopied : t.copyPath,
      icon: copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />,
      onSelect: () => { void copyText(image.path!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => setCopied(false)); },
    });
    actions.push({ id: "reveal", label: t.showInFolder, icon: <FolderOpen className="size-3.5" />, onSelect: () => { void invoke("reveal_path", { path: image.path }).catch(() => {}); } });
    actions.push({
      id: "use",
      label: t.useAsAttachment,
      icon: <Quote className="size-3.5" />,
      onSelect: () => { if (onUse) onUse(image.path!); else window.dispatchEvent(new CustomEvent("jouzu:use-artifact", { detail: image.path })); },
    });
  }
  const inline: ViewerAction[] = [
    { id: "open", label: t.openLargeImage, icon: <Maximize2 className="size-3.5" />, onSelect: () => setOpen(true) },
    ...actions,
  ];

  return <figure className="space-y-1">
    <MessageImage kind="tool" source={src} alt={image.alt} bytes={bytes} showCaption={false} />
    <figcaption className="flex flex-wrap items-center justify-between gap-2">
      {caption && <span className="text-[10px] text-muted-foreground">{caption}</span>}
      <div className="ml-auto flex flex-nowrap items-center justify-end gap-0.5">
        {inline.map(item => <Button key={item.id} variant="ghost" className={action} title={item.label} aria-label={item.label} onClick={item.onSelect}>{item.icon}</Button>)}
      </div>
    </figcaption>
    {open && <ImageViewer src={src} alt={image.alt} title={image.path?.split(/[\\/]/u).pop() ?? t.image} actions={actions} onClose={() => setOpen(false)} />}
  </figure>;
}
