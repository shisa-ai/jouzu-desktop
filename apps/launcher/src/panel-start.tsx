import { Compass, FolderOpen, Image as ImageIcon } from "lucide-react";

interface Entry {
  id: string;
  title: string;
  description: string;
  icon: typeof ImageIcon;
  available: boolean;
}

const ENTRIES: Entry[] = [
  { id: "artifacts", title: "Artifacts", description: "Images and files produced in this session.", icon: ImageIcon, available: true },
  { id: "files", title: "Workspace files", description: "Browse files in this session's workspace.", icon: FolderOpen, available: true },
];

/** The pane's Start tab: pick which view to open, like DSH's session Start. */
export function PanelStart({ onOpen }: { onOpen: (id: string) => void }) {
  return <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
    <Compass className="size-12 text-muted-foreground/30" aria-hidden="true" />
    <div className="w-full max-w-sm space-y-1">
      {ENTRIES.map(entry => <button
        key={entry.id}
        type="button"
        disabled={!entry.available}
        onClick={() => onOpen(entry.id)}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-40"
      >
        <entry.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{entry.title}</span>
          <span className="block text-xs text-muted-foreground">{entry.description}</span>
        </span>
        {!entry.available && <span className="mt-1 text-[10px] text-muted-foreground">Soon</span>}
      </button>)}
    </div>
  </div>;
}
