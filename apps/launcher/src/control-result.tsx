import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "./components/ui/button";
import { useChatText } from "./chat-text";

/**
 * What the last use of one control did, shown at that control and nowhere else
 * (ui-layer §4): a failure stays until the control is used again; it never
 * becomes a session message, and nothing else in the session changes.
 */
export interface ControlResult {
  ok: boolean;
  /** Localized: what happened. */
  text: string;
  /** The original text (never translated), behind Details. */
  details?: string;
  /** The one follow-up the result offers (for example "Show file"). */
  action?: { label: string; run: () => void };
}

/** The controls in a session whose results are shown at the control itself. */
export type SessionControl = "send" | "model" | "stop" | "commands" | "flow" | "textguard" | "branch" | "queue";

/**
 * A fixed-size mark beside a control: a check or a warning icon. Its words are
 * the tooltip; pressing it shows them with Details and the follow-up action in a
 * popover, so nothing around it moves or grows.
 */
export function ResultMark({ result, align = "right", side = "top" }: { result?: ControlResult | null; align?: "left" | "right"; side?: "top" | "bottom" }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => { setOpen(false); }, [result]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (!result) return null;
  const Icon = result.ok ? Check : AlertTriangle;
  return <span ref={root} className="relative inline-flex shrink-0">
    <button type="button" data-result={result.ok ? "ok" : "failed"} aria-label={result.text} title={result.text} aria-expanded={open} onClick={() => setOpen(value => !value)} className={`flex size-6 items-center justify-center rounded ${result.ok ? "text-primary" : "text-destructive"} hover:bg-muted/60`}>
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
    {open && <span role={result.ok ? "status" : "alert"} className={`absolute ${side === "top" ? "bottom-full mb-1" : "top-full mt-1"} ${align === "right" ? "right-0" : "left-0"} z-50 block w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-2 text-left text-[11px] text-foreground shadow-xl`}>
      <span className="block break-words">{result.text}</span>
      {result.action && <Button type="button" variant="outline" className="mt-1.5 h-6 px-2 text-[10px]" onClick={() => { setOpen(false); result.action?.run(); }}>{result.action.label}</Button>}
      {result.details && <span className="mt-1.5 block">
        <span className="block text-[10px] text-muted-foreground">{t.details}</span>
        <pre className="mt-0.5 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-1.5 font-mono text-[10px] text-muted-foreground">{result.details}</pre>
      </span>}
    </span>}
  </span>;
}

/** Original text behind a small Details button, in a popover so nothing moves. */
export function DetailsPopover({ details, side = "top" }: { details: string; side?: "top" | "bottom" }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return <span ref={root} className="relative inline-flex shrink-0">
    <Button type="button" variant="ghost" className="h-6 px-2 text-[10px]" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t.hideDetails : t.details}</Button>
    {open && <pre className={`absolute ${side === "top" ? "bottom-full mb-1" : "top-full mt-1"} right-0 z-50 max-h-48 w-[min(24rem,calc(100vw-2rem))] select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-popover p-2 font-mono text-[10px] text-muted-foreground shadow-xl`}>{details}</pre>}
  </span>;
}
