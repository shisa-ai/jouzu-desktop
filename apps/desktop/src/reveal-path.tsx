import { useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import { Button } from "./components/ui/button";
import { copyPath, revealPath } from "./file-actions";
import { useWorkspaceRoot } from "./workspace-context";
import { explain, fill, useChatText } from "./chat-text";

/**
 * One reveal affordance for a path that appears in the transcript (0057): the
 * file manager opens with the item selected, and the exact path stays copyable
 * even when reveal fails.
 */
export function RevealPath({ path, compact = false, label }: { path: string; compact?: boolean; label?: string }) {
  const t = useChatText();
  const workspace = useWorkspaceRoot();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const name = path.split(/[\\/]/u).pop() ?? path;

  async function reveal() {
    try {
      await revealPath(path, workspace);
      setError(null);
    } catch (failure) {
      setError(explain(t, failure, t.revealFailed).text);
    }
  }

  async function copy() {
    setCopied(await copyPath(path));
    window.setTimeout(() => setCopied(false), 1200);
  }

  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
    <Button
      variant={compact ? "ghost" : "outline"}
      className={compact ? "h-7 gap-1 px-2 text-[11px]" : "h-8 gap-1 px-2 text-xs"}
      title={fill(t.revealNamed, { name })}
      aria-label={label ?? t.reveal}
      onClick={() => void reveal()}
    ><FolderOpen className="size-3" />{label ?? t.reveal}</Button>
    <Button variant="ghost" className={compact ? "h-7 gap-1 px-2 text-[11px]" : "h-8 gap-1 px-2 text-xs"} title={t.copyPath} onClick={() => void copy()}>{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? t.copied : t.copyPath}</Button>
    {error && <span role="alert" className="text-[11px] text-destructive">{error}.</span>}
  </span>;
}