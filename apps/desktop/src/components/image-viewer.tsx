import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "./ui/button";
import { useChatText } from "../chat-text";

export interface ViewerAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

/**
 * A top-level image viewer: rendered into <body>, pans, zooms and carries the
 * actions the caller supplies. The actions are content data, not viewer code,
 * so any tool can reuse the viewer with its own actions.
 */
export function ImageViewer({ src, alt, title, actions = [], onClose }: { src: string; alt: string; title?: string; actions?: ViewerAction[]; onClose: () => void }) {
  const t = useChatText();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title ?? t.imageViewer} className="fixed inset-0 z-[100] flex flex-col bg-black/92 text-white">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-sm text-white/80">{title}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions.map(action => <Button key={action.id} variant="ghost" className="size-8 p-0 text-white hover:bg-white/15" title={action.label} aria-label={action.label} onClick={action.onSelect}>{action.icon}</Button>)}
          <Button variant="ghost" className="size-8 p-0 text-white hover:bg-white/15" title={t.close} aria-label={t.close} onClick={onClose}><X className="size-4" /></Button>
        </div>
      </header>
      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onWheel={event => setScale(value => clamp(value * (event.deltaY < 0 ? 1.12 : 0.89)))}
        onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) setOffset({ x: drag.current.ox + (event.clientX - drag.current.x), y: drag.current.oy + (event.clientY - drag.current.y) }); }}
        onPointerUp={() => { drag.current = null; }}
        onDoubleClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{ transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-2 py-3">
        <Button variant="ghost" className="size-8 p-0 text-white hover:bg-white/15" title={t.zoomOut} aria-label={t.zoomOut} onClick={() => setScale(value => clamp(value / 1.25))}><Minus className="size-4" /></Button>
        <span className="w-16 text-center text-xs tabular-nums text-white/70">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" className="size-8 p-0 text-white hover:bg-white/15" title={t.zoomIn} aria-label={t.zoomIn} onClick={() => setScale(value => clamp(value * 1.25))}><Plus className="size-4" /></Button>
        <Button variant="ghost" className="size-8 p-0 text-white hover:bg-white/15" title={t.reset} aria-label={t.reset} onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><RotateCcw className="size-4" /></Button>
      </footer>
    </div>,
    document.body,
  );
}
