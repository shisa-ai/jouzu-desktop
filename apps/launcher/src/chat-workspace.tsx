import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpCircle, ArrowUpDown, Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, FolderOpen, FolderPlus, Images, MessageSquare, MoreHorizontal, PanelLeft, Columns2, PanelRight, Pencil, Pin, Plus, RefreshCw, Search, Settings, Sparkles, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { McpMenu } from "./mcp-menu";
import { ChatConversation } from "./chat-conversation";
import { AgentAction } from "./chat-live";
import { Composer } from "./composer";
import { changedFiles, snapshotComplete, type WorkspaceSnapshot } from "./workspace-diff";
import { loadCollapsed, saveCollapsed, toggleCollapsed } from "./sidebar-state";
import { ArtifactsPanel } from "./artifacts-panel";
import { useApi } from "./api/context";
import type { SessionSummary as ApiSessionSummary } from "./api/jouzu-api";
import { collectOutputReferences } from "./artifact-references";
import { PanelStart } from "./panel-start";
import { FilesPanel } from "./files-panel";
import { ToolReviewDialog } from "./tool-review-dialog";
import { SessionStore as ChatConnection, chatPool } from "./session-store";
import type { ChatModel, ChatSnapshot, PendingPrompt, SessionTiming } from "./chat-types";
import { eventRouter } from "./event-router";
import { fitsSendBudget, readImageAttachment, removeSubmittedImages, validateImageSelection, type ImageAttachment } from "./chat-attachments";
import { normalizeVideoUrl, videoMarker } from "./video-url";
import { emptyProjection, historyProjection, interruptUnfinishedTools, type ChatProjection, type FlowReportRecord } from "./chat-projection";
import { clearDraft, draftKey, readDraft, writeDraft } from "./drafts";
import { describeError, isCapacityError, isFlowHistoryError } from "./runtime-errors";
import { BackgroundMenu, deriveFlow, deriveSubagents, FlowMenu, latestFlowError, SubagentMenu } from "./tool-renderers";
import { SessionStatsBar } from "./session-stats-bar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import type { TextGuardMode } from "./session-notices";

/** The side pane starts at half the window so chat and pane have equal room. */
function defaultPaneWidth() {
  return Math.min(960, Math.max(480, Math.round(window.innerWidth / 2)));
}

interface WorkspaceItem { id: string; path: string }
interface SessionSummary { path: string; title: string; workspace: string; updated: number; pinned: boolean; archived: boolean; running: boolean; status: string }
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

export function ChatWorkspace({ path, revision = 0, newSession = true, locked = false, onStartSession, onRetry, onBusyChange, onBootChange, catalogRefreshing = false, canRefreshModels = false, onModelsMissing, onRetryModels, workspaces, onSelect, onAddFolder, onRemove, onSettings, onUpdate, updateAvailable = false, updateBusy = false }: ChatWorkspaceProps) {
  const api = useApi();
  const chatUnavailable = !api.capabilities.features.includes("chat");
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({ projection: emptyProjection(), connected: false, pending: false, error: null, models: [], thinkingLevels: [] });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snapshot.projection.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.projection.running]);
  // The host stamps when the turn started; the clock ticks once a second.
  const workingStartedAt = snapshot.projection.running ? snapshot.projection.turnStartedAt : undefined;
  const workingMs = workingStartedAt ? Math.max(0, now - workingStartedAt) : 0;
  const elapsed = workingStartedAt ? `${String(Math.floor(workingMs / 60000)).padStart(2, "0")}:${String(Math.floor((workingMs % 60000) / 1000)).padStart(2, "0")}` : undefined;
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftKeyRef = useRef("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentRef = useRef(attachments);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const videoRef = useRef(videoUrls);
  videoRef.current = videoUrls;
  const [readingImages, setReadingImages] = useState(false);
  const readingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [localSubmitted, setLocalSubmitted] = useState("");
  const sendCancelRef = useRef(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
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
  const [answer, setAnswer] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [notification, setNotification] = useState("");
  // The provider refused an image already in the history; the session stays usable only
  // after the offending image is removed, so offer that instead of a dead end.
  const [imageRepair, setImageRepair] = useState(false);
  // Files the current turn actually changed. The transcript only carries edit-tool
  // arguments, so a file written by a shell command needs a workspace comparison.
  const [turnChangedFiles, setTurnChangedFiles] = useState<string[]>([]);
  const turnBaseline = useRef<WorkspaceSnapshot | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(""), 3000);
    return () => clearTimeout(timer);
  }, [notification]);
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
  const [catalogModels, setCatalogModels] = useState<ChatModel[]>([]);
  useEffect(() => {
    let disposed = false;
    void api.models.list("").then(models => {
      if (!disposed) setCatalogModels(models);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [api]);
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
  const previousNewSession = useRef(newSession);
  const queuedSwitch = useRef<string | "new" | null>(null);
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
    unsubscribeRef.current = next.subscribe(setSnapshot);
  }
  useEffect(() => {
    if (chatUnavailable) return;
    if (newSession && !previousNewSession.current) void startNewSession();
    previousNewSession.current = newSession;
  }, [newSession, chatUnavailable]);
  // A draft belongs to the workspace and the session (or its new-session slot).
  // Changing the key loads that draft; it never clears the one left behind.
  const activeDraftKey = draftKey(path, hero ? null : selectedSession ?? snapshot.sessionFile ?? null);
  useEffect(() => {
    if (draftKeyRef.current === activeDraftKey) return;
    draftKeyRef.current = activeDraftKey;
    applyDraft(readDraft(activeDraftKey));
  }, [activeDraftKey]);
  useEffect(() => {
    if (chatUnavailable) return;
    const selected = selectedSessionRef.current;
    const keepPreview = !!selected && !!previewRef.current && normalizedPath(previewRef.current.path) === normalizedPath(selected);
    queuedSwitch.current = selected;
    switchingRef.current = false;
    previewRequest.current += 1;
    if (!keepPreview) setPreview(null);
    setSessionError(null);
    setSwitching(false);
    if (selected) setHero(false);
    setSnapshot({ projection: emptyProjection(), connected: false, pending: false, error: null, models: [], thinkingLevels: [] });
    let client: ChatConnection | undefined;
    let disposed = false;
    void (async () => {
      try {
        const leased = await chatPool.lease(path);
        if (disposed) { void leased.close().catch(() => {}); return; }
        client = leased;
        bindClient(leased);
      } catch (error) {
        if (!disposed) setSnapshot(current => ({ ...current, error: describeError(error) }));
      }
    })();
    return () => {
      disposed = true;
      unsubscribeRef.current?.();
      connection.current = null;
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
      void (api.files.snapshot(path) as Promise<WorkspaceSnapshot>)
        .then(before => { if (!turnBaseline.current) turnBaseline.current = before; })
        .catch(() => { /* The summary falls back to edit-tool arguments. */ });
      return;
    }
    const before = turnBaseline.current;
    if (!before) return;
    turnBaseline.current = null;
    void (api.files.snapshot(path) as Promise<WorkspaceSnapshot>)
      .then(after => setTurnChangedFiles(snapshotComplete(before) && snapshotComplete(after) ? changedFiles(before, after) : []))
      .catch(() => setTurnChangedFiles([]));
  }, [snapshot.connected, snapshot.projection.running, path]);
  useEffect(() => { setTurnChangedFiles([]); turnBaseline.current = null; }, [path, revision]);
  // Only a live turn blocks a runtime restart. A saved draft does not: it lives in
  // localStorage and must not make a model refresh wait for the composer to empty.
  useEffect(() => { onBusyChange?.(snapshot.pending || snapshot.projection.running); }, [snapshot.pending, snapshot.projection.running, onBusyChange]);
  // The app keeps its own loader up until the entry session is connected, so the
  // workspace never opens on a second, still-blocked "Starting session…" state.
  useEffect(() => { onBootChange?.(!chatUnavailable && !snapshot.connected); }, [snapshot.connected, onBootChange, chatUnavailable]);
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
  // Approvals and questions are host state; the first one waiting is shown.
  const prompt: PendingPrompt | null = snapshot.prompts?.[0] ?? null;
  useEffect(() => { setAnswer(""); setPromptError(null); setPromptBusy(false); }, [prompt?.id]);
  // Runtime command replies and other transient notices become the toast.
  useEffect(() => { if (snapshot.notice) setNotification(snapshot.notice.text); }, [snapshot.notice?.id]);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: MouseEvent) => { if (!picker.current?.contains(event.target as Node)) setPickerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [pickerOpen]);
  function fromApiSession(value: ApiSessionSummary): SessionSummary | null {
    if (!value.sessionPath) return null;
    const title = value.title?.trim() ?? "";
    const fileId = value.sessionPath.split(/[\\/]/u).at(-1)?.replace(/\.jsonl$/u, "") ?? "";
    // Empty page-load sessions can come back from the persisted index with the
    // file id as a title. That is not a user-facing title.
    if (!title || title === fileId) return null;
    const parsed = value.updatedAt ? Date.parse(value.updatedAt) : NaN;
    const updated = Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : Date.now() / 1000;
    return {
      path: value.sessionPath,
      title,
      workspace: value.workspacePath,
      updated,
      pinned: value.pinned,
      archived: value.archived,
      running: value.running,
      status: value.status,
    };
  }

  async function refreshSessions() {
    try {
      const list = await api.sessions.list();
      const byPath = new Map<string, SessionSummary>();
      for (const value of list) {
        const session = fromApiSession(value);
        if (session) byPath.set(normalizedPath(session.path), session);
      }
      setSessions([...byPath.values()]);
    } catch { /* Session history is ancillary; chat remains usable. */ }
  }
  async function updateSession(sessionPath: string, change: { pinned?: boolean; archived?: boolean; title?: string }) {
    try {
      await api.sessions.update(sessionPath, change);
      await refreshSessions();
    } catch (error) { setNotification(describeError(error)); }
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
    } catch (error) { setNotification(describeError(error)); }
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
  useEffect(() => { if (snapshot.pending) void refreshSessions(); }, [snapshot.pending]);
  useEffect(() => {
    if (!snapshot.connected || snapshot.projection.messages.length === 0) return;
    const timer = setTimeout(() => { void refreshSessions(); }, 500);
    return () => clearTimeout(timer);
  }, [snapshot.connected, snapshot.projection.messages.length]);
  useEffect(() => { if (snapshot.connected) void refreshSessions(); }, [snapshot.connected, snapshot.sessionFile]);
  useEffect(() => {
    if (!localSubmitted) return;
    // The store's outbox shows the message once the session takes it.
    if (snapshot.outbox?.some(item => item.text === localSubmitted)) setLocalSubmitted("");
  }, [snapshot.outbox, localSubmitted]);
  useEffect(() => eventRouter.subscribe(event => {
    if (event.event === "session.updated" || event.event === "resync") void refreshSessions();
  }), []);
  useEffect(() => { if (snapshot.connected) void connection.current?.loadStats(); }, [snapshot.connected, snapshot.sessionFile, snapshot.projection.messages.length, snapshot.projection.running]);
  useEffect(() => {
    // Reports belong to the loaded session, not to a selected session that is still opening.
    const file = snapshot.sessionFile;
    if (!file) { setDiskReports([]); setReportsSession(""); setTiming(undefined); return; }
    setDiskReports([]); setReportsSession(file);
    let disposed = false;
    void api.sessions.flowReports(file)
      .then(reports => { if (!disposed) setDiskReports(reports as FlowReportRecord[]); })
      .catch(() => { if (!disposed) setDiskReports([]); });
    void api.sessions.timing(file)
      .then(value => { if (!disposed && value && typeof value.modelMs === "number") setTiming(value); })
      .catch(() => { if (!disposed) setTiming(undefined); });
    return () => { disposed = true; };
  }, [snapshot.sessionFile, snapshot.projection.messages.length]);
  /** Answer with the exact option the host offered; the card stays until the host accepts. */
  async function answerPrompt(value: string) {
    const client = connection.current;
    if (!prompt || !client || promptBusy) return;
    setPromptBusy(true);
    setPromptError(null);
    try { await client.answer(prompt, value); }
    catch (error) { if (connection.current === client) setPromptError(describeError(error)); }
    finally { if (connection.current === client) setPromptBusy(false); }
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
    } catch (error) { setAttachmentError(describeError(error)); }
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
          const data = await api.files.readFile(path);
          const binary = atob(data.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          await addImagesRef.current([new File([bytes], data.name, { type: data.mimeType })]);
        } catch (error) { setAttachmentError(describeError(error)); }
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
        const data = await api.files.readFile(path);
        const binary = atob(data.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        images.push(new File([bytes], data.name, { type: data.mimeType }));
      } catch (error) { setAttachmentError(describeError(error)); }
    }
    if (images.length) await addImages(images);
    if (files.length) {
      const current = draftRef.current;
      updateDraft(`${current}${current.trim() ? "\n\n" : ""}${files.map(path => `File: ${path}`).join("\n")}`);
      setNotification(`${files.length} file${files.length === 1 ? "" : "s"} added to the message.`);
    }
  }
  useEffect(() => api.native.onFileDrop(event => {
    if (event.type === "leave") { setDropActive(false); return; }
    const rect = chatRoot.current?.getBoundingClientRect();
    const position = event.position;
    const inside = !!rect && !!position && position.x >= rect.left && position.x <= rect.right && position.y >= rect.top && position.y <= rect.bottom;
    setDropActive(inside && event.type !== "drop");
    if (event.type === "drop" && inside) void addDropped(event.paths);
  }), [api, path, revision]);
  /** Stop: drop a send still waiting for its session, then stop what the host has. */
  function stop() {
    sendCancelRef.current = true;
    setLocalSubmitted("");
    void connection.current?.stop();
  }
  async function awaitConnection(limitMs = 15000): Promise<ChatConnection | null> {
    const end = Date.now() + limitMs;
    while (Date.now() < end && !sendCancelRef.current) {
      const current = connection.current;
      if (current?.snapshot.connected) return current;
      if (current?.snapshot.error && !current.snapshot.connected && !switchingRef.current) return null;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return connection.current?.snapshot.connected ? connection.current : null;
  }
  /**
   * Hand the message to the session's outbox. Until a session exists (a new
   * session still attaching) the message is shown locally; once the store has
   * it, the outbox owns it: "sending", then a transcript row, or "not sent"
   * with Retry. The composer is cleared as soon as the store has the message.
   */
  async function send() {
    const typed = draftRef.current;
    const submittedVideos = videoRef.current;
    const value = [...submittedVideos.map(videoMarker), typed].filter(Boolean).join("\n");
    if (!value.trim() || readingRef.current) return;
    if (snapshot.prompts?.length || snapshot.status === "waiting_approval" || snapshot.status === "waiting_question") {
      setNotification("Answer the pending approval or question before sending.");
      return;
    }
    const submitted = attachmentRef.current;
    const submitDraftKey = draftKeyRef.current;
    sendCancelRef.current = false;
    setLocalSubmitted(value);
    if (hero) { setHero(false); onStartSession?.(); }
    try {
      if (switchingRef.current) await switchPromise.current;
      const ready = connection.current?.snapshot.connected ? connection.current : await awaitConnection();
      if (sendCancelRef.current) return;
      if (!ready || !await ensureSelectedSession(ready)) { setNotification("The session is still opening. Your message was not sent."); return; }
      const client = connection.current;
      if (!client || sendCancelRef.current) return;
      if (!client.snapshot.modelId) { setNotification("Choose a model before sending."); return; }
      if (isFlowHistoryError(client.snapshot.error)) { setNotification("Clear Flow request history before sending again."); return; }
      const receipt = client.send(value, submitted.map(item => item.image));
      // The outbox now shows the message; the composer is free for the next one.
      setLocalSubmitted("");
      if (videoRef.current.join("\n") === submittedVideos.join("\n")) { videoRef.current = []; setVideoUrls([]); }
      if (draftRef.current === typed && draftKeyRef.current === submitDraftKey) {
        clearDraft(submitDraftKey);
        draftRef.current = "";
        setDraft("");
      }
      updateAttachments(removeSubmittedImages(attachmentRef.current, submitted));
      try { await receipt; }
      catch (error) {
        // The failure is shown on the message itself (not sent, with Retry).
        const message = describeError(error);
        if (connection.current === client && /Flow attachment is closed|Flow session metadata is missing/u.test(message)) {
          try { await recoverSession(); } catch (recoveryError) { setNotification(describeError(recoveryError)); }
        }
        // A refused image lives in the history, so every later request fails the same
        // way. Offer the repair rather than leaving a session that cannot continue.
        if (/image[^.]{0,80}(must be larger|too small|minimum|below)|(must be larger|minimum)[^.]{0,40}image/iu.test(message)) setImageRepair(true);
      }
    } finally {
      setLocalSubmitted(current => current === value ? "" : current);
    }
  }
  /** Remove the images the provider refuses, keeping the original session file. */
  async function repairSessionImages() {
    const sessionPath = connection.current?.snapshot.sessionFile ?? snapshot.sessionFile;
    if (!sessionPath) return;
    setImageRepair(false);
    try {
      const result = await api.sessions.sanitizeImages(sessionPath);
      if (!result.removed) { setNotification("No image in this session is below the model's minimum."); return; }
      setNotification(`Removed ${result.removed} image${result.removed === 1 ? "" : "s"} the model cannot read. The original file is kept as a backup.`);
      await reloadSession();
    } catch (error) { setNotification(describeError(error)); }
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
    queuedSwitch.current = null;
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
    // Do not leave the previous transcript under a hero titled "Default workspace"
    // while the new host session is attaching.
    setSnapshot({
      projection: emptyProjection(),
      connected: false,
      pending: false,
      error: null,
      models: snapshot.models,
      model: snapshot.model,
      modelProvider: snapshot.modelProvider,
      modelId: snapshot.modelId,
      thinkingLevel: snapshot.thinkingLevel,
      thinkingLevels: snapshot.thinkingLevels,
    });
    previewRequest.current += 1;
    setPreview(null);
    switchingRef.current = true;
    switchingTarget.current = "new";
    setSwitching(true);
    setSessionError(null);
    const promise = (async () => {
      try {
        const next = await chatPool.lease(path);
        parkPrevious(previous);
        bindClient(next);
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
        setNotification(describeError(error));
      } finally {
        switchingRef.current = false;
        switchingTarget.current = null;
        setSwitching(false);
      }
    })();
    switchPromise.current = promise;
    try { await promise; }
    finally { if (switchPromise.current === promise) switchPromise.current = null; }
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
    } catch (error) { setNotification(describeError(error)); }
    finally { setCommandBusy(false); }
  }
  /** Run an action on the attached session; errors become the toast. */
  async function withSession(action: (session: ChatConnection) => Promise<void>, attachError: string) {
    const client = connection.current;
    if (!client || commandBusy) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification(attachError); return; }
      const active = connection.current;
      if (active) await action(active);
    }
    catch (error) { setNotification(describeError(error)); }
    finally { setCommandBusy(false); }
  }
  function runFlow(verb: "clear" | "resume" | "off" | "on" | "status") {
    return withSession(async active => {
      await active.flow(verb);
      if (verb === "clear") { setSessionError(null); active.clearError(); }
    }, "Could not attach this session for Flow control.");
  }
  /** The Flow panel sends raw `/flow …` commands (details, retry, cancel, reset). */
  function runFlowCommand(command: string) {
    return withSession(active => active.runCommand(command), "Could not attach this session for Flow control.");
  }
  function setTextGuardMode(mode: TextGuardMode) {
    return withSession(active => active.setTextGuardMode(mode), "Could not attach this session to change TextGuard.");
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
    catch (error) { setNotification(describeError(error)); }
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
    catch (error) { setNotification(describeError(error)); }
    finally { setCommandBusy(false); }
  }
  async function recoverSession(sourcePath?: string): Promise<boolean> {
    const client = connection.current;
    const source = sourcePath ?? client?.snapshot.sessionFile;
    if (!client || !source) return false;
    const recovered = await api.sessions.recover(source);
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
    try {
      const previous = connection.current;
      const next = await chatPool.enter(path, target);
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
      const message = describeError(error);
      if (!recovered && /owned|busy|unavailable|exited|disposed/iu.test(message)) {
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
      setNotification(message);
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
    const previewMessages = api.sessions.messages(sessionPath, 200);
    void previewMessages.then(messages => {
      if (previewRequest.current !== request) return;
      if (normalizedPath(selectedSessionRef.current ?? "") !== normalizedPath(sessionPath)) return;
      try { setPreview({ path: sessionPath, projection: interruptUnfinishedTools(historyProjection(messages)) }); }
      catch (error) { setSessionError(describeError(error)); }
    }).catch(error => {
      if (previewRequest.current === request) setSessionError(describeError(error));
    });
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
    if (!client) {
      if (!chatUnavailable) return;
      selectedSessionRef.current = sessionPath;
      setSelectedSession(sessionPath);
      setHero(false);
      loadPreview(sessionPath);
      return;
    }
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
    const summary = sessions.find(item => normalizedPath(item.path) === normalizedPath(sessionPath));
    const needsLiveState = !!summary && (summary.running || ["starting", "recovering", "waiting_approval", "waiting_question"].includes(summary.status));
    if (client && needsLiveState) {
      // A waiting session has host-owned approvals/questions and its in-flight
      // assistant text; a disk preview has neither.
      startSwitch(sessionPath);
      return;
    }
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
      const branch = await api.sessions.branch(source, messageIndex);
      await client.resumeSession(branch);
      await refreshSessions();
      setPreview(null);
      setSelectedSession(branch);
      setHero(false);
      setNotification("Branched into a new conversation.");
    } catch (error) { setNotification(describeError(error)); }
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
  function compactConversation() {
    return withSession(async active => {
      await active.compactSession();
      if (connection.current === active) setNotification("Earlier conversation compacted.");
    }, "Could not attach this session to compact it.");
  }
  async function exportConversation() {
    const client = connection.current;
    if (!client || !snapshot.connected || commandBusy) return;
    let selected: string | null;
    try { selected = await api.native.saveFile({ title: "Export conversation", defaultPath: `${name}-conversation.html`, filters: [{ name: "HTML", extensions: ["html"] }] }); }
    catch (error) { setNotification(describeError(error)); return; }
    if (typeof selected !== "string" || connection.current !== client) return;
    setCommandBusy(true);
    try {
      if (!await ensureSelectedSession(client)) { setNotification("Could not attach this session for export."); return; }
      const active = connection.current;
      if (!active) return;
      await active.exportHtml(selected);
      if (connection.current === active) setNotification(`Conversation exported to ${selected}`);
    } catch (error) { if (connection.current) setNotification(describeError(error)); }
    finally { setCommandBusy(false); }
  }
  async function switchWorkspace(next: string) {
    setAppView("chat");
    if (next === path) { setPickerOpen(false); return; }
    if (snapshot.projection.running && !await api.native.confirm({ message: "Stop the current run and switch workspace?", title: "Switch workspace" }).catch(() => false)) return;
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
  const activeSession = normalizedPath(snapshot.sessionFile ?? "");
  const selectedKey = normalizedPath(selectedSession ?? snapshot.sessionFile ?? "");
  const selectedSessionWorkspace = sessions.find(item => normalizedPath(item.path) === selectedKey)?.workspace ?? path;
  const selectedSessionWorkspacePath = selectedSessionWorkspace.startsWith("\\\\?\\") ? selectedSessionWorkspace.slice(4) : selectedSessionWorkspace;
  // Stop belongs to the session on screen. A running turn in the background must
  // not put a Stop button under a transcript the button would not stop.
  // The bound session is the one on screen; a background store has its own
  // ChatWorkspace snapshot and is never the source here. Do not key Stop off
  // sessionFile: a new pending session has no file yet, which hid Stop during
  // the first turn.
  const composerRunning = snapshot.projection.running;
  const waitingForPrompt = !!snapshot.prompts?.length || snapshot.status === "waiting_approval" || snapshot.status === "waiting_question";
  // A cancel token is sent with the clientMessageId, so Stop can be offered as
  // soon as the local outbox exists.
  const composerStarting = (snapshot.pending || !!localSubmitted) && !composerRunning;
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
    void api.artifacts.counts()
      .then(value => { if (alive) setArtifactCounts(value ?? {}); })
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

  // One card for whatever the host is waiting on. Options are the host's exact
  // strings; a failed answer keeps the card and says why.
  const reviewBody = prompt?.title.startsWith("Review tool call") ? prompt.title.split("\n").slice(1).join("\n") || prompt.message : null;
  const promptNode = !prompt ? null : <div>
    {reviewBody !== null
      ? <ToolReviewDialog title="Review tool call" body={reviewBody} options={prompt.options} disabled={promptBusy} onSelect={value => void answerPrompt(value)} />
      : <section role="dialog" aria-modal="false" aria-label={prompt.title.split("\n")[0]} className="rounded-xl border border-primary bg-card p-4 shadow-2xl">
        <h3 className="font-semibold">{prompt.title.split("\n")[0]}</h3>
        {prompt.title.split("\n").slice(1).join("\n") && <p className="my-2 whitespace-pre-line text-sm">{prompt.title.split("\n").slice(1).join("\n")}</p>}
        {prompt.message && <p className="my-2 whitespace-pre-line text-sm">{prompt.message}</p>}
        {!prompt.options.length && <textarea aria-label="Response" disabled={promptBusy} className="my-2 w-full rounded border border-border bg-background p-2" value={answer} onChange={event => setAnswer(event.target.value)} />}
        <fieldset disabled={promptBusy} className="mt-3 flex flex-wrap justify-end gap-2">
          {prompt.options.length
            ? prompt.options.map(option => <Button key={option} variant={option === "Deny" ? "outline" : "default"} onClick={() => void answerPrompt(option)}>{option}</Button>)
            : <Button onClick={() => void answerPrompt(answer)}>Submit</Button>}
        </fieldset>
      </section>}
    {promptError && <p role="alert" className="mt-1 text-xs text-destructive">{promptError}</p>}
  </div>;
  const selectedTitle = sessions.find(session => normalizedPath(session.path) === selectedKey)?.title;
  const activePreview = preview && normalizedPath(preview.path) === selectedKey ? preview : null;
  // A preview is read from disk, so the live connection has no sessionId yet.
  // The session file's UUID is the same identifier the artifact sidecars store.
  const artifactsSessionId = activePreview ? sessionIdFromFile(activePreview.path) : snapshot.sessionId;
  const opening = !chatUnavailable && !hero && !!selectedSession && selectedKey !== activeSession && !activePreview;
  // One gate: the entry session is connected before the chat UI appears, so the user
  // never sees a second, still-blocked "Connecting…" state.
  const booting = !chatUnavailable && !snapshot.connected && !sessionError;
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
  // TextGuard: three modes, and the content it withheld. The runtime confirms the
  // mode; until it has, the default (on) is shown.
  const textguardMode: TextGuardMode = (showingAttached ? snapshot.textguard?.mode : undefined) ?? "on";
  const textguardAlert = showingAttached ? snapshot.textguard?.alert : undefined;
  const textguardControl = snapshot.sessionId ? {
    mode: textguardMode,
    alert: !!textguardAlert,
    disabled: !showingAttached || commandBusy || composerRunning,
    onMode: (mode: TextGuardMode) => void setTextGuardMode(mode),
  } : undefined;
  const flowHold = showingAttached ? snapshot.flowHold : null;
  const failedTurn = showingAttached ? snapshot.failedTurn : null;
  const pausedQueue = showingAttached && snapshot.queue?.some(item => item.state === "paused") ? snapshot.queue : undefined;
  // Every session-level notice lives in one stack above the composer, in the order
  // the user needs to act on them. Transient replies use the toast instead.
  const banners = <div className="space-y-1">
    {flowHold && <div role="alert" aria-label="Flow control" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
      <span className="min-w-0 flex-1">{flowHold.text}</span>
      {flowHold.paused && <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={commandBusy} onClick={() => void runFlow("resume")}>Resume</Button>}
      <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={commandBusy} onClick={() => void runFlow("clear")}>Release</Button>
      <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={commandBusy} title="Turn Flow control off for this session; held messages run normally" onClick={() => void runFlow("off")}>Turn off Flow</Button>
      <Button variant="ghost" className="size-6 p-0" aria-label="Dismiss" onClick={() => connection.current?.dismissFlowHold()}><X className="size-3" /></Button>
    </div>}
    {textguardAlert && <div role="alert" aria-label="TextGuard" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px]">
      <span className="min-w-0 flex-1">{textguardAlert}</span>
      {textguardMode !== "off" && <Button variant="outline" className="h-6 px-2 text-[10px]" disabled={commandBusy || composerRunning} title="Admit content unscanned for this session, then retry" onClick={() => void setTextGuardMode("off")}>Turn off TextGuard</Button>}
      <Button variant="ghost" className="size-6 p-0" aria-label="Dismiss" onClick={() => connection.current?.dismissTextGuardAlert()}><X className="size-3" /></Button>
    </div>}
    {failedTurn && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px]">
      <span className="min-w-0 flex-1">This message did not get a reply{failedTurn.text ? `: “${failedTurn.text.length > 80 ? `${failedTurn.text.slice(0, 80)}…` : failedTurn.text}”` : "."}</span>
      <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void connection.current?.queue("retry")}>Retry</Button>
    </div>}
    {pausedQueue && <div role="status" aria-label="Queued messages" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px]">
      <span className="min-w-0 flex-1">{pausedQueue.length === 1 ? "1 message is waiting" : `${pausedQueue.length} messages are waiting`} after the stopped turn.</span>
      <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void connection.current?.queue("continue")}>Continue</Button>
      <Button variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void connection.current?.queue("discard")}>Discard</Button>
    </div>}
  </div>;
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
        {[...regularGroups, ...(defaultGroup ? [defaultGroup] : [])].map(group => {
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
          {!chatUnavailable && !snapshot.connected && <span className={`h-7 shrink-0 rounded-md border px-2 text-xs leading-7 ${workspaceError ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}>{workspaceError ? "Offline" : "Starting…"}</span>}
          <div className="hidden min-w-0 items-center gap-1.5 md:flex">
            <SubagentMenu agents={subagents} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} />
            <BackgroundMenu jobs={flow.background} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} />
            <FlowMenu key={snapshot.sessionId ?? path} flow={flow} widgets={snapshot.widgets ?? {}} statuses={snapshot.statuses ?? {}} notice={flowHold?.text} error={flowError} reports={reportsSession && normalizedPath(reportsSession) === activeSession ? diskReports : []} onCommand={command => void runFlowCommand(command)} busy={commandBusy || composerRunning} />
            <McpMenu onReload={() => void reloadSession()} onAsk={() => updateDraft("Add an MCP server to this workspace. Ask me for the name, transport, target, and any required environment variables.")} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" className="size-7 shrink-0 p-0" aria-label="Toggle artifacts panel" title="Artifacts panel" aria-pressed={panes.length > 0} onClick={toggleSide}><PanelRight className="size-3.5" /></Button>
        </div>
      </div>}
      {notification && <div role="status" aria-live="polite" className="pointer-events-none fixed left-1/2 top-16 z-50 w-max max-w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg bg-popover px-4 py-2 text-xs text-foreground shadow-xl">{notification}</div>}
      {imageRepair && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">This session contains an image the model refuses, so every request fails. Removing it keeps the rest of the transcript.</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void repairSessionImages()}>Remove the image</Button></div>}
      {snapshot.historyError && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">This session is connected, but its transcript could not be loaded. {snapshot.historyError}</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void connection.current?.retryHistory()}>Retry</Button></div>}
      {capacityError && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">{sessionError ?? snapshot.error ?? ""}</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void startNewSession()}>New session</Button></div>}
      {flowHistoryError && !notification && <div role="alert" className="fixed left-1/2 top-16 z-50 flex w-max max-w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-popover px-4 py-2 text-xs text-foreground shadow-xl"><span className="min-w-0 break-words">Flow request history is full. Clear it before sending again.</span><Button variant="outline" className="h-7 shrink-0 px-2" onClick={() => void runFlow("clear")}>Clear Flow history</Button></div>}
      {booting && !hero && !localSubmitted ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Starting session…</div> : hero ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-8 sm:px-8">
        <div className="w-full max-w-3xl">
          <div className="mb-7 flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card"><Sparkles className="size-6 text-primary" aria-hidden="true" /></span>
            <h1 className="text-2xl font-semibold tracking-tight">What would you like to build?</h1>
            <p className="max-w-md text-sm text-muted-foreground">Choose a workspace, then describe the task. Jouzu can explore code, explain it, or make a change.</p>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">{workspacePicker}</div>
          {promptNode && <div className="mb-3">{promptNode}</div>}
          <Composer hero connected={snapshot.connected} pending={snapshot.pending || commandBusy || locked } opening={switching || opening || booting} starting={composerStarting} running={composerRunning} waiting={waitingForPrompt} draft={draft} onDraft={updateDraft} onSend={() => void send()} onStop={stop} onCompact={() => void compactConversation()} onExport={() => void exportConversation()} onReloadMcp={() => void reloadSession()} attachments={attachments} onAddImages={files => void addImages(files)} onRemoveImage={id => updateAttachments(attachmentRef.current.filter(item => item.id !== id))} readingImages={readingImages} attachmentError={attachmentError} videos={videoUrls} onAddVideo={addVideoUrl} onRemoveVideo={removeVideoUrl} models={catalogModels.length ? catalogModels : snapshot.models ?? []} model={snapshot.model} onSelectModel={(provider, id) => void selectSessionModel(provider, id)} onRefreshModels={() => void connection.current?.loadModels()} onRetryModels={canRefreshModels ? onRetryModels : undefined} thinkingLevel={snapshot.thinkingLevel} thinkingLevels={snapshot.thinkingLevels ?? []} onThinkingLevel={level => void selectThinkingLevel(level)} />
          <SessionStatsBar stats={snapshot.stats} timing={timing} />
        </div>
      </div> : !snapshot.sessionId && !activePreview && !localSubmitted ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">Opening session…</div> : <div className="flex min-h-0 flex-1"><div className="flex min-w-[520px] flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatConversation key={conversationKey} projection={conversationProjection} workspace={path} busy={snapshot.pending} pendingUser={localSubmitted} outbox={showingAttached ? snapshot.outbox : undefined} onRetrySend={id => void connection.current?.retry(id)?.catch(() => {})} onDiscardSend={id => connection.current?.discard(id)} onFork={(prompt, index) => void forkTurn(prompt, index)} onOpenArtifacts={openArtifactsPanel} changedFiles={turnChangedFiles} />
        </div>
        <div className="relative">
          <div className="mx-auto w-full max-w-3xl">
            {banners}
            <AgentAction thinking={liveThinking} label={waitingForPrompt ? "Waiting for your approval or answer…" : "Working…"} running={conversationProjection.running} elapsed={elapsed} settled={settled} />
          </div>
          {promptNode && <div className="absolute bottom-full left-1/2 z-20 mb-2 w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 px-3">{promptNode}</div>}
          <Composer connected={snapshot.connected || !!activePreview} pending={snapshot.pending || commandBusy || (opening && !activePreview) || locked } opening={opening && !activePreview} starting={composerStarting} unavailable={!!sessionError} running={composerRunning} waiting={waitingForPrompt} draft={draft} onDraft={updateDraft} onSend={() => void send()} onStop={stop} onCompact={() => void compactConversation()} onExport={() => void exportConversation()} onReloadMcp={() => void reloadSession()} attachments={attachments} onAddImages={files => void addImages(files)} onRemoveImage={id => updateAttachments(attachmentRef.current.filter(item => item.id !== id))} readingImages={readingImages} attachmentError={attachmentError} videos={videoUrls} onAddVideo={addVideoUrl} onRemoveVideo={removeVideoUrl} models={catalogModels.length ? catalogModels : snapshot.models ?? []} model={snapshot.model} onSelectModel={(provider, id) => void selectSessionModel(provider, id)} onRefreshModels={() => void connection.current?.loadModels()} onRetryModels={canRefreshModels ? onRetryModels : undefined} thinkingLevel={snapshot.thinkingLevel} thinkingLevels={snapshot.thinkingLevels ?? []} onThinkingLevel={level => void selectThinkingLevel(level)} textguard={textguardControl} />
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
  </div>;
}


































