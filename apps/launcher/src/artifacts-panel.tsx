import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useApi } from "./api/context";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Eye, FileText, FolderOpen, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { ImageViewer } from "./components/image-viewer";
import { ChatMarkdown } from "./chat-markdown";
import type { OutputReference } from "./artifact-references";
import { ErrorLine } from "./session-alerts-view";

interface ArtifactRecord {
  id: string;
  kind?: string;
  path?: string;
  originPath?: string;
  absolutePath?: string;
  prompt?: string;
  mimeType?: string;
  bytes?: number;
  createdAt?: string;
  dimensions?: { width?: number; height?: number };
  source?: { model?: string; provider?: string };
  /** A workspace original: visible in the panel, not frozen into the store. */
  reference?: boolean;
}

const isImage = (mime?: string) => !!mime && mime.startsWith("image/");
const isText = (mime?: string) => !!mime && (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+xml"));

const EXT_MIME: Record<string, [string, string]> = {
  png: ["image/png", "images"], jpg: ["image/jpeg", "images"], jpeg: ["image/jpeg", "images"],
  webp: ["image/webp", "images"], gif: ["image/gif", "images"],
  md: ["text/markdown", "documents"], mdx: ["text/markdown", "documents"], txt: ["text/plain", "documents"],
  json: ["application/json", "documents"], csv: ["text/csv", "documents"], pdf: ["application/pdf", "documents"],
  html: ["text/html", "documents"], htm: ["text/html", "documents"], xml: ["application/xml", "documents"],
};

function referenceRecord(reference: OutputReference): ArtifactRecord {
  const extension = reference.path.split(".").pop()?.toLowerCase() ?? "";
  const [mimeType, kind] = EXT_MIME[extension] ?? ["application/octet-stream", "data"];
  return { id: `reference:${reference.path}`, reference: true, kind, mimeType, path: reference.path, absolutePath: reference.path, prompt: reference.name };
}

const normalizePath = (path?: string) => (path ?? "").replaceAll("\\", "/").replace(/\/+/gu, "/").toLowerCase();

/** A stored file name, unless it is the digest-style name the store gives it. */
function displayName(item: ArtifactRecord): string {
  if (item.prompt?.trim()) return item.prompt.trim();
  const file = (item.absolutePath ?? item.path ?? "").split(/[\\/]/u).pop() ?? "";
  const stem = file.replace(/\.[^.]+$/u, "");
  if (stem && !/^[0-9a-f]{32,}$/iu.test(stem)) return file;
  return item.kind === "documents" ? "Text artifact" : `${item.kind ?? "Artifact"} ${item.id.slice(0, 8)}`;
}

function Thumb({ id, alt, onOpen }: { id: string; alt: string; onOpen: () => void }) {
  const api = useApi();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api.artifacts.read(id)
      .then(value => { if (alive) setSrc(`data:${value.mimeType};base64,${value.data}`); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);
  return <button type="button" className="aspect-square w-full overflow-hidden rounded-md border border-border bg-muted/40" onClick={onOpen} title={alt}>
    {src ? <img src={src} alt={alt} loading="lazy" className="size-full object-cover" /> : null}
  </button>;
}

/** Stored artifacts plus the turn's in-place outputs; Save freezes a copy. */
export function ArtifactsPanel({ sessionId, references = [], workspace, embedded = false }: { sessionId?: string; references?: readonly OutputReference[]; workspace?: string; embedded?: boolean } = {}) {
  const api = useApi();
  const [items, setItems] = useState<ArtifactRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ src: string; title: string } | null>(null);
  const [viewingText, setViewingText] = useState<{ text: string; title: string; markdown: boolean } | null>(null);

  async function load() {
    try {
      const artifacts = await api.artifacts.list(sessionId ? { sessionId } : {});
      setItems(artifacts as unknown as ArtifactRecord[]);
      setError(null);
    } catch (failure) {
      setError(String(failure));
      setItems([]);
    }
  }

  useEffect(() => { void load(); }, [sessionId]);

  async function save(reference: OutputReference) {
    if (!workspace || saving) return;
    setSaving(reference.path);
    try {
      await invoke("artifact_store_copy", { workspace, path: reference.path, ...(sessionId ? { sessionId } : {}), prompt: reference.name });
      await load();
      setError(null);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(null);
    }
  }

  const stored = items ?? [];
  const storedOrigins = new Set(stored.map(item => normalizePath(item.originPath)).filter(Boolean));
  const referencesOnly = references.filter(reference => !storedOrigins.has(normalizePath(reference.path))).map(referenceRecord);
  const visible = [...stored, ...referencesOnly];

  async function view(item: ArtifactRecord) {
    try {
      const result = await api.artifacts.read(item.id);
      const title = displayName(item);
      if (isImage(item.mimeType ?? result.mimeType)) {
        setViewing({ src: `data:${result.mimeType};base64,${result.data}`, title });
      } else if (isText(item.mimeType ?? result.mimeType)) {
        const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        const mime = item.mimeType ?? result.mimeType;
        const markdown = mime === "text/markdown" || /\.mdx?$/iu.test(item.absolutePath ?? item.path ?? "");
        setViewingText({ text: new TextDecoder().decode(bytes), title, markdown });
      } else if (item.absolutePath) {
        await invoke("reveal_path", { path: item.absolutePath });
      } else {
        setError("This artifact has no preview.");
      }
    } catch (failure) {
      setError(String(failure));
    }
  }

  async function remove(item: ArtifactRecord) {
    const okay = await confirm("Delete this artifact? The file is removed from disk.", { title: "Delete artifact", kind: "warning" });
    if (!okay) return;
    try {
      await api.artifacts.delete(item.id);
      await load();
    } catch (failure) {
      setError(String(failure));
    }
  }

  return <Card className={embedded ? "border-0 bg-transparent shadow-none" : "border-border shadow-none"}>
    {!embedded && <CardHeader>
      <CardTitle>Artifacts</CardTitle>
      <CardDescription>{sessionId ? "AI outputs for this session. Save freezes a copy into the artifact store; unsaved items stay in the workspace." : "Saved artifacts, newest first."}</CardDescription>
    </CardHeader>}
    <CardContent className={embedded ? "space-y-4 p-0" : "space-y-4"}>
      {error && <ErrorLine raw={error} failed="This artifacts action did not complete." onDismiss={() => setError(null)} />}
      {!items && !error && <p className="text-sm text-muted-foreground">Loading artifacts…</p>}
      {items && !visible.length && <p className="text-sm text-muted-foreground">No AI outputs in this session yet.</p>}
      {items && visible.length > 0 && <>
        <p className="text-xs text-muted-foreground">{visible.length} artifact{visible.length === 1 ? "" : "s"}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {visible.map(item => <div key={item.id} className="space-y-2">
            {isImage(item.mimeType) && !item.reference
              ? <Thumb id={item.id} alt={displayName(item)} onOpen={() => void view(item)} />
              : <button type="button" className="flex aspect-square w-full items-center justify-center rounded-md border border-border bg-muted/40" onClick={() => { if (!item.reference) void view(item); }} title={displayName(item)}><FileText className="size-7 text-muted-foreground" /></button>}
            <p className="line-clamp-2 text-[11px] text-muted-foreground" title={displayName(item)}>{displayName(item)}</p>
            <p className="truncate text-[10px] text-muted-foreground">{item.reference ? "Not saved · workspace reference" : [item.source?.model, item.dimensions?.width && item.dimensions?.height ? `${item.dimensions.width}×${item.dimensions.height}` : "", item.createdAt ? new Date(item.createdAt).toLocaleString() : ""].filter(Boolean).join(" · ")}</p>
            <div className="flex flex-wrap gap-1">
              {item.reference
                ? <>
                    {workspace && <Button variant="outline" className="h-7 gap-1 px-2 text-[11px]" disabled={saving === item.path} onClick={() => { const reference = references.find(value => normalizePath(value.path) === normalizePath(item.path)); if (reference) void save(reference); }}><FileText className="size-3" />{saving === item.path ? "Saving…" : "Save"}</Button>}
                    <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => { void invoke("reveal_path", { path: item.absolutePath }).catch(() => {}); }}><FolderOpen className="size-3" />Reveal</Button>
                  </>
                : <>
                    <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => void view(item)}><Eye className="size-3" />Open</Button>
                    {item.absolutePath && <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={() => { void invoke("reveal_path", { path: item.absolutePath }).catch(() => {}); }}><FolderOpen className="size-3" />Reveal</Button>}
                    <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px] text-destructive" onClick={() => void remove(item)}><Trash2 className="size-3" />Delete</Button>
                  </>}
            </div>
          </div>)}
        </div>
      </>}
    </CardContent>
    {viewing && <ImageViewer src={viewing.src} alt={viewing.title} title={viewing.title} onClose={() => setViewing(null)} />}
    {viewingText && <div role="dialog" aria-modal="true" aria-label={viewingText.title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="min-w-0 truncate text-sm font-semibold">{viewingText.title}</h3>
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setViewingText(null)}>Close</Button>
        </div>
        {viewingText.markdown
          ? <div className="min-h-0 flex-1 overflow-auto p-4 text-sm"><ChatMarkdown text={viewingText.text} /></div>
          : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">{viewingText.text}</pre>}
      </div>
    </div>}
  </Card>;
}


