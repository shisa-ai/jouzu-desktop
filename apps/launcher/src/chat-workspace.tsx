import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpCircle, ArrowUpDown, Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, FolderOpen, FolderPlus, GitFork, Images, MessageSquare, MoreHorizontal, PanelLeft, Columns2, PanelRight, Pencil, Pin, Plus, RefreshCw, Search, Settings, Sparkles, X } from "lucide-react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { McpMenu } from "./mcp-menu";
import { ChatConversation } from "./chat-conversation";
import { AgentAction } from "./chat-live";
import { Composer } from "./composer";
import { clearPending, pendingFor, setPending, type PendingBySession } from "./pending-prompt";
import { changedFiles, snapshotComplete, type WorkspaceSnapshot } from "./workspace-diff";
import { loadCollapsed, saveCollapsed, toggleCollapsed } from "./sidebar-state";
import { ArtifactsPanel } from "./artifacts-panel";
import { collectOutputReferences } from "./artifact-references";
import { PanelStart } from "./panel-start";
import { FilesPanel } from "./files-panel";
import { ToolReviewDialog } from "./tool-review-dialog";
import { ChatConnection, flowNoticeText, type ChatSnapshot } from "./chat-connection";
import { chatPool } from "./chat-pool";
import { fitsSendBudget, readImageAttachment, removeSubmittedImages, validateImageSelection, type ImageAttachment } from "./chat-attachments";
import { normalizeVideoUrl, videoMarker } from "./video-url";
import { emptyProjection, historyProjection, interruptUnfinishedTools, type ChatProjection, type FlowReportRecord, type WireObject } from "./chat-projection";
import { clearDraft, draftKey, readDraft, writeDraft } from "./drafts";
import { humanizeRuntimeError, isCapacityError, isFlowHistoryError } from "./runtime-errors";
import { beginDialogResponse, emptyDialogQueue, enqueueDialog, expireDialogs, nextDialogDeadline, removeDialog, type DialogAnswer, type DialogQueue } from "./dialog-queue";
import { BackgroundMenu, deriveFlow, deriveSubagents, FlowMenu, latestFlowError, SubagentMenu } from "./tool-renderers";
import { SessionStatsBar } from "./session-stats-bar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { parseTextGuardNotice, parseTextGuardResult, TextGuardBar, type TextGuardData, type TextGuardItem } from "./textguard-bar";
import type { SessionTiming } from "./chat-connection";

type TextGuardView = { data: TextGuardData | null; seen: boolean; historical: boolean; open: boolean; busy: boolean; error: string | null; loading: boolean };
const emptyTextGuardView: TextGuardView = { data: null, seen: false, historical: false, open: false, busy: false, error: null, loading: false };

/** The side pane starts at half the window so chat and pane have equal room. */
function defaultPaneWidth() {
  return Math.min(960, Math.max(480, Math.round(window.innerWidth / 2)));
}

interface WorkspaceItem { id: string; path: string }
interface SessionSummary { path: string; title: string; workspace: string; updated: number; pinned: boolean; archived: boolean }
export interface ChatWorkspaceProps {
  path: string;
  revision?: number;
  locked?: boolean;
  newSession?: boolean;
  onStartSession?: () => void;
  onRetry?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onBootChange?: (booting: boolean) => void;
  catalogRefreshing?: boolean;
  canRefreshModels?: boolean;
  onModelsMissing?: () => void;
  onRetryModels?: () => void;
  workspaces: readonly WorkspaceItem[];
  onSelect: (path: string) => void;
  onAddFolder: () => void;
  onRemove: (id: string) => void;
  onSettings: () => void;
  onUpdate?: () => void;
  updateAvailable?: boolean;
  updateBusy?: boolean;
}
const lastSegment = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
const workspaceLabel = (path: string) => lastSegment(path) === "default-workspace" ? "Default workspace" : lastSegment(path);
const isDefaultWorkspace = (path: string) => lastSegment(path) === "default-workspace";
const normalizedPath = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
/**
 * One identity for a session wherever it is stored. The runtime's session file is
 * authoritative once attached; the selected row covers a session that is still
 * opening. Queue, pending and draft state must all agree on this key.
 */
const sessionKeyOf = (sessionFile: string | undefined, selected: string | null | undefined) => normalizedPath(sessionFile ?? selected ?? "");
/** The UUID at the end of a session file stem; a preview has no live session state. */
const sessionIdFromFile = (path?: string): string | undefined => {
  const name = path?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)?.replace(/\.jsonl$/u, "") ?? "";
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(name)?.[1];
};
function relativeTime(updated: number) {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - updated));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
// A failed attach auto-recovers a highlighted session on its own, but is bounded so a genuinely
// broken runtime cannot turn into an endless retry loop.
const AUTO_RETRY_COOLDOWN_MS = 2000;
const MAX_AUTO_RETRIES = 3;

export function ChatWorkspace({ path, revision = 0, newSession = true, locked = false, onStartSession, onRetry, onBusyChange, onBootChange, catalogRefreshing = false, canRefreshModels = false, onModelsMissing, onRetryModels, workspaces, onSelect, onAddFolder, onRemove, onSettings, onUpdate, updateAvailable = false, updateBusy = false }: ChatWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({ projection: emptyProjection(), connected: false, pending: false, error: null, models: [], thinkingLevels: [] });
  const [workingStartedAt, setWorkingStartedAt] = useState<number>();
  // A pending prompt belongs to the session that accepted it. A single value made an
  // unsettled message from one session render in every other session.
  const [pendingBySession, setPendingBySession] = useState<PendingBySession>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snapshot.projection.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.projection.running]);
  const elapsed = workingStartedAt ? `${String(Math.floor((now - workingStartedAt) / 60000)).padStart(2, "0")}:${String(Math.floor(((now - workingStartedAt) % 60000) / 1000)).padStart(2, "0")}` : undefined;
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftKeyRef = useRef("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentRef = useRef(attachments);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [queuedBySession, setQueuedBySession] = useState<Record<string, string[]>>({});
  const videoRef = useRef(videoUrls);
  videoRef.current = videoUrls;
  const [readingImages, setReadingImages] = useState(false);
  const readingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const queueSessionKey = sessionKeyOf(snapshot.sessionFile, selectedSession);
  const queuedSteers = queueSessionKey ? queuedBySession[queueSessionKey] ?? [] : [];
  const pendingUser = pendingFor(pendingBySession, queueSessionKey);
  useEffect(() => {
    if (snapshot.projection.running) return;
    const key = normalizedPath(snapshot.sessionFile ?? "");
    if (!key) return;
    setQueuedBySession(previous => {
      if (!previous[key]?.length) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, [snapshot.projection.running, snapshot.sessionFile]);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  const switchingRef = useRef(false);
  const switchingTarget = useRef<string | "new" | null>(null);
  const switchPromise = useRef<Promise<void> | null>(null);
  const [preview, setPreview] = useState<{ path: string; projection: ChatProjection } | null>(null);
  const previewRef = useRef<{ path: string; projection: ChatProjection } | null>(null);
  previewRef.current = preview;
  const previewRequest = useRef(0);
  const projectionCache = useRef(new Map<string, ChatProjection>());
  const selectedSessionRef = useRef<string | null>(null);
  selectedSessionRef.current = selectedSession;
  const autoRetryCountRef = useRef(0);
  const lastAutoRetryAtRef = useRef(0);
  const [dialogs, setDialogs] = useState(emptyDialogQueue);
  const queue = useRef(dialogs);
  const dialog = dialogs.items[0] ?? null;
  const [answer, setAnswer] = useState("");
  const [notification, setNotification] = useState("");
  // The provider refused an image already in the history; the session stays usable only
  // after the offending image is removed, so offer that instead of a dead end.
  const [imageRepair, setImageRepair] = useState(false);
  // Files the current turn actually changed. The transcript only carries edit-tool
  // arguments, so a file written by a shell command needs a workspace comparison.
  const [turnChangedFiles, setTurnChangedFiles] = useState<string[]>([]);
  const turnBaseline = useRef<WorkspaceSnapshot | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [textguardBySession, setTextguardBySession] = useState<Record<string, TextGuardView>>({});
  const textguardRef = useRef(textguardBySession);
  textguardRef.current = textguardBySession;
  const activeSessionIdRef = useRef("");
  activeSessionIdRef.current = snapshot.sessionId ?? "";
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(""), 3000);
    return () => clearTimeout(timer);
  }, [notification]);
  const [flowNotice, setFlowNotice] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const chatRoot = useRef<HTMLDivElement>(null);
  const [sidebar, setSidebarState] = useState(() => {
    try { return localStorage.getItem("jouzu.ui.sidebar") !== "closed"; } catch { return true; }
  });
  // Persist the user's choice: the workspace remounts when the app moves through
  // runtime/setup screens, and a local default would reopen it behind their back.
  const setSidebar = (value: boolean | ((current: boolean) => boolean)) => {
    setSidebarState(current => {
      const next = typeof value === "function" ? value(current) : value;
      try { localStorage.setItem("jouzu.ui.sidebar", next ? "open" : "closed"); } catch { /* UI preference only */ }
      return next;
    });
  };
  const [hero, setHero] = useState(newSession);
  // The pool owns every live session, including the ones that are not on screen;
  // the list re-renders when one of them starts or stops a turn.
  const [, setPoolStatusVersion] = useState(0);
  useEffect(() => chatPool.subscribeStatus(() => setPoolStatusVersion(value => value + 1)), []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [diskReports, setDiskReports] = useState<FlowReportRecord[]>([]);
  const [reportsSession, setReportsSession] = useState("");
  const [timing, setTiming] = useState<SessionTiming>();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsed());
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const connection = useRef<ChatConnection | null>(null);
  const unsubscribeRef = useRef<null | (() => void)>(null);
  const dialogRef = useRef<(request: WireObject, client: ChatConnection) => void>(() => {});
  const dialogQueues = useRef(new Map<ChatConnection, DialogQueue>());
  const previousNewSession = useRef(newSession);
  const newSessionOnStart = useRef(newSession);
  newSessionOnStart.current = newSession;
  const freshOnPath = useRef(false);
  const queuedSwitch = useRef<string | "new" | null>(null);
  function writeDialogs(next: DialogQueue) { queue.current = next; setDialogs(next); }
  function updateDialogs(next: DialogQueue) {
    const owner = connection.current;
    if (owner) dialogQueues.current.set(owner, next);
    writeDialogs(next);
  }
  function updateAttachments(next: ImageAttachment[]) {
    attachmentRef.current = next;
    setAttachments(next);
    saveDraft(draftRef.current, next);
  }
  function addVideoUrl(input: string): string | null {
    try {
      const url = normalizeVideoUrl(input);
      if (videoRef.current.includes(url)) return "This video URL is already attached.";
      const next = [...videoRef.current, url];
      videoRef.current = next;
      setVideoUrls(next);
      return null;
    } catch (error) {
      return String(error instanceof Error ? error.message : error);
    }
  }
  function removeVideoUrl(url: string) {
    const next = videoRef.current.filter(value => value !== url);
    videoRef.current = next;
    setVideoUrls(next);
  }
  function saveDraft(text: string, next: ImageAttachment[]) {
    const key = draftKeyRef.current;
    if (key) writeDraft(key, { text, attachments: next });
  }
  function updateDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
    saveDraft(value, attachmentRef.current);
  }
  function applyDraft(next: { text: string; attachments: ImageAttachment[] } | undefined) {
    draftRef.current = next?.text ?? "";
    setDraft(next?.text ?? "");
    attachmentRef.current = next?.attachments ?? [];
    setAttachments(next?.attachments ?? []);
    setAttachmentError(null);
  }
  function bindClient(next: ChatConnection) {
    unsubscribeRef.current?.();
    connection.current = next;
    // A dialog belongs to the runtime that raised it: the view shows the queue of
    // the client it is bound to, and a background dialog waits here until then.
    const pending = expireDialogs(dialogQueues.current.get(next) ?? emptyDialogQueue(), Date.now());
    dialogQueues.current.set(next, pending);
    writeDialogs(pending);
    unsubscribeRef.current = next.subscribe(state => {
      setSnapshot(state);
      if (!state.connected && state.error) {
        dialogQueues.current.set(next, emptyDialogQueue());
        if (connection.current === next) writeDialogs(emptyDialogQueue());
      }
    });
  }
  function updateTextGuard(sessionId: string, change: Partial<TextGuardView>) {
    setTextguardBySession(current => {
      const next = { ...current, [sessionId]: { ...(current[sessionId] ?? emptyTextGuardView), ...change } };
      textguardRef.current = next;
      return next;
    });
  }
  useEffect(() => {
    if (newSession && !previousNewSession.current) void startNewSession();
    previousNewSession.current = newSession;
  }, [newSession]);
  // A draft belongs to the workspace and the session (or its new-session slot).
  // Changing the key loads that draft; it never clears the one left behind.
  const activeDraftKey = draftKey(path, hero ? null : selectedSession ?? snapshot.sessionFile ?? null);
  useEffect(() => {
    if (draftKeyRef.current === activeDraftKey) return;
    draftKeyRef.current = activeDraftKey;
    applyDraft(readDraft(activeDraftKey));
  }, [activeDraftKey]);
  useEffect(() => {
    const selected = selectedSessionRef.current;
    const keepPreview = !!selected && !!previewRef.current && normalizedPath(previewRef.current.path) === normalizedPath(selected);
    queuedSwitch.current = selected;
    switchingRef.current = false;
    previewRequest.current += 1;
    if (!keepPreview) setPreview(null);
    setSessionError(null);
    setSwitching(false);
    if (selected) setHero(false);
    writeDialogs(emptyDialogQueue());
    setSnapshot({ projection: emptyProjection(), connected: false, pending: false, error: null, models: [], thinkingLevels: [] });
    setFlowNotice("");
    let client: ChatConnection | undefined;
    let disposed = false;
    const handleDialog = (request: WireObject, owner: ChatConnection) => {
      if (["select", "confirm", "input", "editor"].includes(String(request.method))) {
        const pending = expireDialogs(dialogQueues.current.get(owner) ?? emptyDialogQueue(), Date.now());
        const result = enqueueDialog(pending, request, Date.now());
        dialogQueues.current.set(owner, result.queue);
        if (connection.current === owner) writeDialogs(result.queue);
        if (result.status === "full" && typeof request.id === "string") {
          setNotification("Too many extension requests to display. The additional request was cancelled.");
          void owner.reply(request.id, { cancelled: true }).catch(error => {
            if (connection.current === owner) setNotification(`The additional request could not be cancelled. ${String(error)}`);
          });
        }
        else if (result.status === "invalid") setNotification("An invalid extension request could not be displayed.");
      }
      else if (request.method === "notify") {
        const message = String(request.message ?? "");
        // The runtime already raises a plain-text alert as content is withheld; it carries no
        // items, so mark the session seen and let the panel's inspect fetch the review.
        if (/^TextGuard (?:withheld|flagged)\b/u.test(message) || /^TextGuard: \d+ items? waiting for your review/u.test(message)) {
          const id = activeSessionIdRef.current;
          if (id) updateTextGuard(id, { seen: true, historical: false, error: null, loading: false });
          return;
        }
        const textguard = parseTextGuardNotice(message);
        if (textguard) {
          const id = textguard.sessionId ?? owner.snapshot.sessionId;
          if (id) {
            const view = textguardRef.current[id];
            if (!textguard.items.length && !view?.data && view?.historical) {
              updateTextGuard(id, { error: "This review is no longer available in the runtime.", loading: false, seen: true });
              return;
            }
            updateTextGuard(id, { data: textguard, seen: true, historical: false, error: null, loading: false });
          }
          return;
        }
        const textguardResult = parseTextGuardResult(message);
        if (textguardResult) {
          const id = owner.snapshot.sessionId;
          if (id) updateTextGuard(id, { error: textguardResult.ok ? null : textguardResult.error ?? "TextGuard request failed.", loading: false });
          return;
        }
        // A background session keeps working; its notices must not surface as the
        // visible session's toast or Flow notice.
        if (connection.current !== owner) return;
        const flow = flowNoticeText(message);
        if (flow) setFlowNotice(flow);
        else setNotification(message);
      }
      else if (request.method === "set_editor_text") {
        if (connection.current === owner) updateDraft(String(request.text ?? ""));
      }
    };
    void (async () => {
      try {
        const leased = await chatPool.lease(path, undefined, handleDialog, newSessionOnStart.current || freshOnPath.current);
        if (disposed) { void leased.close().catch(() => {}); return; }
        client = leased;
        dialogRef.current = handleDialog;
        bindClient(leased);
      } catch (error) {
        if (!disposed) setSnapshot(current => ({ ...current, error: String(error) }));
      }
    })();
    freshOnPath.current = false;
    return () => {
      disposed = true;
      unsubscribeRef.current?.();
      connection.current = null;
      if (client) dialogQueues.current.delete(client);
      // The same rule as every other view change: a session with a transcript is
      // kept, a blank one is closed instead of being parked under a provisional path.
      if (client?.snapshot.error) void client.close().catch(() => {});
      else parkPrevious(client ?? null);
    };
  }, [path, revision]);
  // Snapshot the workspace around each turn so the summary can report files that no
  // edit tool mentioned. A truncated snapshot is ignored rather than reported as a
  // partial list.
  useEffect(() => {
    if (!snapshot.connected) return;
    if (snapshot.projection.running) {
      if (turnBaseline.current) return;
      void invoke<WorkspaceSnapshot>("workspace_snapshot", { path })
        .then(before => { if (!turnBaseline.current) turnBaseline.current = before; })
        .catch(() => { /* The summary falls back to edit-tool arguments. */ });
      return;
    }
    const before = turnBaseline.current;
    if (!before) return;
    turnBaseline.current = null;
    void invoke<WorkspaceSnapshot>("workspace_snapshot", { path })
      .then(after => setTurnChangedFiles(snapshotComplete(before) && snapshotComplete(after) ? changedFiles(before, after) : []))
      .catch(() => setTurnChangedFiles([]));
  }, [snapshot.connected, snapshot.projection.running, path]);
  useEffect(() => { setTurnChangedFiles([]); turnBaseline.current = null; }, [path, revision]);
  // Only a live turn blocks a runtime restart. A saved draft does not: it lives in
  // localStorage and must not make a model refresh wait for the composer to empty.
  useEffect(() => { onBusyChange?.(snapshot.pending || snapshot.projection.running); }, [snapshot.pending, snapshot.projection.running, onBusyChange]);
  // The app keeps its own loader up until the entry session is connected, so the
  // workspace never opens on a second, still-blocked "Starting session…" state.
  useEffect(() => { onBootChange?.(!snapshot.connected); }, [snapshot.connected, onBootChange]);
  useEffect(() => {
    const key = normalizedPath(snapshot.sessionFile ?? "");
    if (!key) return;
    projectionCache.current.set(key, snapshot.projection);
    while (projectionCache.current.size > 8) projectionCache.current.delete(projectionCache.current.keys().next().value as string);
  }, [snapshot.sessionFile, snapshot.projection]);
  useEffect(() => {
    const current = previewRef.current;
    if (!current || normalizedPath(current.path) !== normalizedPath(snapshot.sessionFile ?? "")) return;
    // Session state is published before history. Never replace a visible transcript with
    // that empty intermediate projection; wait for the authoritative messages.
    if (!snapshot.projection.messages.length && current.projection.messages.length) return;
    setPreview({ path: current.path, projection: snapshot.projection });
  }, [snapshot.sessionFile, snapshot.projection]);
  useEffect(() => {
    if (snapshot.connected && snapshot.modelsLoaded === true && (snapshot.models?.length ?? 0) === 0 && canRefreshModels) onModelsMissing?.();
  }, [snapshot.connected, snapshot.models, snapshot.modelsLoaded, canRefreshModels, onModelsMissing]);
  useEffect(() => { setAnswer(dialog?.prefill ?? ""); }, [dialog?.id, dialog?.prefill]);
  useEffect(() => {
    const deadline = nextDialogDeadline(dialogs);
    if (deadline === null) return;
    const timer = setTimeout(() => updateDialogs(expireDialogs(queue.current, Date.now())), Math.min(2147483647, Math.max(0, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [dialogs]);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: MouseEvent) => { if (!picker.current?.contains(event.target as Node)) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [pickerOpen]);
  async function refreshSessions() {
    try { setSessions(await invoke<SessionSummary[]>("chat_sessions")); }
    catch { /* Session history is ancillary; chat remains usable. */ }
  }
  async function updateSession(sessionPath: string, change: { pinned?: boolean; archived?: boolean; title?: string }) {
    try { setSessions(await invoke<SessionSummary[]>("chat_session_update", { sessionPath, ...change })); }
    catch (error) { setNotification(String(error)); }
  }
  async function renameSession(session: SessionSummary) {
    const title = window.prompt("Rename session", session.title);
    if (title !== null) { await updateSession(session.path, { title }); setSessionMenu(null); }
  }
  async function copySessionId(session: SessionSummary) {
    const id = session.path.split(/[\\/]/u).at(-1)?.replace(/\.jsonl$/u, "") ?? session.path;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(id);
      else { const area = document.createElement("textarea"); area.value = id; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
      setNotification("Session ID copied.");
      setSessionMenu(null);
    } catch (error) { setNotification(String(error)); }
  }
  useEffect(() => {
    if (!sessionMenu) return;
    const close = (event: MouseEvent) => { if (!(event.target as Element).closest("[data-session-menu]")) setSessionMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSessionMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [sessionMenu]);
  useEffect(() => { void refreshSessions(); }, [path, revision]);
  useEffect(() => {
    if (!snapshot.connected || snapshot.projection.messages.length === 0) return;
    const timer = setTimeout(() => { void refreshSessions(); }, 500);
    return () => clearTimeout(timer);
  }, [snapshot.connected, snapshot.projection.messages.length]);
  useEffect(() => { if (snapshot.connected) void refreshSessions(); }, [snapshot.connected, snapshot.sessionFile]);
  useEffect(() => { if (snapshot.connected) void connection.current?.loadStats(); }, [snapshot.connected, snapshot.sessionFile, snapshot.projection.messages.length, snapshot.projection.running]);
  useEffect(() => {
    // Reports belong to the loaded session, not to a selected session that is still opening.
    const file = snapshot.sessionFile;
    if (!file) { setDiskReports([]); setReportsSession(""); setTiming(undefined); return; }
    setDiskReports([]); setReportsSession(file);
    let disposed = false;
    void invoke<FlowReportRecord[]>("chat_flow_reports", { sessionPath: file })
      .then(reports => { if (!disposed) setDiskReports(Array.isArray(reports) ? reports : []); })
      .catch(() => { if (!disposed) setDiskReports([]); });
    void invoke<SessionTiming>("chat_session_timing", { sessionPath: file })
      .then(value => { if (!disposed && value && typeof value.modelMs === "number") setTiming(value); })
      .catch(() => { if (!disposed) setTiming(undefined); });
    return () => { disposed = true; };
  }, [snapshot.sessionFile, snapshot.projection.messages.length]);
  async function reply(fields: DialogAnswer) {
    const client = connection.current;
    if (!dialog || !client || !snapshot.transportReady) return;
    const id = dialog.id;
    const claimed = beginDialogResponse(queue.current, id, fields, Date.now());
    updateDialogs(claimed.queue);
    if (!claimed.response) return;
    try { await client.reply(id, claimed.response); }
    catch (error) { if (connection.current === client) setNotification(`The response could not be confirmed. ${String(error)}`); }
    finally { if (connection.current === client) updateDialogs(removeDialog(queue.current, id)); }
  }
  async function addImages(files: File[]) {
    if (readingRef.current || !files.length) return;
    readingRef.current = true; setReadingImages(true); setAttachmentError(null);
    try {
      validateImageSelection(attachmentRef.current, files);
      const added = await Promise.all(files.map(readImageAttachment));
      validateImageSelection(attachmentRef.current, added.map(item => ({ size: item.size, type: item.image.mimeType })));
      if (!fitsSendBudget([...attachmentRef.current, ...added])) throw new Error("These images are too large to send together. Send fewer, or smaller ones.");
      updateAttachments([...attachmentRef.current, ...added]);
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
    finally { readingRef.current = false; setReadingImages(false); }
  }
  // "Quote" on an image artifact feeds the artifact through the same attachment
  // path as a pasted image.
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;
  useEffect(() => {
    const handler = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path !== "string" || !path) return;
      void (async () => {
        try {
          const data = await invoke<{ name: string; mimeType: string; data: string }>("read_dropped_image", { path });
          const binary = atob(data.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          await addImagesRef.current([new File([bytes], data.name, { type: data.mimeType })]);
        } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
      })();
    };
    window.addEventListener("jouzu:use-artifact", handler);
    return () => window.removeEventListener("jouzu:use-artifact", handler);
  }, []);

  async function addDropped(paths: string[]) {
    const images: File[] = [];
    const files: string[] = [];
    for (const path of paths) {
      if (!/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) { files.push(path); continue; }
      try {
        const data = await invoke<{ name: string; mimeType: string; data: string }>("read_dropped_image", { path });
        const binary = atob(data.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        images.push(new File([bytes], data.name, { type: data.mimeType }));
      } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)); }
    }
    if (images.length) await addImages(images);
    if (files.length) {
      const current = draftRef.current;
      updateDraft(`${current}${current.trim() ? "\n\n" : ""}${files.map(path => `File: ${path}`).join("\n")}`);
      setNotification(`${files.length} file${files.length === 1 ? "" : "s"} added to the message.`);
    }
  }
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscription = getCurrentWindow().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { setDropActive(false); return; }
      const rect = chatRoot.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      setDropActive(inside && payload.type !== "drop");
      if (payload.type === "drop" && inside) void addDropped(payload.paths);
    });
    subscription.then(unlisten => { if (disposed) unlisten(); }).catch(error => setNotification(String(error)));
    return () => { disposed = true; subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [path, revision]);
  async function send() {
    let client = connection.current;
    if (!client || readingRef.current) return;
    if (isFlowHistoryError(client.snapshot.error)) { setNotification("Clear Flow request history before sending again."); return; }
    const typed = draft;
    const submittedVideos = videoRef.current;
    const value = [...submittedVideos.map(videoMarker), typed].filter(Boolean).join("\n");
    const submitted = attachmentRef.current;
    const wasHero = hero;
    // Capture the owner of this send. Clearing must never depend on which session is
    // on screen when it settles, and it must never touch another session's entry.
    const pendingKey = sessionKeyOf(client.snapshot.sessionFile, selectedSession ?? path);
    const submitDraftKey = draftKeyRef.current;
    setWorkingStartedAt(Date.now());
    setPendingBySession(previous => setPending(previous, pendingKey, value));
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("The session is still opening."); return; }
      client = connection.current;
      if (!client) return;
      const running = client.snapshot.projection.running;
      const queueKey = sessionKeyOf(client.snapshot.sessionFile, selectedSession);
      if (running && queueKey) setQueuedBySession(previous => ({ ...previous, [queueKey]: [...(previous[queueKey] ?? []), value] }));
      try { await client.sendOrSteer(value, submitted.map(item => item.image), running); }
      catch (error) {
        if (running && queueKey) setQueuedBySession(previous => {
          const items = previous[queueKey] ?? [];
          const at = items.lastIndexOf(value);
          if (at < 0) return previous;
          return { ...previous, [queueKey]: [...items.slice(0, at), ...items.slice(at + 1)] };
        });
        throw error;
      }
      if (connection.current !== client) return;
      if (videoRef.current.join("\n") === submittedVideos.join("\n")) { videoRef.current = []; setVideoUrls([]); }
      // Only a successful send clears the sent key; text typed during the send and
      // attachments that were not submitted stay. Clear the key that submitted, not
      // whatever session happens to be on screen now.
      if (draftRef.current === value && draftKeyRef.current === submitDraftKey) {
        clearDraft(submitDraftKey);
        draftRef.current = "";
        setDraft("");
      }
      else saveDraft(draftRef.current, attachmentRef.current);
      updateAttachments(removeSubmittedImages(attachmentRef.current, submitted));
      if (wasHero) { setHero(false); onStartSession?.(); }
    } catch (error) {
      // Keep the draft and images available after rejection, but do not hide why it failed.
      const message = String(error).replace(/^Error:\s*/u, "");
      if (connection.current === client && /Flow attachment is closed|Flow session metadata is missing/u.test(message)) {
        try { if (await recoverSession()) return; } catch (recoveryError) { setNotification(String(recoveryError).replace(/^Error:\s*/u, "")); return; }
      }
      if (connection.current === client) {
        // A refused image lives in the history, so every later request fails the same
        // way. Offer the repair rather than leaving a session that cannot continue.
        if (/image[^.]{0,80}(must be larger|too small|minimum|below)|(must be larger|minimum)[^.]{0,40}image/iu.test(message)) setImageRepair(true);
        setNotification(humanizeRuntimeError(message));
      }
    } finally {
      setCommandBusy(false);
      // Settling clears this send's own entry even after the user switched session.
      setPendingBySession(previous => clearPending(previous, pendingKey));
    }
  }
  /** Remove the images the provider refuses, keeping the original session file. */
  async function repairSessionImages() {
    const sessionPath = connection.current?.snapshot.sessionFile ?? snapshot.sessionFile;
    if (!sessionPath) return;
    setImageRepair(false);
    try {
      const result = await invoke<{ removed: number; backup: string }>("chat_session_sanitize_images", { sessionPath });
      if (!result.removed) { setNotification("No image in this session is below the model's minimum."); return; }
      setNotification(`Removed ${result.removed} image${result.removed === 1 ? "" : "s"} the model cannot read. The original file is kept as a backup.`);
      await reloadSession();
    } catch (error) { setNotification(String(error)); }
  }
  const name = workspaceLabel(path);
  function parkPrevious(previous: ChatConnection | null) {
    if (!previous || previous.isDisposed()) return;
    const sessionFile = previous.snapshot.sessionFile;
    // A blank session can share its provisional file with the next new session, so
    // only a session with a transcript is keyed by path; an unstored one is closed
    // unless it is still working.
    if (sessionFile && previous.snapshot.projection.messages.length) chatPool.remember(sessionFile, previous);
    else if (previous.snapshot.projection.running || previous.snapshot.pending) chatPool.remember(`unsaved:${crypto.randomUUID()}`, previous);
    else void previous.close().catch(() => {});
  }
  function queueNewSession() {
    queuedSwitch.current = "new";
    previewRequest.current += 1;
    setPreview(null);
    setHero(true);
    setSelectedSession(null);
  }
  async function startNewSession() {
    if (locked) return;
    setAppView("chat");
    if (switchingRef.current) {
      queueNewSession();
      return;
    }
    if (!snapshot.connected) {
      queueNewSession();
      return;
    }
    // A new session must run in the real workspace, so it cannot lease a scratch
    // warm slot. The previous runtime stays alive in the pool: starting a session
    // never replaces or stops a running turn.
    const previous = connection.current;
    setHero(true);
    setSelectedSession(null);
    previewRequest.current += 1;
    setPreview(null);
    switchingRef.current = true;
    switchingTarget.current = "new";
    setSwitching(true);
    setSessionError(null);
    try {
      const next = await chatPool.lease(path, undefined, dialogRef.current, true);
      parkPrevious(previous);
      bindClient(next);
      updateDialogs(emptyDialogQueue());
      setDiskReports([]); setReportsSession(""); setTiming(undefined);
      setNotification("");
      onStartSession?.();
      void refreshSessions();
    } catch (error) {
      // A failed cold start must not leave the hero over the session that is still
      // bound: sending from the hero would go into the previous session.
      const previousFile = previous?.snapshot.sessionFile ?? null;
      setHero(!previousFile);
      setSelectedSession(previousFile);
      setPreview(null);
      setNotification(humanizeRuntimeError(String(error).replace(/^Error:\s*/u, "")));
    } finally {
      switchingRef.current = false;
      switchingTarget.current = null;
      setSwitching(false);
    }
  }
  async function reloadSession() {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session for reloading."); return; }
      const active = connection.current;
      if (!active) return;
      await active.reloadSession();
      setNotification("Session reloaded.");
    } catch (error) { setNotification(String(error).replace(/^Error:\s*/u, "")); }
    finally { setCommandBusy(false); }
  }
  async function runExtensionCommand(command: string) {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session for the command."); return; }
      const active = connection.current;
      if (!active) return;
      await active.runCommand(command);
      if (command === "/flow clear") {
        setFlowNotice("");
        setSessionError(null);
        const key = normalizedPath(active.snapshot.sessionFile ?? queueSessionKey);
        if (key) setQueuedBySession(previous => { const next = { ...previous }; delete next[key]; return next; });
        active.clearError();
      }
    }
    catch (error) { setNotification(String(error).replace(/^Error:\s*/u, "")); }
    finally { setCommandBusy(false); }
  }
  async function selectSessionModel(provider: string, id: string) {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session to change its model."); return; }
      const active = connection.current;
      if (!active) return;
      await active.selectModel(provider, id);
    }
    catch (error) { setNotification(String(error).replace(/^Error:\s*/u, "")); }
    finally { setCommandBusy(false); }
  }
  async function selectThinkingLevel(level: string) {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session to change its thinking level."); return; }
      const active = connection.current;
      if (!active) return;
      await active.setThinkingLevel(level);
    }
    finally { setCommandBusy(false); }
  }
  function inspectTextGuard(sessionId: string) {
    const client = connection.current;
    if (!client || !client.snapshot.connected || textguardRef.current[sessionId]?.loading) return;
    updateTextGuard(sessionId, { loading: true, error: null });
    void client.runCommand(`/textguard-desktop ${JSON.stringify({ action: "inspect" })}`)
      .catch(error => updateTextGuard(sessionId, { loading: false, error: String(error).replace(/^Error:\s*/u, "") }));
  }
  async function requestTextGuardReview() {
    const client = connection.current;
    if (!client) return;
    if (!await ensureSelectedSession(client)) return;
    const id = activeSessionIdRef.current;
    if (id) inspectTextGuard(id);
  }
  async function runTextGuard(action: "approve" | "dismiss" | "mode", item: TextGuardItem | null, extra: Record<string, unknown> = {}) {
    const client = connection.current;
    const sessionId = activeSessionIdRef.current;
    if (!client || !sessionId || textguardRef.current[sessionId]?.busy) return;
    updateTextGuard(sessionId, { busy: true, error: null });
    try {
      await client.runCommand(`/textguard-desktop ${JSON.stringify({ action, ...(item ? { id: item.id, ticket: item.ticket } : {}), ...extra })}`);
      if (action === "approve" || action === "dismiss") {
        const previous = textguardRef.current[sessionId]?.data;
        if (previous) updateTextGuard(sessionId, { data: { ...previous, items: [] }, error: null });
      }
      // Approve and mode replies are delivered before the runtime reloads resources.
      if (action !== "dismiss") await new Promise(resolve => setTimeout(resolve, 300));
      await client.runCommand(`/textguard-desktop ${JSON.stringify({ action: "inspect" })}`);
    } catch (error) {
      updateTextGuard(sessionId, { error: String(error).replace(/^Error:\s*/u, "") });
    } finally {
      updateTextGuard(sessionId, { busy: false, loading: false });
    }
  }
  async function recoverSession(sourcePath?: string): Promise<boolean> {
    const client = connection.current;
    const source = sourcePath ?? client?.snapshot.sessionFile;
    if (!client || !source) return false;
    const recovered = await invoke<string | null>("chat_session_recover", { sessionPath: source });
    if (!recovered || recovered === source) return false;
    setSelectedSession(recovered);
    await client.resumeSession(recovered);
    await client.loadModels();
    setHero(false);
    void refreshSessions();
    setNotification("Recovered the session without the interrupted tool call.");
    return true;
  }
  /** The one place that changes which runtime session is loaded. */
  async function switchSession(target: string, recovered = false) {
    const client = connection.current;
    if (!client || switchingRef.current) return;
    if (target !== "new" && normalizedPath(target) === normalizedPath(client.snapshot.sessionFile ?? "")) {
      setSelectedSession(target);
      setHero(false);
      return;
    }
    switchingRef.current = true;
    switchingTarget.current = target;
    setSwitching(true);
    setSessionError(null);
    setFlowNotice("");
    try {
      const previous = connection.current;
      const next = await chatPool.enter(path, target, dialogRef.current);
      if (connection.current !== previous) return;
      if (previous && previous !== next) parkPrevious(previous);
      if (connection.current !== next) bindClient(next);
      const loaded = next.snapshot.sessionFile ?? target;
      // A click that arrived while this switch was running owns the selection.
      if (!queuedSwitch.current && normalizedPath(loaded) !== normalizedPath(selectedSessionRef.current ?? "")) setSelectedSession(loaded);
      // The same row was clicked again while loading: that is already this load.
      if (queuedSwitch.current && normalizedPath(queuedSwitch.current) === normalizedPath(loaded)) queuedSwitch.current = null;
      if (queuedSwitch.current !== "new") setHero(false);
      onStartSession?.();
      setDiskReports([]); setReportsSession(loaded); setTiming(undefined);
      setNotification("");
      setSessionError(null);
      const session = sessions.find(item => normalizedPath(item.path) === normalizedPath(loaded));
      if (session) localStorage.setItem("jouzu.chat.workspace", session.workspace);
      void refreshSessions();
    } catch (error) {
      if (connection.current !== client) return;
      const message = String(error).replace(/^Error:\s*/u, "");
      if (!recovered && /owned|busy|unavailable|exited|disposed/iu.test(message)) {
        await invoke("chat_stop_all").catch(() => {});
        chatPool.forget(target);
        switchingRef.current = false;
        switchingTarget.current = null;
        return switchSession(target, true);
      }
      const readable = previewRef.current && normalizedPath(previewRef.current.path) === normalizedPath(target);
      if (readable) {
        // The transcript is already on screen. Never replace a readable session with a blank
        // view because its runtime attachment failed.
        setSessionError(message);
        setNotification("");
        return;
      }
      if (!queuedSwitch.current) {
        const active = client.snapshot.sessionFile ?? null;
        setSelectedSession(active);
        setHero(!active);
      }
      previewRequest.current += 1;
      setPreview(null);
      setNotification(humanizeRuntimeError(message));
    } finally {
      switchingRef.current = false;
      switchingTarget.current = null;
      setSwitching(false);
      onStartSession?.();
    }
  }
  function loadPreview(sessionPath: string) {
    const request = ++previewRequest.current;
    const cached = projectionCache.current.get(normalizedPath(sessionPath));
    if (cached) {
      setPreview({ path: sessionPath, projection: cached });
      return;
    }
    void invoke<unknown[]>("chat_session_messages", { sessionPath, limit: 200 }).then(messages => {
      if (previewRequest.current !== request) return;
      if (normalizedPath(selectedSessionRef.current ?? "") !== normalizedPath(sessionPath)) return;
      try { setPreview({ path: sessionPath, projection: interruptUnfinishedTools(historyProjection(messages)) }); }
      catch { /* The runtime's authoritative history still loads below. */ }
    }).catch(() => { /* Opening still completes through the runtime. */ });
  }
  /** Start the runtime switch and expose the one promise a send can wait for. */
  function startSwitch(target: string) {
    if (switchingRef.current) return;
    const promise = switchSession(target);
    switchPromise.current = promise;
    void promise.finally(() => { if (switchPromise.current === promise) switchPromise.current = null; });
  }
  async function ensureSelectedSession(client: ChatConnection): Promise<boolean> {
    const target = selectedSessionRef.current;
    if (!target) return true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (normalizedPath(target) === normalizedPath(connection.current?.snapshot.sessionFile ?? "")) return true;
      if (!switchingRef.current) startSwitch(target);
      const pending = switchPromise.current;
      if (!pending) break;
      await pending;
    }
    return normalizedPath(target) === normalizedPath(connection.current?.snapshot.sessionFile ?? "");
  }
  /** A click only records intent. The runtime load is always the single path below. */
  function openSession(sessionPath: string) {
    setAppView("chat");
    const client = connection.current;
    if (!client) return;
    const active = normalizedPath(client.snapshot.sessionFile ?? "");
    if (!switchingRef.current && normalizedPath(sessionPath) === active) {
      queuedSwitch.current = null;
      previewRequest.current += 1;
      setPreview(null);
      setSessionError(null);
      setSelectedSession(sessionPath);
      setHero(false);
      return;
    }
    // A session with a pooled runtime opens live: no preview, no switch_session,
    // and Stop keeps reaching a turn that is still in flight.
    const live = switchingRef.current ? undefined : chatPool.client(sessionPath);
    if (live) {
      if (connection.current !== live) { parkPrevious(connection.current); bindClient(live); }
      queuedSwitch.current = null;
      previewRequest.current += 1;
      setPreview(null);
      setSessionError(null);
      setSelectedSession(sessionPath);
      setHero(false);
      setDiskReports([]); setReportsSession(sessionPath); setTiming(undefined);
      onStartSession?.();
      void refreshSessions();
      return;
    }
    setSessionError(null);
    setSelectedSession(sessionPath);
    setHero(false);
    loadPreview(sessionPath);
  }
  async function forkTurn(prompt: string, messageIndex: number) {
    let client = connection.current;
    if (!client || !prompt.trim()) return;
    if (switchingRef.current || snapshot.pending || !snapshot.connected) { setNotification("Wait for the session to finish loading."); return; }
    // Fork is an explicit action on the selected session: attach it first, the same
    // way Review does, so the branch is copied from the session on screen.
    const target = selectedSessionRef.current;
    const attach = !!target && normalizedPath(target) !== normalizedPath(client.snapshot.sessionFile ?? "");
    switchingRef.current = true;
    setSwitching(true);
    try {
      if (attach) {
        // Fork attaches on the current runtime: the fork must run against the session
        // on screen, and a pool swap here would clear the branch notification.
        await client.resumeSession(target);
        if (!client || normalizedPath(target ?? "") !== normalizedPath(client.snapshot.sessionFile ?? "")) {
          setNotification("Could not attach this session for forking.");
          return;
        }
      }
      const source = client.snapshot.sessionFile;
      if (!source) throw new Error("This session has no file to branch yet.");
      // Copy the session through the clicked message (the turn end) into a new
      // session, then switch the runtime to it. No runtime fork semantics change.
      const branch = await invoke<string>("chat_session_branch", { sessionPath: source, messageIndex });
      await client.resumeSession(branch);
      await refreshSessions();
      setPreview(null);
      setSelectedSession(branch);
      setHero(false);
      setNotification("Branched into a new conversation.");
    } catch (error) { setNotification(String(error).replace(/^Error:\s*/u, "")); }
    finally { switchingRef.current = false; setSwitching(false); }
  }
  useEffect(() => {
    if (switching || !snapshot.connected || snapshot.pending || !queuedSwitch.current) return;
    const target = queuedSwitch.current;
    queuedSwitch.current = null;
    if (target !== "new" && normalizedPath(target) === normalizedPath(connection.current?.snapshot.sessionFile ?? "")) {
      setSelectedSession(target);
      setPreview(null);
      return;
    }
    if (target === "new") void startNewSession();
    else startSwitch(target);
  }, [switching, snapshot.connected, snapshot.pending]);
  async function compactConversation() {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    const target = selectedSessionRef.current || undefined;
    try {
      // Compact attaches the target without loading its transcript: get_messages on
      // a large session exceeds the desktop's JSONL frame limit before compact runs.
      const pooled = target ? chatPool.client(target) : undefined;
      const active = pooled ?? client;
      if (active !== client) { parkPrevious(client); bindClient(active); }
      await active.compactSession(target);
      if (connection.current === active) setNotification("Earlier conversation compacted.");
    } catch (error) { setNotification(String(error).replace(/^Error:\s*/u, "")); }
    finally { setCommandBusy(false); }
  }
  async function exportConversation() {
    const client = connection.current;
    if (!client || !snapshot.connected || commandBusy) return;
    const selected = await save({ title: "Export conversation", defaultPath: `${name}-conversation.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
    if (typeof selected !== "string" || connection.current !== client) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session for export."); return; }
      const active = connection.current;
      if (!active) return;
      await active.exportHtml(selected);
      if (connection.current === active) setNotification(`Conversation exported to ${selected}`);
    } catch (error) { if (connection.current) setNotification(String(error)); }
    finally { setCommandBusy(false); }
  }
  async function switchWorkspace(next: string) {
    setAppView("chat");
    if (next === path) { setPickerOpen(false); return; }
    if (snapshot.projection.running && !await confirm("Stop the current run and switch workspace?", { title: "Switch workspace", kind: "warning" })) return;
    freshOnPath.current = true;
    setSelectedSession(null);
    setHero(true);
    onStartSession?.();
    setPickerOpen(false);
    onSelect(next);
  }
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; path: string; name: string; sessions: SessionSummary[] }>();
    for (const workspace of workspaces) map.set(normalizedPath(workspace.path), { id: workspace.id, path: workspace.path, name: workspaceLabel(workspace.path), sessions: [] });
    for (const session of sessions) {
      if (session.archived && !showArchived) continue;
      const key = normalizedPath(session.workspace);
      if (!map.has(key)) map.set(key, { id: key, path: session.workspace, name: workspaceLabel(session.workspace), sessions: [] });
      map.get(key)!.sessions.push(session);
    }
    let result = [...map.values()];
    if (search.trim()) {
      const query = search.trim().toLowerCase();
      result = result.flatMap(group => {
        if (group.name.toLowerCase().includes(query) || group.path.toLowerCase().includes(query)) return [group];
        const matches = group.sessions.filter(session => session.title.toLowerCase().includes(query));
        return matches.length ? [{ ...group, sessions: matches }] : [];
      });
    }
    if (sort === "name") result.sort((left, right) => left.name.localeCompare(right.name));
    else result.sort((left, right) => (right.sessions[0]?.updated ?? 0) - (left.sessions[0]?.updated ?? 0));
    return result;
  }, [workspaces, sessions, search, sort, showArchived]);
  const defaultGroup = groups.find(group => isDefaultWorkspace(group.path));
  const regularGroups = defaultGroup ? groups.filter(group => group !== defaultGroup) : groups;
  const renderGroup = (group: (typeof groups)[number]) => {
    const open = !!search.trim() || !collapsedGroups.has(group.id);
    return <section key={group.id} className="mb-1">
      <div className={`group flex items-center gap-1 rounded-lg ${(selectedWorkspace ? normalizedPath(selectedWorkspace) === normalizedPath(group.path) : !selectedKey && normalizedPath(group.path) === normalizedPath(path)) ? "bg-accent/70" : "hover:bg-muted/60"}`}>
        <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${group.name}`} onClick={() => setCollapsedGroups(current => { const next = toggleCollapsed(current, group.id); saveCollapsed(next); return next; })} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" /><span className="truncate text-sm">{group.name}</span>
        </button>
        <Button variant="ghost" className="mr-1 size-6 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${group.path}`} onClick={() => { const workspace = workspaces.find(item => normalizedPath(item.path) === normalizedPath(group.path)); if (workspace) onRemove(workspace.id); }}><X className="size-3" /></Button>
      </div>
      {open && <div className="ml-4 border-l border-border pl-1.5">
        {group.sessions.map(session => <div key={session.path} ref={node => { if (selectedKey === normalizedPath(session.path)) selectedRowRef.current = node; }} data-session-selected={selectedKey === normalizedPath(session.path) || undefined} className={`group/session relative flex items-center rounded-md text-sm ${selectedKey === normalizedPath(session.path) ? "bg-accent text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary" : "hover:bg-muted/60"} ${session.archived ? "opacity-60" : ""}`}>
          <button type="button" onClick={() => void openSession(session.path)} title={session.path} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
            {session.pinned ? <Pin className="size-3.5 shrink-0 text-primary" aria-label="Pinned" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate">{session.title}</span>{chatPool.isRunning(session.path) && <span role="img" aria-label="Running" title="Running" data-session-running className="size-1.5 shrink-0 rounded-full bg-primary" />}<span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(session.updated)}</span>{artifactCount(session.path) > 0 && <span className="shrink-0 rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground" title={`${artifactCount(session.path)} artifact${artifactCount(session.path) === 1 ? "" : "s"}`}>{artifactCount(session.path)}</span>}
          </button>
          <div className={`relative flex shrink-0 items-center gap-0.5 pr-1 transition-opacity focus-within:opacity-100 group-hover/session:opacity-100 ${sessionMenu === session.path ? "opacity-100" : "opacity-0"}`} data-session-menu>
            <button type="button" className="flex size-6 items-center justify-center rounded hover:bg-background/60" aria-label={session.pinned ? "Unpin session" : "Pin session"} title={session.pinned ? "Unpin session" : "Pin session"} onClick={() => void updateSession(session.path, { pinned: !session.pinned })}><Pin className={`size-3.5 ${session.pinned ? "text-primary" : "text-muted-foreground"}`} /></button>
            <button type="button" className="flex size-6 items-center justify-center rounded hover:bg-background/60" aria-label="Session actions" title="Session actions" aria-haspopup="menu" aria-expanded={sessionMenu === session.path} onClick={() => setSessionMenu(value => value === session.path ? null : session.path)}><MoreHorizontal className="size-4 text-muted-foreground" /></button>
            {sessionMenu === session.path && <div role="menu" aria-label={`Actions for ${session.title}`} className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-border bg-popover p-1 text-sm shadow-xl">
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void updateSession(session.path, { pinned: !session.pinned }); setSessionMenu(null); }}><Pin className="size-4 text-muted-foreground" />{session.pinned ? "Unpin session" : "Pin session"}</button>
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => void renameSession(session)}><Pencil className="size-4 text-muted-foreground" />Rename</button>
              <button type="button" role="menuitem" disabled title="Fork is not available in the runtime yet" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"><GitFork className="size-4 text-muted-foreground" />Fork session</button>
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void updateSession(session.path, { archived: !session.archived }); setSessionMenu(null); }}>{session.archived ? <ArchiveRestore className="size-4 text-muted-foreground" /> : <Archive className="size-4 text-muted-foreground" />}{session.archived ? "Restore session" : "Archive session"}</button>
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => void copySessionId(session)}><Copy className="size-4 text-muted-foreground" />Copy Session ID</button>
            </div>}
          </div>
        </div>)}
        {!group.sessions.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No sessions yet</p>}
      </div>}
    </section>;
  };
  const activeSession = normalizedPath(snapshot.sessionFile ?? "");
  const selectedKey = normalizedPath(selectedSession ?? snapshot.sessionFile ?? "");
  const selectedSessionWorkspace = sessions.find(item => normalizedPath(item.path) === selectedKey)?.workspace ?? path;
  const selectedSessionWorkspacePath = selectedSessionWorkspace.startsWith("\\\\?\\") ? selectedSessionWorkspace.slice(4) : selectedSessionWorkspace;
  // Stop belongs to the session on screen. A running turn in the background must
  // not put a Stop button under a transcript the button would not stop.
  const composerRunning = snapshot.projection.running && selectedKey === activeSession;
  const [appView, setAppView] = useState<"chat" | "artifacts">("chat");
  const [artifactCounts, setArtifactCounts] = useState<Record<string, number>>({});
  const [panes, setPanes] = useState<Array<{ tabs: string[]; active: string; width: number }>>([]);
  const resizingPane = useRef<{ index: number; startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    const key = snapshot.sessionId ? `jouzu.ui.panes.${snapshot.sessionId}` : "";
    try {
      const raw = key ? localStorage.getItem(key) : null;
      const saved = raw ? JSON.parse(raw) : null;
      const next = Array.isArray(saved?.panes)
        ? saved.panes
            .filter((pane: any) => pane && Array.isArray(pane.tabs) && pane.tabs.length && typeof pane.active === "string")
            .slice(0, 2)
            .map((pane: any) => {
              const active = pane.active;
              const width = typeof pane.width === "number" ? Math.min(960, Math.max(360, pane.width)) : defaultPaneWidth();
              return { tabs: pane.tabs.filter((tab: unknown) => typeof tab === "string"), active, width: [360, 420, 560].includes(width) ? defaultPaneWidth() : width };
            })
        : [];
      setPanes(next);
    } catch { setPanes([]); }
  }, [snapshot.sessionId]);
  useEffect(() => {
    if (!snapshot.sessionId) return;
    try { localStorage.setItem(`jouzu.ui.panes.${snapshot.sessionId}`, JSON.stringify({ panes })); } catch { /* a webview without storage keeps the session value */ }
  }, [snapshot.sessionId, panes]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = resizingPane.current;
      if (!current) return;
      setPanes(list => list.map((pane, index) => index === current.index ? { ...pane, width: Math.min(960, Math.max(360, current.startWidth + (current.startX - event.clientX))) } : pane));
    };
    const stop = () => { resizingPane.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
  }, []);
  useEffect(() => {
    let alive = true;
    void invoke<{ counts: Record<string, number> }>("artifact_counts")
      .then(value => { if (alive) setArtifactCounts(value.counts ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, [sessions, revision, snapshot.projection.messages.length]);
  function artifactCount(sessionPath: string) {
    const file = sessionPath.split(/[\\/]/u).at(-1)?.replace(/\.jsonl$/u, "") ?? "";
    const sessionId = file.includes("_") ? file.split("_").pop()! : file;
    return artifactCounts[sessionId] ?? 0;
  }
  function toggleSide() {
    setPanes(current => current.length ? [] : [{ tabs: ["start"], active: "start", width: defaultPaneWidth() }]);
  }
  function addPane() {
    setPanes(current => current.length >= 2 ? current : [...current, { tabs: ["start"], active: "start", width: defaultPaneWidth() }]);
  }
  function removePane(index: number) {
    setPanes(current => current.filter((_, position) => position !== index));
  }
  function addPaneTab(index: number) {
    setPanes(current => current.map((pane, position) => position !== index ? pane : pane.tabs.includes("start") ? { ...pane, active: "start" } : { ...pane, tabs: [...pane.tabs, "start"], active: "start" }));
  }
  function closePaneTab(index: number, id: string) {
    setPanes(current => current.flatMap((pane, position) => {
      if (position !== index) return [pane];
      const tabs = pane.tabs.filter(tab => tab !== id);
      if (!tabs.length) return [];
      return [{ ...pane, tabs, active: pane.active === id ? tabs[tabs.length - 1] : pane.active }];
    }));
  }
  function openPaneView(index: number, id: string) {
    setPanes(current => current.map((pane, position) => {
      if (position !== index) return pane;
      if (pane.tabs.includes(id)) return { ...pane, tabs: pane.tabs.filter(tab => tab !== "start"), active: id };
      const tabs = [...pane.tabs];
      const start = tabs.indexOf("start");
      if (start >= 0) tabs[start] = id; else tabs.push(id);
      return { ...pane, tabs, active: id };
    }));
  }
  function openArtifactsPanel() {
    setPanes(current => {
      if (!current.length) return [{ tabs: ["artifacts"], active: "artifacts", width: defaultPaneWidth() }];
      return current.map((pane, position) => position !== current.length - 1 ? pane : pane.tabs.includes("artifacts") ? { ...pane, tabs: pane.tabs.filter(tab => tab !== "start"), active: "artifacts" } : { ...pane, tabs: [...pane.tabs, "artifacts"], active: "artifacts" });
    });
  }

  const reviewBody = dialog?.title.startsWith("Review tool call") ? dialog.title.split("\n").slice(1).join("\n") : null;
  const dialogNode = !dialog ? null : reviewBody !== null
    ? <ToolReviewDialog title="Review tool call" body={reviewBody} options={dialog.options ?? []} disabled={dialog.responding || !snapshot.transportReady} onSelect={value => void reply({ value })} onCancel={() => void reply({ cancelled: true })} />
    : <section role="dialog" aria-modal="false" aria-label={dialog.title.split("\n")[0]} className="rounded-xl border border-primary bg-card p-4 shadow-2xl"><h3 className="font-semibold">{dialog.title.split("\n")[0]}</h3>{dialog.title.split("\n").slice(1).join("\n") && <p className="my-2 whitespace-pre-line text-sm">{dialog.title.split("\n").slice(1).join("\n")}</p>}{dialog.message && <p className="my-2 text-sm">{dialog.message}</p>}{["input", "editor"].includes(dialog.method) && <textarea aria-label="Response" disabled={dialog.responding} className="my-2 w-full rounded border border-border bg-background p-2" value={answer} onChange={event => setAnswer(event.target.value)} />}
      <fieldset disabled={dialog.responding || !snapshot.transportReady} className="mt-3 flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => void reply({ cancelled: true })}>Cancel</Button>{dialog.method === "confirm" ? <><Button variant="outline" onClick={() => void reply({ confirmed: false })}>No</Button><Button onClick={() => void reply({ confirmed: true })}>Yes</Button></> : dialog.method === "select" ? (dialog.options ?? []).map(option => <Button key={option} onClick={() => void reply({ value: option })}>{option}</Button>) : <Button onClick={() => void reply({ value: answer })}>Submit</Button>}</fieldset></section>;
  const selectedTitle = sessions.find(session => normalizedPath(session.path) === selectedKey)?.title;
  const activePreview = preview && normalizedPath(preview.path) === selectedKey ? preview : null;
  // A preview is read from disk, so the live connection has no sessionId yet.
  // The session file's UUID is the same identifier the artifact sidecars store.
  const artifactsSessionId = activePreview ? sessionIdFromFile(activePreview.path) : snapshot.sessionId;
  const opening = !hero && !!selectedSession && selectedKey !== activeSession && !activePreview;
  // One gate: the entry session is connected before the chat UI appears, so the user
  // never sees a second, still-blocked "Connecting…" state.
  const booting = !snapshot.connected && !sessionError;
  // The attach timed out or failed before connecting: offer a retry instead of an endless "Starting session…".
  const attachFailed = !snapshot.connected && !!snapshot.error;
  // The connection desynced from the runtime (a reaped/released handle). Clear the stale
  // Rust-side handles and the pooled client, then re-attach from a clean slate — the same
  // recovery the session-switch path already uses.
  async function retryAttach() {
    // Re-open the session the user was actually viewing (selected, else the one that was loaded).
    // Re-selecting it drives the normal queuedSwitch load after the re-attach, so selection and the
    // loaded session stay in sync and the composer doesn't wedge in "opening" with Send disabled.
    const target = selectedKey || connection.current?.snapshot.sessionFile || null;
    if (target) setSelectedSession(target);
    // The connection desynced from the runtime (a reaped/released handle). Clear the stale Rust-side
    // handles and the pooled client, then re-attach from a clean slate — the same recovery the
    // session-switch path already uses.
    await invoke("chat_stop_all").catch(() => {});
    if (target) chatPool.forget(target);
    onRetry?.();
  }
  // Auto-recover: when a highlighted session's connection has failed, re-attach on its own (bounded)
  // rather than leaving the user on a dead "couldn't connect" screen.
  useEffect(() => {
    if (snapshot.connected) { autoRetryCountRef.current = 0; return; }
    if (!snapshot.error) return;
    if (!selectedSessionRef.current && !snapshot.sessionFile) return;
    const now = Date.now();
    if (now - lastAutoRetryAtRef.current < AUTO_RETRY_COOLDOWN_MS) return;
    if (autoRetryCountRef.current >= MAX_AUTO_RETRIES) return;
    lastAutoRetryAtRef.current = now;
    autoRetryCountRef.current += 1;
    void retryAttach();
  }, [snapshot.connected, snapshot.error]);
  const conversationProjection = activePreview?.projection ?? snapshot.projection;
  const activeMessage = conversationProjection.activeMessage === null ? undefined : conversationProjection.messages[conversationProjection.activeMessage];
  const hasRunningTool = Object.values(conversationProjection.tools).some(tool => tool.phase === "running");
  const liveThinking = conversationProjection.running && activeMessage && !hasRunningTool
    ? activeMessage.content.flatMap(block => block.type === "thinking" ? [block.thinking ?? ""] : []).join("\n")
    : "";
  const lastMessage = conversationProjection.messages.at(-1);
  const settled = !conversationProjection.running
    ? lastMessage?.role === "assistant" && lastMessage.stopReason === "error" ? "failed" as const
      : lastMessage?.role === "toolResult" || (lastMessage?.role === "assistant" && (lastMessage.stopReason === "aborted" || lastMessage.stopReason === "toolUse")) ? "interrupted" as const
        : undefined
    : undefined;
  const outputReferences = useMemo(
    () => collectOutputReferences(conversationProjection.messages, artifactsSessionId),
    [conversationProjection.messages, artifactsSessionId],
  );
  const conversationKey = selectedSession ?? snapshot.sessionId ?? path;
  const hasArchived = sessions.some(session => session.archived);
  const selectedWorkspace = sessions.find(session => normalizedPath(session.path) === selectedKey)?.workspace;
  useEffect(() => { if (selectedSession) selectedRowRef.current?.scrollIntoView({ block: "nearest" }); }, [selectedSession]);
  const showingAttached = selectedKey === activeSession;
  const flow = useMemo(() => showingAttached ? deriveFlow(snapshot.projection.tools) : deriveFlow({}), [showingAttached, snapshot.projection.tools]);
  const subagents = useMemo(() => showingAttached ? deriveSubagents(snapshot.projection.tools) : [], [showingAttached, snapshot.projection.tools]);
  const flowError = useMemo(() => showingAttached ? latestFlowError(snapshot.projection.messages) : undefined, [showingAttached, snapshot.projection.messages]);
  const textguardWithheld = useMemo(() => Object.values(snapshot.projection.tools).some(tool => {
    const result = JSON.stringify(tool.result ?? "");
    return result.includes("TextGuard withheld") || result.includes("TextGuard advisory");
  }), [snapshot.projection.tools]);
  useEffect(() => {
    const id = snapshot.sessionId;
    if (!id || !textguardWithheld || switching || hero) return;
    updateTextGuard(id, { seen: true, historical: !textguardRef.current[id]?.data });
  }, [textguardWithheld, snapshot.sessionId, switching, hero]);
  const workspacePicker = <div ref={picker} className="relative">
    <Button type="button" variant="outline" className="h-8 max-w-64 gap-2 px-2 text-xs" aria-label="Choose workspace" aria-expanded={pickerOpen} onClick={() => setPickerOpen(value => !value)}>
      <FolderOpen className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{name}</span><ChevronDown className="size-3 shrink-0" aria-hidden="true" />
    </Button>
    {pickerOpen && <div role="menu" aria-label="Choose workspace" className="absolute left-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-2 shadow-xl">
      {[...workspaces].sort((left, right) => Number(isDefaultWorkspace(left.path)) - Number(isDefaultWorkspace(right.path))).map(workspace => <button key={workspace.id} type="button" role="menuitemradio" aria-checked={workspace.path === path} onClick={() => void switchWorkspace(workspace.path)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
        <span className="min-w-0"><span className="block truncate">{workspaceLabel(workspace.path)}</span><span className="block truncate text-xs text-muted-foreground">{workspace.path}</span></span>
        {workspace.path === path && <span className="text-xs text-primary">Current</span>}
      </button>)}
      {!workspaces.length && <p className="px-2 py-2 text-sm text-muted-foreground">No workspaces yet.</p>}
      <div className="mt-1 border-t border-border pt-1"><Button type="button" variant="ghost" className="w-full justify-start" onClick={() => { setPickerOpen(false); onAddFolder(); }}><Plus className="size-4" />Add folder</Button></div>
    </div>}
  </div>;
  const workspaceError = showingAttached ? snapshot.error : null;
  // The runtime's Flow submission budget is per session and never reclaimed; a full
  // store cannot be retried, so the banner offers the only way out.
  const capacityError = isCapacityError(sessionError) || isCapacityError(snapshot.error);
  const flowHistoryError = isFlowHistoryError(sessionError) || isFlowHistoryError(snapshot.error);
  const readableError = (message: string) => humanizeRuntimeError(message);
  const textguardKey = snapshot.sessionId && selectedKey === activeSession ? snapshot.sessionId : "";
  const textguardView = textguardKey ? textguardBySession[textguardKey] : undefined;
  const textguardItems = textguardView?.data?.items.length ?? 0;
  const textguardExpired = !!textguardView?.historical && !!textguardView?.error;
  const textguardBlocked = !!textguardView?.seen && !textguardExpired && (textguardView.data ? textguardItems > 0 : true);
  const [textguardMode, setTextguardMode] = useState<"on" | "strict" | "off">("on");
  const textguardControl = snapshot.sessionId ? {
    label: textguardBlocked ? `${textguardItems || 1} blocked` : "TextGuard",
    title: textguardBlocked ? `${textguardItems || 1} item(s) withheld from the model` : "TextGuard",
    tone: (textguardBlocked ? "blocked" : textguardExpired || textguardView?.historical ? "expired" : "idle") as "blocked" | "expired" | "idle",
    disabled: !textguardKey,
    blocked: false,
    mode: textguardMode,
    onMode: (mode: "on" | "strict" | "off") => {
      setTextguardMode(mode);
      void runExtensionCommand(`/textguard ${mode}`);
    },
    onOpen: () => {},
  } : undefined;

  // A review created by the running turn can only be inspected after it settles.
  useEffect(() => {
    if (!textguardKey || snapshot.projection.running || !textguardView?.open || textguardView.data) return;
    inspectTextGuard(textguardKey);
  }, [textguardKey, snapshot.projection.running, textguardView?.open, textguardView?.data]);
  const textguardPanel = textguardKey && textguardView?.seen && textguardView.open
    ? <aside role="region" aria-label="TextGuard review" className="relative z-20 flex h-full w-[480px] max-w-[90vw] shrink-0 flex-col border-l border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">TextGuard</h2>
          <Button variant="ghost" className="size-8 p-0" aria-label="Close TextGuard" onClick={() => updateTextGuard(textguardKey, { open: false })}><X className="size-4" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TextGuardBar data={textguardView.data} open busy={textguardView.busy} running={composerRunning} error={textguardView.error} historical={textguardView.historical} onToggle={() => updateTextGuard(textguardKey, { open: false })} onStop={() => void connection.current?.abort()} onAction={(action, item, extra) => void runTextGuard(action, item, extra)} />
        </div>
      </aside>
    : null;
  return <div ref={chatRoot} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
    {dropActive && <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-primary bg-background/85 text-sm font-medium text-primary">Drop images or files</div>}
    {sidebar && <aside aria-label="Workspaces" className="absolute inset-y-0 left-0 z-20 flex w-80 max-w-[85%] flex-col border-r border-border bg-background shadow-xl md:static md:z-auto md:shadow-none">
      <div className="flex items-center gap-2 px-2 pb-2 pt-3"><Button className="min-w-0 flex-1 justify-start gap-2" disabled={locked} onClick={() => void startNewSession()}><Plus className="size-4" />New session</Button><Button variant="ghost" className="size-8 p-0 md:hidden" aria-label="Hide workspaces" onClick={() => setSidebar(false)}><X className="size-4" /></Button></div>
      <div className="px-2 pb-2"><Button variant={appView === "artifacts" ? "default" : "ghost"} className="w-full justify-start gap-2" aria-pressed={appView === "artifacts"} onClick={() => setAppView(appView === "artifacts" ? "chat" : "artifacts")}><Images className="size-4" />Artifacts</Button></div>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspaces</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="size-7 p-0" aria-label="Search workspaces" aria-pressed={searchOpen} onClick={() => { setSearchOpen(value => !value); if (searchOpen) setSearch(""); }}><Search className="size-3.5" /></Button>
          {(hasArchived || showArchived) && <Button variant="ghost" className="size-7 p-0" aria-label={showArchived ? "Hide archived sessions" : "Show archived sessions"} aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}><Archive className="size-3.5" /></Button>}
          <Button variant="ghost" className="size-7 p-0" aria-label={sort === "recent" ? "Sort by name" : "Sort by recent"} onClick={() => setSort(value => value === "recent" ? "name" : "recent")}><ArrowUpDown className="size-3.5" /></Button>
          <Button variant="ghost" className="size-7 p-0" aria-label="Add folder" onClick={onAddFolder}><FolderPlus className="size-3.5" /></Button>
        </div>
      </div>
      {searchOpen && <div className="px-2 pb-2"><Input autoFocus aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={event => setSearch(event.target.value)} /></div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {regularGroups.map(group => {
          const open = !!search.trim() || !collapsedGroups.has(group.id);
          return <section key={group.id} className="mb-1">
            <div className={`group flex items-center gap-1 rounded-lg ${(selectedWorkspace ? normalizedPath(selectedWorkspace) === normalizedPath(group.path) : !selectedKey && normalizedPath(group.path) === normalizedPath(path)) ? "bg-accent/70" : "hover:bg-muted/60"}`}>
              <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${group.name}`} onClick={() => setCollapsedGroups(current => { const next = toggleCollapsed(current, group.id); saveCollapsed(next); return next; })} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
                {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" /><span className="truncate text-sm">{group.name}</span>
              </button>
              <Button variant="ghost" className="mr-1 size-6 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${group.path}`} onClick={() => { const workspace = workspaces.find(item => normalizedPath(item.path) === normalizedPath(group.path)); if (workspace) onRemove(workspace.id); }}><X className="size-3" /></Button>
            </div>
            {open && <div className="ml-4 border-l border-border pl-1.5">
              {group.sessions.map(session => <div key={session.path} ref={node => { if (selectedKey === normalizedPath(session.path)) selectedRowRef.current = node; }} data-session-selected={selectedKey === normalizedPath(session.path) || undefined} className={`group/session relative flex items-center rounded-md text-sm ${selectedKey === normalizedPath(session.path) ? "bg-accent text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary" : "hover:bg-muted/60"} ${session.archived ? "opacity-60" : ""}`}>
                <button type="button" onClick={() => void openSession(session.path)} title={session.path} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
                  {session.pinned ? <Pin className="size-3.5 shrink-0 text-primary" aria-label="Pinned" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate">{session.title}</span>{chatPool.isRunning(session.path) && <span role="img" aria-label="Running" title="Running" data-session-running className="size-1.5 shrink-0 rounded-full bg-primary" />}<span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(session.updated)}</span>{artifactCount(session.path) > 0 && <span className="shrink-0 rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground" title={`${artifactCount(session.path)} artifact${artifactCount(session.path) === 1 ? "" : "s"}`}>{artifactCount(session.path)}</span>}
                </button>
                <div className={`relative flex shrink-0 items-center gap-0.5 pr-1 transition-opacity focus-within:opacity-100 group-hover/session:opacity-100 ${sessionMenu === session.path ? "opacity-100" : "opacity-0"}`} data-session-menu>
                  <button type="button" className="flex size-6 items-center justify-center rounded hover:bg-background/60" aria-label={session.pinned ? "Unpin session" : "Pin session"} title={session.pinned ? "Unpin session" : "Pin session"} onClick={() => void updateSession(session.path, { pinned: !session.pinned })}><Pin className={`size-3.5 ${session.pinned ? "text-primary" : "text-muted-foreground"}`} /></button>
                  <button type="button" className="flex size-6 items-center justify-center rounded hover:bg-background/60" aria-label="Session actions" title="Session actions" aria-haspopup="menu" aria-expanded={sessionMenu === session.path} onClick={() => setSessionMenu(value => value === session.path ? null : session.path)}><MoreHorizontal className="size-4 text-muted-foreground" /></button>
                  {sessionMenu === session.path && <div role="menu" aria-label={`Actions for ${session.title}`} className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-border bg-popover p-1 text-sm shadow-xl">
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void updateSession(session.path, { pinned: !session.pinned }); setSessionMenu(null); }}><Pin className="size-4 text-muted-foreground" />{session.pinned ? "Unpin session" : "Pin session"}</button>
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => void renameSession(session)}><Pencil className="size-4 text-muted-foreground" />Rename</button>
                    <button type="button" role="menuitem" disabled title="Fork is not available in the runtime yet" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"><GitFork className="size-4 text-muted-foreground" />Fork session</button>
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => { void updateSession(session.path, { archived: !session.archived }); setSessionMenu(null); }}>{session.archived ? <ArchiveRestore className="size-4 text-muted-foreground" /> : <Archive className="size-4 text-muted-foreground" />}{session.archived ? "Restore session" : "Archive session"}</button>
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onClick={() => void copySessionId(session)}><Copy className="size-4 text-muted-foreground" />Copy Session ID</button>
                  </div>}
                </div>
              </div>)}
              {!group.sessions.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No sessions yet</p>}
            </div>}
          </section>;
        })}
        {!groups.length && <p className="p-3 text-sm text-muted-foreground">{search ? "No matching sessions" : "No workspaces yet."}</p>}
      </div>
      {defaultGroup && <div className="shrink-0 border-t border-border bg-background px-1.5 py-1">{renderGroup(defaultGroup)}</div>}
      <div className="mt-auto border-t border-border p-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="min-w-0 flex-1 justify-start gap-2" onClick={onSettings}><Settings className="size-4" />Settings</Button>
          {onUpdate && <Button variant="ghost" className={`size-8 shrink-0 p-0 ${updateAvailable ? "text-primary hover:text-primary" : ""}`} aria-label={updateAvailable ? "Update available" : "Check for updates"} title={updateAvailable ? "Update available" : "Check for updates"} disabled={updateBusy} onClick={onUpdate}>{updateAvailable ? <ArrowUpCircle className={`size-4 ${updateBusy ? "animate-pulse" : ""}`} /> : <RefreshCw className={`size-4 ${updateBusy ? "animate-spin" : ""}`} />}</Button>}
        </div>
      </div>
    </aside>}
    <section className={appView === "artifacts" ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
      {hero ? <div className="flex items-center px-2 py-1.5"><Button variant="ghost" className="size-8 shrink-0 p-0" aria-label={sidebar ? "Hide workspaces" : "Show workspaces"} title="Workspaces" aria-expanded={sidebar} onClick={() => setSidebar(value => !value)}><PanelLeft className="size-4" /></Button></div> : <div className="flex items-center gap-2 border-b border-border px-2 py-2 sm:px-3">
        <Button variant="ghost" className="size-8 shrink-0 p-0" aria-label={sidebar ? "Hide workspaces" : "Show workspaces"} title="Workspaces" aria-expanded={sidebar} onClick={() => setSidebar(value => !value)}><PanelLeft className="size-4" /></Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="max-w-60 min-w-0 shrink-0 truncate text-sm font-semibold" title={`${name} · ${path}${snapshot.model ? ` · ${snapshot.model}` : ""}`}>{selectedTitle ?? name}</h2>
          {!snapshot.connected && <span className={`h-7 shrink-0 rounded-md border px-2 text-xs leading-7 ${workspaceError ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>{workspaceError ? "Offline" : "Starting…"}</span>}
          <div className="hidden min-w-0 items-center gap-1.5 md:flex">
            <SubagentMenu agents={subagents} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} />
            <BackgroundMenu jobs={flow.background} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} />
            <FlowMenu key={snapshot.sessionId ?? path} flow={flow} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} notice={showingAttached ? flowNotice : ""} error={flowError} reports={reportsSession && normalizedPath(reportsSession) === activeSession ? diskReports : []} onCommand={command => void runExtensionCommand(command)} busy={commandBusy} />
            <McpMenu onReload={() => void reloadSession()} onAsk={() => updateDraft("Add an MCP server to this workspace. Ask me for the name, transport, target, and any required environment variables.")} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label="Toggle artifacts panel" title="Artifacts panel" aria-pressed={panes.length > 0} onClick={toggleSide}><PanelRight className="size-3.5" /></Button>
        </div>
      </div>}
      {notification && <div role="status" aria-live="polite" className="pointer-events-none fixed left-1/2 top-16 z-50 w-max max-w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg bg-popover px-4 py-2 text-xs text-foreground shadow-xl">{notification}</div>}
      {imageRepair && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">This session contains an image the model refuses, so every request fails. Removing it keeps the rest of the transcript.</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void repairSessionImages()}>Remove the image</Button></div>}
      {snapshot.historyError && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">This session is connected, but its transcript could not be loaded. {humanizeRuntimeError(snapshot.historyError)}</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void connection.current?.retryHistory()}>Retry</Button></div>}
      {capacityError && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">{humanizeRuntimeError(sessionError ?? snapshot.error ?? "")}</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void startNewSession()}>New session</Button></div>}
      {flowHistoryError && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">Flow request history is full. Clear it before sending again.</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void runExtensionCommand("/flow clear")}>Clear Flow history</Button></div>}
      {booting ? (attachFailed
        ? <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm font-medium text-destructive">{humanizeRuntimeError(snapshot.error ?? "").replace(/^Error:\s*/u, "")}</p>
          <p className="max-w-md text-sm text-muted-foreground">Your session couldn't be connected. It often clears on its own — retry, or restart the app if it keeps happening.</p>
          {onRetry && <Button variant="outline" onClick={() => void retryAttach()}><RefreshCw className="size-4" />Retry</Button>}
        </div>
        : <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Starting session…</div>
      ) : hero ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-8 sm:px-8">
        <div className="w-full max-w-3xl">
          <div className="mb-7 flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card"><Sparkles className="size-6 text-primary" aria-hidden="true" /></span>
            <h1 className="text-2xl font-semibold tracking-tight">What would you like to build?</h1>
            <p className="max-w-md text-sm text-muted-foreground">Choose a workspace, then describe the task. Jouzu can explore code, explain it, or make a change.</p>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">{workspacePicker}</div>
          {dialogNode && <div className="mb-3">{dialogNode}</div>}
          <Composer hero connected={snapshot.connected} pending={snapshot.pending || commandBusy || switching || locked } opening={false} running={composerRunning} draft={draft} onDraft={updateDraft} onSend={() => void send()} onStop={() => void connection.current?.abort()} onCompact={() => void compactConversation()} onExport={() => void exportConversation()} onReloadMcp={() => void reloadSession()} compatibility={snapshot.projection.compatibility} attachments={attachments} onAddImages={files => void addImages(files)} onRemoveImage={id => updateAttachments(attachmentRef.current.filter(item => item.id !== id))} readingImages={readingImages} attachmentError={attachmentError} videos={videoUrls} queued={queuedSteers} onAddVideo={addVideoUrl} onRemoveVideo={removeVideoUrl} models={snapshot.models ?? []} model={snapshot.model} onSelectModel={(provider, id) => void selectSessionModel(provider, id)} onRefreshModels={() => void connection.current?.loadModels()} onRetryModels={canRefreshModels ? onRetryModels : undefined} thinkingLevel={snapshot.thinkingLevel} thinkingLevels={snapshot.thinkingLevels ?? []} onThinkingLevel={level => void selectThinkingLevel(level)} />
          <SessionStatsBar stats={snapshot.stats} timing={timing} />
        </div>
      </div> : !snapshot.sessionId ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Opening session…</div> : <div className="flex min-h-0 flex-1"><div className="flex min-w-[520px] flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
{snapshot.gap && <p role="status" className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground">The transcript was refreshed after a display backlog.</p>}
          <ChatConversation key={conversationKey} projection={conversationProjection} workspace={path} busy={snapshot.pending} pendingUser={pendingUser} onFork={(prompt, index) => void forkTurn(prompt, index)} onOpenArtifacts={openArtifactsPanel} changedFiles={turnChangedFiles} />
        </div>
        <div className="relative">
          <div className="mx-auto w-full max-w-3xl">
            {showingAttached && flowNotice && <div role="alert" className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              <span className="min-w-0 flex-1">{/holding|reconciliation|waiting for recovery/iu.test(flowNotice) ? "Flow is holding your message. Clear it to continue." : flowNotice}</span>
              {/paused/iu.test(flowNotice) && <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void runExtensionCommand("/flow resume")}>Resume</Button>}
              <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void runExtensionCommand("/flow clear")}>Clear</Button>
            </div>}
            <AgentAction thinking={liveThinking} label="Working…" running={conversationProjection.running} elapsed={elapsed} settled={settled} />
          </div>
          {dialogNode && <div className="absolute bottom-full left-1/2 z-20 mb-2 w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 px-3">{dialogNode}</div>}
          <Composer connected={snapshot.connected || !!activePreview} pending={snapshot.pending || commandBusy || (opening && !activePreview) || locked } opening={opening && !activePreview} unavailable={!!sessionError} running={composerRunning} draft={draft} onDraft={updateDraft} onSend={() => void send()} onStop={() => void connection.current?.abort()} onCompact={() => void compactConversation()} onExport={() => void exportConversation()} onReloadMcp={() => void reloadSession()} compatibility={snapshot.projection.compatibility} attachments={attachments} onAddImages={files => void addImages(files)} onRemoveImage={id => updateAttachments(attachmentRef.current.filter(item => item.id !== id))} readingImages={readingImages} attachmentError={attachmentError} videos={videoUrls} queued={queuedSteers} onAddVideo={addVideoUrl} onRemoveVideo={removeVideoUrl} models={snapshot.models ?? []} model={snapshot.model} onSelectModel={(provider, id) => void selectSessionModel(provider, id)} onRefreshModels={() => void connection.current?.loadModels()} onRetryModels={canRefreshModels ? onRetryModels : undefined} thinkingLevel={snapshot.thinkingLevel} thinkingLevels={snapshot.thinkingLevels ?? []} onThinkingLevel={level => void selectThinkingLevel(level)} textguard={textguardControl} />
        </div>
        <SessionStatsBar stats={snapshot.stats} timing={timing} />
        </div>
        {panes.map((pane, index) => <aside key={index} data-session={snapshot.sessionId ?? ""} data-pane={index} style={{ width: pane.width }} className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background">
          <Tabs value={pane.active} onValueChange={value => setPanes(current => current.map((item, position) => position === index ? { ...item, active: value } : item))} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1">
              <TabsList variant="line" className="h-9 min-w-0 flex-1 justify-start gap-1 overflow-visible rounded-none p-0">
                {pane.tabs.map(tab => <div key={tab} className="relative flex shrink-0 items-center">
                  <TabsTrigger value={tab} className="h-9 flex-none px-3 pr-7 text-xs">{tab === "artifacts" ? "Artifacts" : tab === "start" ? "Start" : tab === "files" ? "Files" : tab}</TabsTrigger>
                  <button type="button" className="absolute right-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Close ${tab} tab`} title="Close tab" onClick={() => closePaneTab(index, tab)}><X className="size-3" /></button>
                </div>)}
              </TabsList>
              <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label="Add panel tab" title="Add tab" onClick={() => addPaneTab(index)}><Plus className="size-3.5" /></Button>
              <div className="ml-auto flex items-center">
                {index === panes.length - 1 && <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label={panes.length < 2 ? "Split pane" : "Close second pane"} title={panes.length < 2 ? "Split pane" : "Close second pane"} onClick={() => panes.length < 2 ? addPane() : removePane(1)}><Columns2 className="size-3.5" /></Button>}
              </div>
            </div>
            <TabsContent value={pane.active} className="min-h-0 flex-1 overflow-auto p-3">
              {pane.active === "start" ? <PanelStart onOpen={id => openPaneView(index, id)} /> : pane.active === "artifacts" ? <ArtifactsPanel embedded sessionId={artifactsSessionId} workspace={selectedSessionWorkspacePath} references={outputReferences} /> : pane.active === "files" ? <FilesPanel key={selectedSessionWorkspacePath} path={selectedSessionWorkspacePath} /> : null}
            </TabsContent>
          </Tabs>
          <div role="separator" aria-orientation="vertical" aria-label="Resize pane" className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30" onPointerDown={event => { resizingPane.current = { index, startX: event.clientX, startWidth: pane.width }; event.preventDefault(); }} />
        </aside>)}
      </div>}
    </section>
    {appView === "artifacts" && <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4"><div className="mx-auto max-w-5xl"><ArtifactsPanel /></div></div>
    </section>}
    {textguardPanel}
  </div>;
}

























