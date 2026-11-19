import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Check, ChevronDown, Cpu, Loader2, Download, ImagePlus, Minimize2, Plus, RefreshCw, Send, ShieldAlert, Square, Video, X } from "lucide-react";
import { IMAGE_ACCEPT, MAX_IMAGES, type ImageAttachment } from "./chat-attachments";
import type { ChatModel, ModelState } from "./chat-types";
import type { TextGuardMode } from "./session-notices";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { providerLabel } from "./provider-label";
import { ResultMark, DetailsPopover, type ControlResult, type SessionControl } from "./control-result";
import { fill, useChatText, type ChatText } from "./chat-text";


function tokenLabel(tokens: number) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Number((tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1))}k`;
}

function priceLabel(value: number) {
  return value === 0 ? "$0" : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function modelDetails(model: ChatModel) {
  const limits = [model.contextWindow ? `${tokenLabel(model.contextWindow)} ctx` : "", model.maxTokens ? `${tokenLabel(model.maxTokens)} out` : ""].filter(Boolean);
  const cost = model.cost;
  const prices = cost
    ? [cost.input !== undefined ? `${priceLabel(cost.input)}/M in` : "", cost.output !== undefined ? `${priceLabel(cost.output)}/M out` : "", cost.cacheRead !== undefined ? `${priceLabel(cost.cacheRead)}/M cached` : ""].filter(Boolean)
    : [];
  return [...limits, ...prices].join(" · ");
}

function ModelMenu({ open, onOpenChange, models, model, state, onSelect, thinkingLevel, thinkingLevels, onThinking, onSetup, result }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: readonly ChatModel[];
  model?: string;
  state: ModelState;
  onSelect: (provider: string, id: string) => void;
  thinkingLevel?: string;
  thinkingLevels: readonly string[];
  onThinking: (level: string) => void;
  onSetup?: () => void;
  /** The last model or level change, when it did not take effect. */
  result?: ControlResult;
}) {
  const t = useChatText();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open, onOpenChange]);
  // Exactly the session runtime's list: what it offers can be chosen.
  const visible = models.filter(item => `${item.provider} ${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  const providers = [...new Set(visible.map(item => item.provider))];
  return <div ref={root} className="relative flex items-center">
    {/* The button is the model: the session's, or while its runtime has not answered the
        one it is expected to report (the runtime's earlier answer). It spins only when
        nothing is known yet, and it leads to setup when the runtime has no model. */}
    <Button type="button" variant="ghost" className="h-8 gap-1 px-2 text-xs" aria-label={t.model} aria-expanded={open} disabled={state === "resolving" && !models.length} onClick={() => { if (state === "none" && !models.length) { onSetup?.(); return; } const next = !open; onOpenChange(next); if (next) setQuery(""); }}>
      {state === "resolving" && !model ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" /> : <Cpu className="size-4 shrink-0" aria-hidden="true" />}
      <span className="max-w-40 truncate">{state === "none" ? (models.length ? t.selectModel : t.setUpModel) : model ?? ""}</span>
      <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
    </Button>
    <ResultMark result={result} />
    {open && <div role="menu" aria-label={t.modelSelection} className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-2 shadow-xl">
      <Input autoFocus aria-label={t.searchModels} placeholder={t.searchModels} value={query} onChange={event => setQuery(event.target.value)} className="mb-2" />
      <div className="max-h-72 overflow-y-auto">
        {!!models.length && !visible.length && <p className="px-2 py-3 text-sm text-muted-foreground">{t.noMatchingModels}</p>}
        {providers.map(provider => <section key={provider} className="mb-2">
          <h3 className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{providerLabel(provider)}</h3>
          {visible.filter(item => item.provider === provider).map(item => <button key={`${item.provider}/${item.id}`} type="button" role="menuitemradio" aria-checked={item.name === model} onClick={() => { onSelect(item.provider, item.id); onOpenChange(false); }} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
            <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span>{modelDetails(item) && <span className="block truncate text-[10px] text-muted-foreground">{modelDetails(item)}</span>}</span>
            {item.name === model && <span className="shrink-0 text-xs text-primary">{t.current}</span>}
          </button>)}
        </section>)}
      </div>
      {thinkingLevels.length > 1 && <div className="mt-2 border-t border-border pt-2">
        <h3 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.thinking}</h3>
        <div className="flex flex-wrap gap-1 px-1">{thinkingLevels.map(level => <Button key={level} type="button" variant={level === thinkingLevel ? "outline" : "ghost"} className="h-7 px-2 text-xs" onClick={() => onThinking(level)}>{level}</Button>)}</div>
      </div>}
    </div>}
  </div>;
}

function AddMenu({ open, onOpenChange, onAddImage, onCompact, onModel, onExport, onReloadMcp, compactDisabled, exportDisabled, result }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddImage?: () => void;
  onCompact?: () => void;
  onModel: () => void;
  onExport?: () => void;
  onReloadMcp?: () => void;
  compactDisabled: boolean;
  exportDisabled: boolean;
  /** What the last command run from here (compact, export, reload) did. */
  result?: ControlResult;
}) {
  const t = useChatText();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open, onOpenChange]);
  const item = "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-45";
  return <div ref={root} className="relative flex items-center">
    <Button type="button" variant="ghost" className="size-8 p-0" aria-label={t.addOrRun} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <Plus className="size-4" />
    </Button>
    {open && <div role="menu" aria-label={t.addOrRun} className="absolute bottom-full left-0 z-30 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-2 shadow-xl">
      <h3 className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">{t.add}</h3>
      <button type="button" role="menuitem" className={item} disabled={!onAddImage} onClick={() => { onOpenChange(false); onAddImage?.(); }}>
        <ImagePlus className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0"><span className="block text-sm">{t.image}</span><span className="block text-xs text-muted-foreground">{t.attachUpTo}</span></span>
      </button>
      <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">{t.commands}</h3>
      <button type="button" role="menuitem" className={item} disabled={compactDisabled || !onCompact} onClick={() => { onOpenChange(false); onCompact?.(); }}>
        <Minimize2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0"><span className="block text-sm">{t.compact}</span><span className="block text-xs text-muted-foreground">{t.compactHint}</span></span>
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => { onOpenChange(false); onModel(); }}>
        <Cpu className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0"><span className="block text-sm">{t.model}</span><span className="block text-xs text-muted-foreground">{t.chooseSessionModel}</span></span>
      </button>
      <button type="button" role="menuitem" className={item} disabled={exportDisabled || !onExport} onClick={() => { onOpenChange(false); onExport?.(); }}>
        <Download className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0"><span className="block text-sm">{t.exportConversation}</span><span className="block text-xs text-muted-foreground">{t.exportHint}</span></span>
      </button>
      <button type="button" role="menuitem" className={item} disabled={!onReloadMcp} onClick={() => { onOpenChange(false); onReloadMcp?.(); }}>
        <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0"><span className="block text-sm">{t.reloadMcp}</span><span className="block text-xs text-muted-foreground">{t.reloadMcpHint}</span></span>
      </button>
    </div>}
    <ResultMark result={result} align="left" />
  </div>;
}

export interface ComposerProps {
  hero?: boolean;
  /** Take focus when shown: the typing place moved here (hero composer -> session composer). */
  autoFocus?: boolean;
  /** TextGuard's three modes; `alert` is the runtime's words about content it withheld. */
  textguard?: { mode: TextGuardMode; alert?: string; disabled: boolean; onMode: (mode: TextGuardMode) => void; onDismissAlert: () => void };
  /**
   * The session was ended by an error (or cannot take another message): the
   * composer's place shows why, with the one action that recovers. The only
   * thing that ever replaces the composer, and only one at a time.
   */
  blocked?: { text: string; details?: string; action?: { label: string; run: () => void; disabled?: boolean }; result?: ControlResult } | null;
  /** What the last use of each control did, shown at that control. */
  results?: Partial<Record<SessionControl, ControlResult>>;
  connected: boolean;
  pending: boolean;
  /** A setting (such as the model) is being applied: a send waits for it, other actions wait. */
  settling?: boolean;
  opening?: boolean;
  starting?: boolean;
  unavailable?: boolean;
  running: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onCompact?: () => void;
  onExport?: () => void;
  onReloadMcp?: () => void;
  attachments?: readonly ImageAttachment[];
  onAddImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  videos?: readonly string[];
  onAddVideo?: (url: string) => string | null;
  onRemoveVideo?: (url: string) => void;
  readingImages?: boolean;
  models: readonly ChatModel[];
  model?: string;
  /** The session's model as its runtime reports it; nothing is sent unless `ready`. */
  modelState: ModelState;
  onSelectModel: (provider: string, id: string) => void;
  /** No model and nothing to choose from: where models are set up. */
  onSetupModel?: () => void;
  thinkingLevel?: string;
  thinkingLevels: readonly string[];
  onThinkingLevel: (level: string) => void;
}
const textguardModes = (t: ChatText): Array<{ mode: TextGuardMode; label: string; description: string }> => [
  { mode: "on", label: t.textguardOn, description: t.textguardOnHint },
  { mode: "strict", label: t.textguardStrict, description: t.textguardStrictHint },
  { mode: "off", label: t.off, description: t.textguardOffHint },
];
function TextGuardControl({ control, result }: { control: NonNullable<ComposerProps["textguard"]>; result?: ControlResult }) {
  const t = useChatText();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const modes = textguardModes(t);
  const current = modes.find(item => item.mode === control.mode) ?? modes[0]!;
  const tone = control.alert ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : control.mode === "off" ? "text-amber-600" : "text-muted-foreground";
  return <div ref={ref} className="relative flex items-center">
    <Button type="button" variant="ghost" className={`h-8 gap-1.5 px-2 text-xs ${tone}`} disabled={control.disabled} aria-expanded={open} aria-haspopup="menu" aria-label={control.alert ? `TextGuard: ${current.label}. ${t.textguardAlert}` : `TextGuard: ${current.label}`} title={control.alert ? t.textguardAlert : `TextGuard: ${current.description}`} onClick={() => setOpen(value => !value)}><ShieldAlert className="size-4" />{control.mode === "on" ? "TextGuard" : `TextGuard ${current.label}`}<ChevronDown className="size-3" /></Button>
    {open && <div role="menu" aria-label={t.textguardMode} className="absolute bottom-full left-0 z-40 mb-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-xl">
      {control.alert && <div role="alert" data-textguard-alert className="mb-1 flex items-center gap-1 border-b border-border px-2 pb-1.5 pt-1 text-xs text-destructive">
        <span className="min-w-0 flex-1">{t.textguardAlert}</span>
        <DetailsPopover details={control.alert} />
        <Button type="button" variant="ghost" className="size-6 shrink-0 p-0" aria-label={t.dismiss} onClick={() => { setOpen(false); control.onDismissAlert(); }}><X className="size-3" /></Button>
      </div>}
      {modes.map(item => <button key={item.mode} type="button" role="menuitemradio" aria-checked={control.mode === item.mode} onClick={() => { setOpen(false); if (item.mode !== control.mode) control.onMode(item.mode); }} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"><span className="min-w-0 flex-1"><span className="block text-sm">{item.label}</span><span className="block text-xs text-muted-foreground">{item.description}</span></span>{control.mode === item.mode && <Check className="mt-1 size-3.5" />}</button>)}
    </div>}
    <ResultMark result={result} align="left" />
  </div>;
}
export function Composer({ hero = false, autoFocus = false, textguard, blocked, results = {}, connected, pending, settling = false, opening = false, starting = false, unavailable = false, running, draft, onDraft, onSend, onStop, onCompact, onExport, onReloadMcp, attachments = [], onAddImages, onRemoveImage, readingImages = false, videos = [], onAddVideo, onRemoveVideo, models, model, modelState, onSelectModel, onSetupModel, thinkingLevel, thinkingLevels, onThinkingLevel }: ComposerProps) {
  const t = useChatText();
  const active = running || starting;
  const imageInput = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoDraft, setVideoDraft] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  // Nothing is sent without the runtime's model; the model button next to
  // Send shows why (loading, or the way to set one up).
  // Only a runtime that reported no model stops Send; a model still on its way does not
  // (the host holds the message until it is ready).
  const noModel = modelState === "none";
  const submit = () => { if ((connected || opening) && !noModel && !unavailable && !readingImages && (draft.trim() || videos.length) && (running || starting || !pending)) onSend(); };
  const compactDisabled = !connected || pending || settling || opening || unavailable || running;
  const exportDisabled = !connected || pending || settling || opening || unavailable;
  const [commandIndex, setCommandIndex] = useState(0);
  const commands = [
    { id: "compact", label: t.compact, description: t.compactHint, disabled: compactDisabled || !onCompact, run: () => onCompact?.() },
    { id: "model", label: t.model, description: t.chooseSessionModel, disabled: !connected, run: () => setModelOpen(true) },
    { id: "export", label: t.export, description: t.exportSessionHint, disabled: exportDisabled || !onExport, run: () => onExport?.() },
    { id: "mcp-reload", label: t.reloadMcp, description: t.reloadMcpHint, disabled: !onReloadMcp, run: () => onReloadMcp?.() },
  ];
  const slashQuery = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).trim().toLowerCase() : null;
  const commandMatches = slashQuery === null ? [] : commands.filter(command => `${command.label} ${command.id} ${command.description}`.toLowerCase().includes(slashQuery));
  const runCommand = (command: typeof commands[number]) => { if (command.disabled) return; onDraft(""); command.run(); };
  const pasteFiles = (event: ClipboardEvent<HTMLElement>) => {
    if (!onAddImages) return;
    const selected = Array.from(event.clipboardData.files);
    const fallback = Array.from(event.clipboardData.items)
      .filter(item => item.kind === "file")
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);
    const files = selected.length ? selected : fallback;
    if (!files.length) return;
    event.preventDefault();
    onAddImages(files);
  };
  const frame = `relative mx-auto flex max-w-3xl flex-col gap-2 border border-border bg-card shadow-[0_8px_30px_rgba(0,0,0,0.12)] ${hero ? "rounded-3xl p-3" : "rounded-2xl p-2.5"}`;
  // The session ended: one line and the button that recovers take the composer's
  // place, laid over the composer itself (kept, hidden and inert), so they have
  // exactly its frame and height and nothing moves (#156).
  const blockedLine = blocked ? <div role="alert" aria-label={t.sessionEnded} data-session-blocked className={`${frame.replace("relative ", "")} absolute inset-0 z-10 justify-center`}>
    <div className="flex items-center gap-2 px-1">
      <span className="min-w-0 flex-1 break-words text-sm">{blocked.text}</span>
      {blocked.details && <DetailsPopover details={blocked.details} />}
      {blocked.action && <Button type="button" className="h-8 shrink-0 px-3" disabled={blocked.action.disabled} onClick={blocked.action.run}>{blocked.action.label}</Button>}
      <ResultMark result={blocked.result} />
    </div>
  </div> : null;
  return <div className={hero ? "px-0 pb-0 pt-0" : "px-3 pb-3 pt-2 sm:px-6"}>
    <div className="relative mx-auto max-w-3xl">
    {blockedLine}
    <form aria-label={t.messageComposer} aria-hidden={blocked ? true : undefined} inert={blocked ? true : undefined} onPaste={pasteFiles} className={`relative mx-auto flex max-w-3xl flex-col gap-2 border border-border bg-card shadow-[0_8px_30px_rgba(0,0,0,0.12)] focus-within:ring-1 focus-within:ring-ring ${hero ? "rounded-3xl p-3" : "rounded-2xl p-2.5"} ${blocked ? "invisible" : ""}`} onSubmit={event => { event.preventDefault(); submit(); }}>
      {!!attachments.length && <ul aria-label={t.attachedImages} className="flex flex-wrap gap-2 px-1">{attachments.map(item => <li key={item.id} className="relative max-w-36 rounded-lg border border-border p-1.5"><img src={`data:${item.image.mimeType};base64,${item.image.data}`} alt={fill(t.previewOf, { name: item.name })} className="h-16 w-24 object-contain" /><div className="flex items-center gap-1"><p className="min-w-0 flex-1 truncate text-xs" title={item.name}>{item.name}</p><Button type="button" variant="ghost" className="size-6 p-0" aria-label={fill(t.removeNamed, { name: item.name })} onClick={() => onRemoveImage?.(item.id)}><X className="size-3" /></Button></div></li>)}</ul>}
      {!!videos.length && <ul aria-label={t.attachedVideos} className="flex flex-wrap gap-2 px-1">{videos.map(url => <li key={url} className="flex max-w-full items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs"><Video className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={url}>{url}</span><Button type="button" variant="ghost" className="size-6 p-0" aria-label={fill(t.removeVideo, { url })} onClick={() => onRemoveVideo?.(url)}><X className="size-3" /></Button></li>)}</ul>}
      {videoOpen && <div className="flex items-center gap-2 px-1"><Input aria-label={t.videoUrl} placeholder="https://…/video.mp4" value={videoDraft} onChange={event => setVideoDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); const error = onAddVideo?.(videoDraft) ?? null; setVideoError(error); if (!error) { setVideoDraft(""); setVideoOpen(false); } } }} /><Button type="button" onClick={() => { const error = onAddVideo?.(videoDraft) ?? null; setVideoError(error); if (!error) { setVideoDraft(""); setVideoOpen(false); } }}>{t.add}</Button></div>}
      {videoError && <p role="alert" className="px-1 text-xs text-destructive">{videoError}</p>}
      {slashQuery !== null && commandMatches.length > 0 && <div role="menu" aria-label={t.commands} className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
        {commandMatches.map((command, index) => <button key={command.id} type="button" role="menuitem" disabled={command.disabled} onMouseEnter={() => setCommandIndex(index)} onClick={() => runCommand(command)} className={`flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left ${index === commandIndex ? "bg-accent" : ""} disabled:opacity-45`}><span className="min-w-0"><span className="block text-sm">{command.label}</span><span className="block truncate text-xs text-muted-foreground">{command.description}</span></span><span className="text-[10px] text-muted-foreground">/{command.id}</span></button>)}
      </div>}
      <textarea aria-label={t.messageJouzu} placeholder={t.messagePlaceholder} autoFocus={autoFocus} value={draft} onChange={event => { onDraft(event.target.value); setCommandIndex(0); }} rows={3} className="max-h-60 min-h-16 w-full resize-y bg-transparent px-1 text-sm outline-none" onKeyDown={event => {
        if (slashQuery !== null && commandMatches.length) {
          if (event.key === "ArrowDown") { event.preventDefault(); setCommandIndex(index => Math.min(index + 1, commandMatches.length - 1)); return; }
          if (event.key === "ArrowUp") { event.preventDefault(); setCommandIndex(index => Math.max(0, index - 1)); return; }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); runCommand(commandMatches[Math.min(commandIndex, commandMatches.length - 1)]); return; }
          if (event.key === "Escape") { event.preventDefault(); onDraft(""); return; }
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
      }} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {onAddImages && <><input ref={imageInput} type="file" accept={IMAGE_ACCEPT} multiple className="hidden" aria-label={t.chooseImages} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; onAddImages(files); }} /></>}
          {onAddVideo && <Button type="button" variant="ghost" className="size-8 p-0" aria-label={t.addVideoUrl} title={t.addVideoUrl} onClick={() => setVideoOpen(value => !value)}><Video className="size-4" /></Button>}
          <AddMenu open={addOpen} onOpenChange={setAddOpen} onAddImage={onAddImages && !readingImages && attachments.length < MAX_IMAGES ? () => imageInput.current?.click() : undefined} onCompact={onCompact} onModel={() => setModelOpen(true)} onExport={onExport} onReloadMcp={onReloadMcp} compactDisabled={compactDisabled} exportDisabled={exportDisabled || readingImages} result={results.attach ?? results.commands} />
          {textguard && <TextGuardControl control={textguard} result={results.textguard} />}
          {readingImages && <span role="status" className="text-xs text-muted-foreground">{t.readingImages}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-muted-foreground lg:inline">{!connected ? t.connecting : unavailable ? t.sessionUnavailable : opening ? t.openingSession : starting ? t.starting : pending ? t.sending : running ? t.enterToSteer : t.enterToSend}</span>
          <ModelMenu open={modelOpen} onOpenChange={setModelOpen} models={models} model={model} state={modelState} onSelect={onSelectModel} onSetup={onSetupModel} thinkingLevel={thinkingLevel} thinkingLevels={thinkingLevels} onThinking={onThinkingLevel} result={results.model} />
          {active && <Button type="button" variant="outline" className="h-8 px-2" onClick={onStop}><Square className="size-3.5" />{t.stop}</Button>}
          {active && <ResultMark result={results.stop} />}
          <Button type="submit" className="h-8 px-2" disabled={(!connected && !opening) || noModel || (pending && !running && !starting) || unavailable || readingImages || !draft.trim()}><Send className="size-3.5" />{running ? t.steer : t.send}</Button>
          <ResultMark result={results.send} />
        </div>
      </div>
    </form>
    </div>
  </div>;
}









