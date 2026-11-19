import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A compact stat trigger with a DSH-style detail card. The card is portalled to
 * the body and placed from the trigger's rectangle, so neither a scrolling
 * transcript nor the window edge can cut it off.
 */
export function StatPopover({ label, children, align = "left" }: { label: ReactNode; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const place = useCallback(() => {
    const trigger = root.current?.getBoundingClientRect();
    const element = card.current;
    if (!trigger || !element) return;
    const margin = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    // Above the trigger when it fits, otherwise below, clamped to the window.
    let top = trigger.top - height - margin;
    if (top < margin) top = Math.min(trigger.bottom + margin, window.innerHeight - height - margin);
    let left = align === "right" ? trigger.right - width : trigger.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    setPosition({ left, top });
  }, [align]);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const follow = () => place();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => { window.removeEventListener("scroll", follow, true); window.removeEventListener("resize", follow); };
  }, [open, place]);
  return <span ref={root} className="relative inline-flex min-w-0">
    <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} className="inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted/60">{label}</button>
    {open && createPortal(<div ref={card} role="dialog" aria-modal="false" style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }} className="fixed z-50 max-h-[70vh] w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border border-border bg-card p-3 text-xs text-foreground shadow-xl">{children}</div>, document.body)}
  </span>;
}
export function StatRow({ label, value, mono = false }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return <div className="flex items-start justify-between gap-3 py-1"><dt className="text-muted-foreground">{label}</dt><dd className={`select-text text-right ${mono ? "font-mono" : ""}`}>{value}</dd></div>;
}
export function StatCard({ title, value, children }: { title: ReactNode; value?: ReactNode; children: ReactNode }) {
  return <>
    <div className="flex items-start justify-between gap-3 border-b border-border pb-2"><h3 className="font-medium">{title}</h3>{value !== undefined && <span className="select-text font-medium tabular-nums">{value}</span>}</div>
    <dl className="pt-1">{children}</dl>
  </>;
}
