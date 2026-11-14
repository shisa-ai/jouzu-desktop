import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, FolderOpen } from "lucide-react";
import { Button } from "./components/ui/button";
import { ChatMarkdown } from "./chat-markdown";
import { ErrorLine } from "./session-alerts-view";

interface Preview {
  binary: boolean;
  truncated: boolean;
  bytes: number;
  text: string;
}

const MARKDOWN = /\.(?:md|mdx|markdown)$/iu;

function fileName(path: string) {
  return path.split(/[\\/]/u).pop() ?? path;
}

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * One workspace file opened from the turn summary (0080). Text renders, Markdown
 * renders as Markdown, and anything unreadable offers the folder instead of a
 * broken view.
 */
export function FilePreview({ path, workspace, onClose }: { path: string; workspace?: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    if (!workspace) { setError("The workspace folder is unavailable."); return () => { alive = false; }; }
    void invoke<Preview>("workspace_read", { path, workspace })
      .then(value => { if (alive) setPreview(value); })
      .catch(failure => { if (alive) setError(String(failure)); });
    return () => { alive = false; };
  }, [path, workspace]);

  async function reveal() {
    try {
      await invoke("reveal_path", { path });
      setRevealError(null);
    } catch (failure) {
      setRevealError(String(failure));
    }
  }

  async function copyPath() {
    try { await navigator.clipboard.writeText(path); } catch { /* Clipboard may be unavailable. */ }
  }

  const name = fileName(path);
  return <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
    <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><h3 className="min-w-0 truncate text-sm font-semibold" title={path}>{name}</h3></div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => void reveal()}><FolderOpen className="size-3" />Reveal</Button>
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => void copyPath()}>Copy path</Button>
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>Close</Button>
        </div>
      </div>
      <p className="truncate border-b border-border px-4 py-1 font-mono text-[10px] text-muted-foreground" title={path}>{path}</p>
      {revealError && <div className="border-b border-border px-4 py-1"><ErrorLine raw={revealError} failed="Could not show the file in its folder." onDismiss={() => setRevealError(null)} /></div>}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!preview && !error && <p className="text-sm text-muted-foreground">Opening…</p>}
        {error && <ErrorLine raw={error} failed="Could not open this file." />}
        {preview?.binary && <p className="text-sm text-muted-foreground">This file is not text. Use Reveal to open it in its own application.</p>}
        {preview?.truncated && <p className="text-sm text-muted-foreground">This file is {formatBytes(preview.bytes)}; too large to preview. Use Reveal to open it.</p>}
        {preview && !preview.binary && !preview.truncated && (MARKDOWN.test(path) ? <ChatMarkdown text={preview.text} /> : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{preview.text}</pre>)}
      </div>
    </div>
  </div>;
}