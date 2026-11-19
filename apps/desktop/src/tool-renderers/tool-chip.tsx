import { useId, useState } from "react";
import {
  Brain, FilePenLine, FilePlus2, FileText, FolderOpen, Globe, ListChecks,
  Search, Terminal, Wrench, X,
} from "lucide-react";
import type { ToolView } from "../chat-projection";
import { ChatMarkdown } from "../chat-markdown";
import { ToolRenderer } from "./index";
import { ToolDetailContext, type ToolState } from "./tool-frame";
import { useChatText } from "../chat-text";

export type ActivityItem =
  | { kind: "tool"; tool: ToolView }
  | { kind: "thinking"; id: string; text: string; streaming: boolean };

/** Images need their visual result in the transcript; everything else is a chip. */
export function isRichTool(tool: ToolView): boolean {
  return tool.name === "generate_image";
}

export function toolState(tool: ToolView): ToolState {
  return tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
}

const ICONS: Record<string, typeof Wrench> = {
  bash: Terminal,
  powershell: Terminal,
  read: FileText,
  write: FilePlus2,
  edit: FilePenLine,
  multiedit: FilePenLine,
  apply_patch: FilePenLine,
  grep: Search,
  find: Search,
  ls: FolderOpen,
  web_fetch: Globe,
  batch_web_fetch: Globe,
  "tff-search_web": Search,
  compact_context: ListChecks,
  schedule_prompt: ListChecks,
};

function stateDot(state: ToolState) {
  return state === "running" ? "animate-pulse bg-primary"
    : state === "error" ? "bg-destructive"
      : state === "warning" ? "bg-amber-500"
        : "bg-emerald-500";
}

function itemKey(item: ActivityItem) {
  return item.kind === "tool" ? item.tool.id : item.id;
}

function itemLabel(item: ActivityItem) {
  if (item.kind === "thinking") return item.streaming ? "Thinking · running" : "Thinking · done";
  return `${item.tool.name} · ${toolState(item.tool) === "error" ? "failed" : toolState(item.tool)}`;
}

/** Thinking and tool calls share one 32 px activity strip; only the expanded
 * item takes vertical space. */
export function ActivityStrip({ items }: { items: ActivityItem[] }) {
  const t = useChatText();
  const [openId, setOpenId] = useState<string | null>(null);
  const detailId = useId();
  const open = openId ? items.find(item => itemKey(item) === openId) : undefined;
  return <div className="my-1.5 space-y-1.5">
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.activity}>
      {items.map(item => {
        const state = item.kind === "thinking" ? (item.streaming ? "running" : "done") : toolState(item.tool);
        const Icon = item.kind === "thinking" ? Brain : ICONS[item.tool.name] ?? Wrench;
        const label = itemLabel(item);
        const id = itemKey(item);
        return <button
          key={id}
          type="button"
          aria-label={label}
          aria-expanded={id === openId}
          aria-controls={id === openId ? detailId : undefined}
          title={label}
          onClick={() => setOpenId(id === openId ? null : id)}
          className={`relative inline-flex size-8 items-center justify-center rounded-md border transition-colors ${
            state === "running" ? "border-primary/50 text-primary"
              : state === "error" ? "border-destructive/50 text-destructive"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          } ${id === openId ? "bg-muted text-foreground" : "bg-muted/20"}`}
        >
          <Icon className="size-4" aria-hidden="true" />
          <span className={`absolute -right-0.5 -top-0.5 size-2 rounded-full border border-background ${stateDot(state)}`} aria-hidden="true" />
        </button>;
      })}
    </div>
    {open && <div id={detailId} className="rounded-lg border border-border bg-background/60">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="truncate text-[11px] font-medium">{open.kind === "thinking" ? t.thinking : open.tool.name}</span>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t.closeActivity} onClick={() => setOpenId(null)}><X className="size-3" /></button>
      </div>
      <div className="p-2 text-xs">
        {open.kind === "thinking"
          ? <ChatMarkdown text={open.text} />
          : <ToolDetailContext.Provider value><ToolRenderer tool={open.tool} /></ToolDetailContext.Provider>}
      </div>
    </div>}
  </div>;
}

/** Small compatibility wrapper for callers that only have tools. */
export function ToolChipGroup({ tools }: { tools: ToolView[] }) {
  return <ActivityStrip items={tools.map(tool => ({ kind: "tool" as const, tool }))} />;
}
