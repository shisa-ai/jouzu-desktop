import { Button } from "./components/ui/button";

interface ReviewInfo {
  tool?: string;
  images?: number;
  prompt?: string;
  provider?: string;
  model?: string;
  size?: string;
}

function reviewInfo(body: string): ReviewInfo | null {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value as ReviewInfo : null;
  } catch {
    return null;
  }
}

/**
 * The generic tool review card. It renders whatever options the runtime sent, so
 * a new reviewed tool needs no new UI; only the body changes. Structured bodies
 * (the image tool) get fields; anything else falls back to plain text.
 */
export function ToolReviewDialog({ title, body, options, disabled, onSelect, onCancel }: { title: string; body: string; options: readonly string[]; disabled: boolean; onSelect: (value: string) => void; onCancel?: () => void }) {
  const info = reviewInfo(body);
  const count = info?.images ?? 1;
  return <section role="dialog" aria-modal="false" aria-label={title} className="w-full rounded-xl border border-border bg-card p-4 shadow-xl">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {info?.tool && <span className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{info.tool} · {count} image{count === 1 ? "" : "s"}</span>}
    </div>
    {info ? <>
      {info.prompt && <pre className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-sans text-[11px] leading-relaxed text-muted-foreground">{info.prompt}</pre>}
      <p className="mt-2 text-[11px] text-muted-foreground">{[info.provider, info.model, info.size].filter(Boolean).join(" · ")}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">This runs {count} paid image generation{count === 1 ? "" : "s"}.</p>
    </> : body && <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{body}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      {onCancel && <Button variant="ghost" disabled={disabled} onClick={onCancel}>Cancel</Button>}
      {options.map(option => <Button key={option} variant={option === "Approve" ? "default" : "outline"} className={option === "Deny" ? "text-destructive" : ""} disabled={disabled} onClick={() => onSelect(option)}>{option}</Button>)}
    </div>
  </section>;
}
