import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown } from "lucide-react";
import { Button } from "./components/ui/button";
import { ChatMarkdown } from "./chat-markdown";
import { HostAttachmentImage, MessageImage } from "./message-image";
import { WorkspaceContext } from "./workspace-context";
import { turnAt, type ChatMessage, type ChatProjection } from "./chat-projection";
import type { OutboxItem } from "./chat-types";
import { fill, codeText, replyReason, useChatText, type ChatText } from "./chat-text";
import { DetailsPopover, type ControlResult } from "./control-result";
import { ToolRenderer } from "./tool-renderers";
import { ActivityStrip, isRichTool, type ActivityItem } from "./tool-renderers/tool-chip";
import { TurnFooter } from "./turn-footer";
import { TurnSummary } from "./turn-summary-card";
import { summarizeTurn } from "./turn-summary";

function messagePreview(message: ChatMessage, t: ChatText) {
  const text = message.content.map(block => block.type === "text" ? block.text ?? "" : block.type === "thinking" ? block.thinking ?? "" : "").join(" ").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || t.turn;
}

function turnStart(messages: ChatMessage[], end: number) {
  let start = end;
  while (start >= 0 && messages[start].role !== "user") start--;
  return start;
}
function turnPrompt(messages: ChatMessage[], end: number) {
  const start = turnStart(messages, end);
  return (messages[start]?.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("\n").trim();
}
function turnUsageAt(messages: ChatMessage[], end: number) {
  let start = end;
  while (start >= 0 && messages[start].role !== "user") start--;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (let index = Math.max(0, start); index <= end; index++) {
    const item = messages[index].usage;
    if (!item) continue;
    usage.input += item.input ?? 0;
    usage.output += item.output ?? 0;
    usage.cacheRead += item.cacheRead ?? 0;
    usage.cacheWrite += item.cacheWrite ?? 0;
    usage.total += item.total ?? item.totalTokens ?? (item.input ?? 0) + (item.output ?? 0) + (item.cacheRead ?? 0) + (item.cacheWrite ?? 0);
  }
  return { usage, startedAt: messages[start]?.timestamp };
}
function FinalTurnFooter({ messages, index, message, complete, onFork, forkDisabled = false, forkResult }: { messages: ChatMessage[]; index: number; message: ChatMessage; complete: boolean; onFork?: (prompt: string, turn: number) => void; forkDisabled?: boolean; forkResult?: { turn: number; result: ControlResult } | null }) {
  const metrics = turnUsageAt(messages, index);
  // A branch names the user turn, which stays right whatever part of the history is loaded (#20).
  const turn = turnAt(messages, index, complete);
  return <TurnFooter message={message} usage={metrics.usage} startedAt={metrics.startedAt} onFork={onFork && turn !== undefined ? () => onFork(turnPrompt(messages, index), turn) : undefined} forkDisabled={forkDisabled} forkResult={forkResult && forkResult.turn === turn ? forkResult.result : undefined} />;
}

/**
 * Consecutive text tools become one row of icons. Rich results (images, Flow,
 * tasks, background work, subagents) keep their own card; nothing is dropped.
 */
function contentParts(message: ChatMessage, index: number, projection: ChatProjection, reasoningLive: boolean, t: ChatText) {
  const parts: ReactNode[] = [];
  const activity: ActivityItem[] = [];
  message.content.forEach((block, position) => {
    if (block.type === "text") {
      parts.push(<ChatMarkdown key={position} text={block.text ?? ""} />);
      return;
    }
    if (block.type === "thinking") {
      // Reasoning the status line is showing (the host says the step is reasoning)
      // is not repeated here; all other reasoning stays in place.
      const streaming = reasoningLive && projection.running && projection.activeMessage === index && position === message.content.length - 1;
      if (!streaming) {
        activity.push({ kind: "thinking", id: `thinking-${index}-${position}`, text: block.thinking ?? "", streaming: false });
      }
      return;
    }
    if (block.type === "image" && block.attachment) {
      parts.push(<HostAttachmentImage key={position} attachment={block.attachment} alt={t.conversationAttachment} />);
      return;
    }
    if (block.type === "image" && typeof block.data === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType ?? "")) {
      parts.push(<MessageImage key={position} kind="block" source={`data:${block.mimeType};base64,${block.data}`} alt={t.conversationAttachment} />);
      return;
    }
    if (block.type === "toolCall") {
      const tool = projection.tools[block.id ?? ""];
      if (!tool) {
        activity.push({
          kind: "tool",
          tool: {
            id: block.id ?? `pending-${index}-${position}`,
            name: block.name ?? t.toolCall,
            args: block.arguments,
            phase: projection.running ? "running" : "complete",
          },
        });
      } else if (isRichTool(tool)) {
        parts.push(<ToolRenderer key={position} tool={tool} />);
      } else {
        activity.push({ kind: "tool", tool });
      }
      return;
    }
    parts.push(<p key={position} className="text-xs text-muted-foreground">Unsupported content: {block.type}</p>);
  });
  return { parts, activity };
}

function UserContent({ message }: { message: ChatMessage }) {
  const t = useChatText();
  return <>{message.content.map((block, position) => {
    if (block.type === "text") return <ChatMarkdown key={position} text={block.text ?? ""} />;
    if (block.type === "image" && block.attachment) return <HostAttachmentImage key={position} attachment={block.attachment} alt={t.conversationAttachment} />;
    if (block.type === "image" && typeof block.data === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType ?? "")) {
      return <MessageImage key={position} kind="block" source={`data:${block.mimeType};base64,${block.data}`} alt={t.conversationAttachment} />;
    }
    return null;
  })}</>;
}

/**
 * A message the host has not confirmed: shown at once, and marked "not sent" on
 * failure with why, Retry and Discard on the message itself. Its text is never lost.
 */
function OutboxRow({ item, onRetry, onDiscard }: { item: OutboxItem; onRetry?: (clientMessageId: string) => void; onDiscard?: (clientMessageId: string) => void }) {
  const t = useChatText();
  const failed = item.state === "failed";
  const reason = item.code ? codeText(t, item.code) : undefined;
  return <article data-slot="user-message" aria-label="user message" data-outbox={item.state} className={`ml-6 rounded-xl border px-4 py-2 text-left ${failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/50 opacity-70"}`}>
    <div data-slot="user-label" className="mb-2 text-xs font-medium text-muted-foreground">{t.you}</div>
    {item.text && <ChatMarkdown text={item.text} />}
    {item.images.map((image, index) => <MessageImage key={index} kind="block" source={`data:${image.mimeType};base64,${image.data}`} alt={t.conversationAttachment} />)}
    {failed
      ? <div role="alert" data-send-failed className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-destructive">
        <span className="min-w-0 flex-1">{t.notSent}{reason ? ` · ${reason}` : ""}</span>
        {item.error && <DetailsPopover details={item.error} />}
        {onRetry && <Button type="button" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onRetry(item.clientMessageId)}>{t.retry}</Button>}
        {onDiscard && <Button type="button" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onDiscard(item.clientMessageId)}>{t.discard}</Button>}
      </div>
      : <p className="mt-1 text-[11px] text-muted-foreground">{t.sending}</p>}
  </article>;
}

/** The session's history beyond what is loaded: earlier pages read on request (#20). */
export interface EarlierHistory { more: boolean; loading: boolean; load: () => void }

function ChatConversationView({ projection, reasoningLive = false, workspace, busy = false, pendingUser = "", outbox = [], onRetrySend, onDiscardSend, onFork, forkResult, history, onOpenArtifacts, changedFiles = [], replyAction }: { projection: ChatProjection; reasoningLive?: boolean; workspace?: string; busy?: boolean; pendingUser?: string; outbox?: readonly OutboxItem[]; onRetrySend?: (clientMessageId: string) => void; onDiscardSend?: (clientMessageId: string) => void; onFork?: (prompt: string, turn: number) => void; forkResult?: { turn: number; result: ControlResult } | null; history?: EarlierHistory; onOpenArtifacts?: () => void; changedFiles?: readonly string[]; /** What recovers the latest failed reply (Retry, Sign in, Remove images…), when anything does. */ replyAction?: { label: string; run: () => void; disabled?: boolean } }) {
  const t = useChatText();
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [limit, setLimit] = useState(30);
  const pinToBottom = () => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; };
  useEffect(() => {
    // A session mounts with its newest turn visible. Markdown, images, and collapsed
    // tool output grow after the first layout, so keep pinning until the user scrolls.
    following.current = true;
    const target = content.current;
    if (!target) return;
    const first = requestAnimationFrame(pinToBottom);
    const second = requestAnimationFrame(pinToBottom);
    const observer = new ResizeObserver(() => { if (following.current) requestAnimationFrame(pinToBottom); });
    observer.observe(target);
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); observer.disconnect(); };
  }, []);
  useEffect(() => { pinToBottom(); }, [projection]);
  const visible = projection.messages.flatMap((message, index) => message.role === "user" || message.role === "assistant" ? [{ message, index }] : []);
  const shown = visible.slice(-limit);
  // Keys stay with their message when earlier pages are put in front.
  const key = (index: number) => (projection.firstIndex ?? 0) + index;
  const complete = history ? !history.more : false;
  const turnMarkers = visible.flatMap((item, position) => {
    if (item.message.role !== "user") return [];
    const nextUser = visible.findIndex((candidate, candidatePosition) => candidatePosition > position && candidate.message.role === "user");
    const response = visible.slice(position + 1, nextUser < 0 ? visible.length : nextUser).find(candidate => candidate.message.role === "assistant");
    return [{ index: item.index, prompt: messagePreview(item.message, t), response: response ? messagePreview(response.message, t) : "" }];
  });
  const loadedIndexes = new Set(shown.map(item => item.index));
  const lastTurn = Math.max(0, turnMarkers.length - 1);
  const [activeTurn, setActiveTurn] = useState(0);
  const articleRefs = useRef(new Map<number, HTMLElement>());
  const railRef = useRef<HTMLElement>(null);
  const pendingJump = useRef<number | null>(null);
  useEffect(() => { if (following.current) setActiveTurn(lastTurn); }, [lastTurn]);
  useEffect(() => {
    const rail = railRef.current;
    const mark = rail?.querySelector<HTMLElement>(`[data-turn-index="${activeTurn}"]`);
    if (!rail || !mark) return;
    if (mark.offsetTop < rail.scrollTop) rail.scrollTop = mark.offsetTop;
    else if (mark.offsetTop + mark.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = mark.offsetTop + mark.offsetHeight - rail.clientHeight;
  }, [activeTurn]);
  useEffect(() => {
    if (pendingJump.current === null) return;
    const element = articleRefs.current.get(pendingJump.current);
    if (!element) return;
    pendingJump.current = null;
    following.current = false;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    setShowLatest(true);
  }, [shown]);
  function jumpToTurn(index: number) {
    const position = turnMarkers.findIndex(turn => turn.index === index);
    if (position < 0) return;
    const element = articleRefs.current.get(index);
    if (element) {
      following.current = false;
      element.scrollIntoView({ block: "start", behavior: "smooth" });
      setActiveTurn(position);
      setShowLatest(true);
      return;
    }
    pendingJump.current = index;
    setActiveTurn(position);
    setLimit(value => Math.max(value, visible.length - position + 1));
  }
  const rows: ReactNode[] = [];
  for (let cursor = 0; cursor < shown.length;) {
    const group = [shown[cursor]];
    cursor += 1;
    while (cursor < shown.length && shown[cursor].message.role !== "user") {
      group.push(shown[cursor]);
      cursor += 1;
    }
    const user = group.find(item => item.message.role === "user");
    if (user) {
      rows.push(<article data-slot="user-message" key={key(user.index)} ref={node => { if (node) articleRefs.current.set(user.index, node); else articleRefs.current.delete(user.index); }} aria-label="user message" className="ml-6 rounded-xl border border-border bg-muted/50 px-4 py-2 text-left [content-visibility:auto] [contain-intrinsic-size:auto_160px]">
        <div data-slot="user-label" className="mb-2 text-xs font-medium text-muted-foreground">{t.you}</div>
        <UserContent message={user.message} />
      </article>);
    }
    const parts: ReactNode[] = [];
    const activity: ActivityItem[] = [];
    let last: (typeof shown)[number] | undefined;
    for (const item of group) {
      if (item.message.role === "user") continue;
      const split = contentParts(item.message, item.index, projection, reasoningLive, t);
      parts.push(...split.parts);
      activity.push(...split.activity);
      last = item;
    }
    if (parts.length || activity.length) rows.push(<article data-slot="assistant-message" key={`turn-${key(group[0].index)}`} aria-label="assistant message" ref={node => { if (node) articleRefs.current.set(group[0].index, node); else articleRefs.current.delete(group[0].index); }} className="space-y-2">{parts}{activity.length > 0 && <ActivityStrip items={activity} />}</article>);
    if (last) {
      const nextMessage = projection.messages[last.index + 1];
      const turnEnd = !nextMessage || nextMessage.role === "user";
      // The reply's own failure, on the reply: the model's words stay behind it.
      // Stop is the user's own choice, not an error; the status line says t.interrupted.
      // A turn still running is not over: the runtime may be retrying a failed
      // request, and only its last attempt is the reply's outcome.
      const ended = !(projection.running && !nextMessage);
      if (ended && last.message.errorMessage && last.message.stopReason !== "aborted") {
        // The latest reply is the one that can be recovered; earlier ones are just marked.
        const action = !nextMessage ? replyAction : undefined;
        rows.push(<div key={`error-${key(last.index)}`} role="alert" data-reply-failed data-reply-error={last.message.errorCode ?? "other"} className="flex min-h-8 items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{replyReason(t, last.message.errorCode)}</span>
          <DetailsPopover details={last.message.errorMessage} />
          {action && <Button type="button" variant="outline" className="h-6 shrink-0 px-2 text-[10px]" disabled={action.disabled} onClick={action.run}>{action.label}</Button>}
        </div>);
      }
      if (turnEnd && !projection.running && !busy && !last.message.content.some(block => block.type === "toolCall") && last.message.stopReason !== "toolUse") {
        // The workspace diff belongs to the latest turn only (#79); earlier turns list
        // what their own tool calls show.
        rows.push(<div key={`footer-${key(last.index)}`}><TurnSummary data={summarizeTurn(projection.messages, projection.tools, last.index, nextMessage ? [] : changedFiles)} workspace={workspace} onOpenArtifacts={onOpenArtifacts} /><FinalTurnFooter messages={projection.messages} index={last.index} message={last.message} complete={complete} onFork={onFork} forkDisabled={busy} forkResult={forkResult} /></div>);
      }
    }
  }
  return <WorkspaceContext.Provider value={workspace}>
    <section data-slot="conversation" aria-label={t.conversation} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-8" onScroll={event => { const view = event.currentTarget; following.current = view.scrollHeight - view.scrollTop - view.clientHeight < 80; setShowLatest(!following.current); if (turnMarkers.length) { const max = view.scrollHeight - view.clientHeight; const ratio = max > 0 ? Math.min(1, Math.max(0, view.scrollTop / max)) : 0; setActiveTurn(Math.min(turnMarkers.length - 1, Math.round(ratio * (turnMarkers.length - 1)))); } }}>
      {!visible.length && <div className="mx-auto max-w-xl py-16 text-center"><h2 className="text-xl font-semibold">{t.workOnTitle}</h2><p className="mt-3 text-sm text-muted-foreground">{t.workOnHint}</p></div>}
      {visible.length > shown.length
        ? <div className="mx-auto mb-4 flex max-w-3xl justify-center"><Button variant="outline" className="h-7 px-3 text-xs" onClick={() => setLimit(value => value + 50)}>Show {visible.length - shown.length} earlier message{visible.length - shown.length === 1 ? "" : "s"}</Button></div>
        : history?.more && <div className="mx-auto mb-4 flex max-w-3xl justify-center"><Button variant="outline" className="h-7 px-3 text-xs" disabled={history.loading} onClick={() => { setLimit(value => Math.max(value, visible.length) + 50); history.load(); }}>{history.loading ? t.loadingEarlier : t.loadEarlier}</Button></div>}
      <div data-slot="conversation-column" ref={content} className="mx-auto max-w-3xl space-y-3">{rows}
        {outbox.map(item => <OutboxRow key={item.clientMessageId} item={item} onRetry={onRetrySend} onDiscard={onDiscardSend} />)}
        {pendingUser && <article data-slot="user-message" aria-label="user message" className="ml-6 rounded-xl border border-border bg-muted/50 px-4 py-2 text-left opacity-70">
          <div data-slot="user-label" className="mb-2 text-xs font-medium text-muted-foreground">{t.you}</div>
          <ChatMarkdown text={pendingUser} />
        </article>}
      </div>
      {showLatest && <div className="pointer-events-none sticky bottom-0 flex justify-end pt-3"><Button variant="outline" className="pointer-events-auto shadow" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setShowLatest(false); }}><ArrowDown />{t.latest}</Button></div>}
    </div>
    {turnMarkers.length >= 2 && <nav ref={railRef} aria-label={t.conversationTurns} className="absolute right-3 top-1/2 z-10 max-h-[min(420px,calc(100%_-_4rem))] w-7 -translate-y-1/2 overflow-y-auto overscroll-contain py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {turnMarkers.map((turn, position) => {
        const active = position === activeTurn;
        const loaded = loadedIndexes.has(turn.index);
        return <button key={turn.index} type="button" data-turn-index={position} title={`${fill(t.turnN, { n: position + 1 })}: ${turn.prompt}${turn.response ? `\n${turn.response}` : ""}`} aria-label={fill(t.jumpToTurn, { n: position + 1, prompt: turn.prompt })} aria-current={active ? "true" : undefined} onClick={() => jumpToTurn(turn.index)} className="group/turn flex h-2.5 w-7 shrink-0 items-center justify-end">
          <span className={`block h-0.5 origin-right rounded-sm transition-[transform,background-color,opacity] duration-150 ${active ? "w-5 scale-x-100 bg-foreground" : loaded ? "w-5 scale-x-[.6] bg-border group-hover/turn:scale-x-[.9] group-hover/turn:bg-muted-foreground" : "w-5 scale-x-[.4] bg-border opacity-60"}`} />
        </button>;
      })}
    </nav>}
    </section>
  </WorkspaceContext.Provider>;
}
export const ChatConversation = memo(ChatConversationView);



