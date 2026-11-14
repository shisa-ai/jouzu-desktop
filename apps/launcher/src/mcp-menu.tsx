import { useEffect, useRef, useState } from "react";
import { useApi } from "./api/context";
import { ChevronDown, Circle, LoaderCircle, Plug, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button";
import { ErrorLine } from "./session-alerts-view";

interface McpServer {
  name: string;
  transport: string;
}
interface McpConfig {
  path: string;
  exists: boolean;
  servers: McpServer[];
}

/** Header status only: configured MCP servers and their transport. Editing is
 * intentionally left to the agent and the config file, not a desktop JSON editor. */
export function McpMenu({ onReload, onAsk }: { onReload: () => void; onAsk?: () => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    setError("");
    try { setConfig(await api.mcp.servers() as McpConfig); }
    catch (failure) { setError(String(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (open) void load(); }, [open]);

  const count = config?.servers?.length ?? 0;
  if (!loading && count === 0) return null;
  return <div ref={root} className="relative">
    <button type="button" onClick={() => setOpen(value => !value)} aria-label={`MCP servers (${count})`} aria-haspopup="dialog" aria-expanded={open} className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/50 ${count ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      <Plug className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap" aria-live="polite">{count} MCP</span>
      <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    {open && <div role="dialog" aria-label="MCP servers" className="absolute right-0 top-full z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Plug className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-semibold">MCP servers</span>
      </div>
      {loading && <div role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading…</div>}
      {error && <div className="border-b border-border p-2"><ErrorLine raw={error} failed="Could not read the MCP servers." /></div>}
      {!loading && !error && <div className="max-h-[min(24rem,60vh)] overflow-y-auto px-3 py-2">
        {config?.servers.map(server => <div key={server.name} className="flex items-center gap-2 border-b border-border py-1.5 last:border-0">
          <Circle className="size-2.5 shrink-0 fill-primary text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs">{server.name}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{server.transport}</span>
        </div>)}
      </div>}
      <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-2">
        {onAsk && <Button variant="outline" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => { setOpen(false); onAsk(); }}>Ask Jouzu</Button>}
        <Button variant="outline" className="h-7 shrink-0 gap-1.5 px-2 text-[11px]" onClick={() => { setOpen(false); onReload(); }}><RefreshCw className="size-3" />Reload</Button>
      </div>
    </div>}
  </div>;
}
