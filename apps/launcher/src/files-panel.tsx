import { useEffect, useState } from "react";
import { ArrowUp, File, Folder, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button";
import { useApi } from "./api/context";
import { ErrorLine } from "./session-alerts-view";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

function parentOf(path: string) {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return at > 2 ? trimmed.slice(0, at) : trimmed;
}

/** Browse the session workspace from the pane. */
export function FilesPanel({ path }: { path: string }) {
  const api = useApi();
  const [current, setCurrent] = useState(path);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(target: string) {
    try {
      setError(null);
      const next = await api.files.list(target);
      setEntries(next as Entry[]);
      setCurrent(target);
    } catch (failure) {
      setError(String(failure));
      setEntries([]);
    }
  }

  useEffect(() => { setCurrent(path); void load(path); }, [path]);

  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label="Up one folder" title="Up one folder" onClick={() => { const parent = parentOf(current); if (parent !== current) void load(parent); }}><ArrowUp className="size-3.5" /></Button>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={current}>{current}</span>
      <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label="Refresh files" title="Refresh" onClick={() => void load(current)}><RefreshCw className="size-3.5" /></Button>
    </div>
    {error && <div className="p-2"><ErrorLine raw={error} failed="Could not list this folder." /></div>}
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {entries?.map(entry => <button
        key={entry.path}
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
        onClick={() => { if (entry.isDir) void load(entry.path); else void api.native.reveal(entry.path).catch(() => {}); }}
      >
        {entry.isDir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {!entry.isDir && <span className="shrink-0 text-[10px] text-muted-foreground">{Math.round(entry.size / 1024)} KB</span>}
      </button>)}
      {entries && !entries.length && <p className="px-2 py-2 text-xs text-muted-foreground">This folder is empty.</p>}
      {!entries && !error && <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>}
    </div>
  </div>;
}
