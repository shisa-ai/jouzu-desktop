import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, ExternalLink, FolderOpen, ImageOff } from "lucide-react";
import { Button } from "./components/ui/button";
import { JouzuLoader } from "./components/ui/jouzu-loader";
import { useWorkspaceRoot } from "./workspace-context";
import { copyText } from "./secure-context";
import { useOptionalApi } from "./api/context";
import type { JouzuApi } from "./api/jouzu-api";
import { openExternalLink } from "./external-link";
import type { HostAttachmentRef } from "./chat-projection";
import { fill, chatTexts, useChatText, type ChatText } from "./chat-text";

/** The native reader's cap for a workspace file. */
export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
/** Tool blocks above the old inline cap become a card instead of vanishing. */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_LIMIT = 32;
const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const CARD_ACTION = "h-7 gap-1 px-2 text-[11px]";

export interface MessageImageProps {
  kind: "markdown" | "tool" | "block";
  source?: string;
  alt?: string;
  workspace?: string;
  bytes?: number;
  path?: string;
  showCaption?: boolean;
}

export interface LocalImagePayload {
  mimeType: string;
  data: string;
  bytes: number;
  name: string;
}

export interface LocalImageError {
  reason?: string;
  message?: string;
  bytes?: number;
}

export type ImageCardReason =
  | "outside-workspace"
  | "not-found"
  | "too-large"
  | "not-an-image"
  | "unreadable"
  | "not-a-file"
  | "unsupported-mime"
  | "workspace-unavailable"
  | "desktop-only"
  | "no-source"
  | "invalid-source";

export type ImageSourceClassification =
  | { type: "inline"; src: string }
  | { type: "remote"; url: string; host: string; openable: boolean }
  | { type: "local"; path: string; name: string }
  | { type: "card"; reason: ImageCardReason; name: string; path?: string; bytes?: number; detail?: string };

const REASON_TEXT = (t: ChatText): Record<ImageCardReason, string> => ({
  "outside-workspace": t.outsideWorkspace,
  "not-found": t.fileNotFound,
  "too-large": t.tooLargeToShow,
  "not-an-image": t.previewUnsupported,
  unreadable: t.unreadable,
  "not-a-file": t.notAFile,
  "unsupported-mime": t.previewUnsupported,
  "workspace-unavailable": t.workspaceUnavailable,
  "desktop-only": t.imageDesktopOnly,
  "no-source": t.noImageSource,
  "invalid-source": t.invalidImageSource,
});

export function imageReasonText(reason: ImageCardReason, t: ChatText): string {
  return REASON_TEXT(t)[reason];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

function fileNameOf(value: string): string {
  return normalizeSlashes(value).split("/").filter(Boolean).at(-1) ?? "image";
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || /^[A-Za-z]:\//u.test(value);
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

/** Lexically normalize `..` segments without touching the filesystem. */
export function normalizeLocalPath(value: string): string {
  const text = normalizeSlashes(value);
  const drive = /^[A-Za-z]:/u.exec(text)?.[0];
  const unc = !drive && text.startsWith("//");
  const absolute = !!drive || unc || text.startsWith("/");
  const rest = drive ? text.slice(2) : text;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  // `drive` already carries its colon; the join adds the single separator.
  if (drive) return `${drive.toUpperCase()}/${parts.join("/")}`;
  if (unc) return `//${parts.join("/")}`;
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export function isWithinWorkspace(workspace: string, candidate: string): boolean {
  const root = normalizeLocalPath(workspace);
  const path = normalizeLocalPath(candidate);
  const fold = isWindowsPath(workspace) || isWindowsPath(candidate);
  const left = fold ? root.toLowerCase() : root;
  const right = fold ? path.toLowerCase() : path;
  return right === left || right.startsWith(`${left}/`);
}

/**
 * Resolve a Markdown/HTML source against the workspace. Relative paths are
 * joined lexically first so `../../outside.png` is refused before any IPC call;
 * the native command still canonicalizes and re-checks.
 */
export function resolveWorkspacePath(workspace: string, source: string): { absolute: string; inside: boolean } {
  const root = normalizeLocalPath(workspace);
  const raw = normalizeSlashes(decodePath(source));
  if (isAbsoluteLocalPath(raw)) {
    const absolute = normalizeLocalPath(raw);
    return { absolute, inside: isWithinWorkspace(root, absolute) };
  }
  const absolute = normalizeLocalPath(`${root}/${raw}`);
  return { absolute, inside: isWithinWorkspace(root, absolute) };
}

interface DataUrlInfo {
  mime: string;
  base64: boolean;
  bytes: number;
}

function dataUrlInfo(source: string): DataUrlInfo | null {
  const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/su.exec(source);
  if (!match) return null;
  const data = match[3] ?? "";
  return {
    mime: (match[1] || "text/plain").toLowerCase(),
    base64: /;base64/iu.test(match[2] ?? ""),
    bytes: Math.floor(data.length * 0.75),
  };
}

function imageLimit(kind: MessageImageProps["kind"]): number {
  return kind === "tool" ? MAX_TOOL_IMAGE_BYTES : MAX_LOCAL_IMAGE_BYTES;
}

/** The single decision point shared by Markdown, tool and message image blocks. */
export function classifyImageSource(
  source: string | undefined,
  options: { kind: MessageImageProps["kind"]; workspace?: string; bytes?: number; path?: string; alt?: string },
): ImageSourceClassification {
  const raw = (source ?? "").trim();
  const name = fileNameOf(options.path ?? "image");
  if (!raw) return { type: "card", reason: "no-source", name };
  if (raw.startsWith("data:")) {
    const info = dataUrlInfo(raw);
    if (!info || !info.base64) {
      return { type: "card", reason: "unsupported-mime", name, path: options.path, detail: info?.mime };
    }
    if (!(SUPPORTED_MIME as readonly string[]).includes(info.mime)) {
      return { type: "card", reason: "unsupported-mime", name, path: options.path, detail: info.mime };
    }
    const bytes = options.bytes ?? info.bytes;
    if (bytes > imageLimit(options.kind)) {
      return { type: "card", reason: "too-large", name, path: options.path, bytes };
    }
    return { type: "inline", src: raw };
  }
  if (/^https?:/iu.test(raw)) {
    try {
      const url = new URL(raw);
      return { type: "remote", url: url.href, host: url.host, openable: !url.username && !url.password };
    } catch {
      return { type: "card", reason: "invalid-source", name };
    }
  }
  if (/^(?:blob|asset):/iu.test(raw)) return { type: "inline", src: raw };
  const local = decodePath(raw);
  if (!options.workspace) {
    return { type: "card", reason: "workspace-unavailable", name: fileNameOf(local), path: local };
  }
  const resolution = resolveWorkspacePath(options.workspace, local);
  if (!resolution.inside) {
    return { type: "card", reason: "outside-workspace", name: fileNameOf(resolution.absolute), path: resolution.absolute };
  }
  return { type: "local", path: resolution.absolute, name: fileNameOf(resolution.absolute) };
}

export function imageCardReason(reason: string | undefined): ImageCardReason {
  return reason && reason in REASON_TEXT(chatTexts.en) ? reason as ImageCardReason : "unreadable";
}

export function normalizeImageError(value: unknown, t: ChatText): LocalImageError {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      reason: typeof record.reason === "string" ? record.reason : "unreadable",
      message: typeof record.message === "string" ? record.message : t.imageUnreadable,
      bytes: typeof record.bytes === "number" ? record.bytes : undefined,
    };
  }
  if (typeof value === "string") return { reason: "unreadable", message: value };
  return { reason: "unreadable", message: t.imageUnreadable };
}

const cache = new Map<string, LocalImagePayload>();
const inflight = new Map<string, Promise<LocalImagePayload>>();
let cachedWorkspace: string | undefined;

function cacheKey(workspace: string, path: string): string {
  return `${workspace}\u0000${path}`;
}

function syncCache(workspace: string): void {
  if (cachedWorkspace !== workspace) {
    cache.clear();
    inflight.clear();
    cachedWorkspace = workspace;
  }
}

function readCached(workspace: string, path: string): LocalImagePayload | undefined {
  syncCache(workspace);
  const key = cacheKey(workspace, path);
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function remember(workspace: string, path: string, payload: LocalImagePayload): void {
  syncCache(workspace);
  const key = cacheKey(workspace, path);
  cache.delete(key);
  cache.set(key, payload);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** One deduplicated native read per workspace+path, shared by every mount. */
export function requestLocalImage(workspace: string, path: string): Promise<LocalImagePayload> {
  syncCache(workspace);
  const key = cacheKey(workspace, path);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = invoke<LocalImagePayload>("read_local_image", { workspace, path }).then(payload => {
    remember(workspace, path, payload);
    inflight.delete(key);
    return payload;
  }, error => {
    inflight.delete(key);
    throw error;
  });
  inflight.set(key, request);
  return request;
}

/** The active workspace is part of the key, but a switch also drops the cache. */
export function clearImageCache(): void {
  cache.clear();
  inflight.clear();
  cachedWorkspace = undefined;
}

function RevealButton({ path }: { path: string }) {
  const t = useChatText();
  return <Button variant="ghost" className={CARD_ACTION} title={t.showInFolder} aria-label={t.reveal} onClick={() => {
    void invoke("reveal_path", { path }).catch(() => {});
  }}><FolderOpen className="size-3" />{t.reveal}</Button>;
}

function CopyPathButton({ path }: { path: string }) {
  const t = useChatText();
  const [copied, setCopied] = useState(false);
  return <Button variant="ghost" className={CARD_ACTION} onClick={async () => {
    try {
      await copyText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }}>{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? t.copied : t.copyPath}</Button>;
}

/** Exported so the card states can be rendered directly in a static test. */
export function ImageFallbackCard({ reason, name, path, bytes, detail }: { reason: ImageCardReason; name: string; path?: string; bytes?: number; detail?: string }) {
  const t = useChatText();
  // Revealing a file is the desktop shell's; a browser client would offer a
  // button that can do nothing (ADR 0021). Copying the path works everywhere.
  const revealable = useOptionalApi()?.capabilities.native ?? false;
  const label = imageReasonText(reason, t);
  const size = reason === "too-large" ? formatBytes(bytes ?? 0) : "";
  return <figure role="group" aria-label={`${name}: ${label}`} className="my-2 overflow-hidden rounded-lg border border-border bg-muted/30 text-left">
    <div className="flex items-start gap-2 px-3 py-2">
      <ImageOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={name}>{name}</p>
        {path && <p className="break-all font-mono text-[10px] text-muted-foreground">{path}</p>}
        <p className="text-[11px] text-muted-foreground">{label}{size ? ` · ${size}` : ""}{detail ? ` · ${detail}` : ""}</p>
      </div>
    </div>
    {path && <div className="flex flex-wrap justify-end gap-1 border-t border-border/60 px-2 py-1">
      {revealable && <RevealButton path={path} />}
      <CopyPathButton path={path} />
    </div>}
  </figure>;
}

function RemoteImageCard({ url, host, alt, openable }: { url: string; host: string; alt: string; openable: boolean }) {
  const t = useChatText();
  const api = useOptionalApi();
  const [error, setError] = useState<string | null>(null);
  return <figure role="group" aria-label={fill(t.remoteImageOn, { host })} className="my-2 overflow-hidden rounded-lg border border-border bg-muted/30 text-left">
    <div className="flex items-start gap-2 px-3 py-2">
      <ImageOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={alt || host}>{alt || host}</p>
        <p className="break-all text-[11px] text-muted-foreground">{host} · Remote image not loaded</p>
      </div>
    </div>
    {openable && <div className="flex justify-end border-t border-border/60 px-2 py-1">
      <Button variant="ghost" className={CARD_ACTION} onClick={() => {
        setError(null);
        void openExternalLink(api, url).catch(() => setError(t.openLinkFailed));
      }}><ExternalLink className="size-3" />{t.open}</Button>
    </div>}
    {error && <p role="alert" className="border-t border-border/60 px-2 py-1 text-[11px] text-destructive">{error}</p>}
  </figure>;
}

function InlineImage({ src, alt, caption }: { src: string; alt: string; caption: boolean }) {
  const t = useChatText();
  const [broken, setBroken] = useState(false);
  if (broken) return <ImageFallbackCard reason="unreadable" name={alt || t.image} />;
  return <figure className="my-2 space-y-1">
    <img
      src={src}
      alt={alt || t.image}
      className="max-h-80 max-w-full rounded-lg border border-border bg-background object-contain"
      onError={() => setBroken(true)}
    />
    {caption && alt && <figcaption className="text-[11px] text-muted-foreground">{alt}</figcaption>}
  </figure>;
}

type LocalState = { status: "loading" } | { status: "ready"; payload: LocalImagePayload } | { status: "failed"; error: LocalImageError };

function LocalImage({ workspace, path, name, alt, caption }: { workspace: string; path: string; name: string; alt: string; caption: boolean }) {
  const t = useChatText();
  // A workspace file is read by the desktop shell; a browser client has no
  // filesystem, so the card says that instead of failing a native read (#201).
  const native = useOptionalApi()?.capabilities.native ?? false;
  const [state, setState] = useState<LocalState>(() => {
    const cached = native ? readCached(workspace, path) : undefined;
    return cached ? { status: "ready", payload: cached } : { status: "loading" };
  });
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const cached = readCached(workspace, path);
    if (cached) {
      setState({ status: "ready", payload: cached });
      return () => { cancelled = true; };
    }
    setState({ status: "loading" });
    void requestLocalImage(workspace, path).then(payload => {
      if (!cancelled) setState({ status: "ready", payload });
    }, (error: unknown) => {
      if (!cancelled) setState({ status: "failed", error: normalizeImageError(error, t) });
    });
    return () => { cancelled = true; };
  }, [workspace, path, native]);
  if (!native) return <ImageFallbackCard reason="desktop-only" name={name} path={path} />;
  if (state.status === "ready") {
    return <InlineImage src={`data:${state.payload.mimeType};base64,${state.payload.data}`} alt={alt} caption={caption} />;
  }
  if (state.status === "failed") {
    const error = state.error;
    const reason = imageCardReason(error.reason);
    return <ImageFallbackCard reason={reason} name={name} path={path} bytes={error.bytes} detail={reason === "not-an-image" ? error.message : undefined} />;
  }
  return <div role="status" className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
    <JouzuLoader className="jouzu-loader-sm" />{t.loadingImage}
  </div>;
}

const hostCache = new Map<string, { mimeType: string; data: string }>();
const hostInflight = new Map<string, Promise<{ mimeType: string; data: string }>>();

/** One deduplicated host read per session+image, kept for the last few shown. */
export function requestHostAttachment(api: JouzuApi, ref: HostAttachmentRef): Promise<{ mimeType: string; data: string }> {
  const key = `${ref.sessionId}\u0000${ref.id}`;
  const cached = hostCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = hostInflight.get(key);
  if (pending) return pending;
  const load = api.sessions.attachment;
  if (!load) return Promise.reject(new Error("this client has no session attachment reader"));
  const request = load(ref.sessionId, ref.id).then(payload => {
    hostInflight.delete(key);
    hostCache.delete(key);
    hostCache.set(key, payload);
    while (hostCache.size > CACHE_LIMIT) {
      const oldest = hostCache.keys().next().value;
      if (oldest === undefined) break;
      hostCache.delete(oldest);
    }
    return payload;
  }, error => {
    hostInflight.delete(key);
    throw error;
  });
  hostInflight.set(key, request);
  return request;
}

type HostState = { status: "loading" } | { status: "ready"; src: string } | { status: "failed" };

/**
 * An image of a user message that the host keeps (a history row names it by id).
 * It is read from the host when shown, so every client (desktop or web) sees
 * the same transcript after switching sessions or restarting (#119).
 */
export function HostAttachmentImage({ attachment, alt = "" }: { attachment: HostAttachmentRef; alt?: string }) {
  const t = useChatText();
  const api = useOptionalApi();
  const key = `${attachment.sessionId}\u0000${attachment.id}`;
  const [state, setState] = useState<HostState>(() => {
    const cached = hostCache.get(key);
    return cached ? { status: "ready", src: `data:${cached.mimeType};base64,${cached.data}` } : { status: "loading" };
  });
  useEffect(() => {
    let cancelled = false;
    if (!api) {
      setState({ status: "failed" });
      return () => { cancelled = true; };
    }
    void requestHostAttachment(api, attachment).then(payload => {
      if (!cancelled) setState({ status: "ready", src: `data:${payload.mimeType};base64,${payload.data}` });
    }, () => {
      if (!cancelled) setState({ status: "failed" });
    });
    return () => { cancelled = true; };
  }, [api, key]);
  if (state.status === "ready") return <MessageImage kind="block" source={state.src} alt={alt} />;
  if (state.status === "failed") return <ImageFallbackCard reason="unreadable" name={alt || t.image} />;
  return <div role="status" className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
    <JouzuLoader className="jouzu-loader-sm" />{t.loadingImage}
  </div>;
}

/**
 * One image surface for the transcript. It either renders the picture with the
 * alt as caption, or explains why it cannot (inside/outside the workspace,
 * missing, unreadable, too large, unsupported, or remote and never fetched).
 */
export function MessageImage({ kind, source, alt = "", workspace, bytes, path, showCaption }: MessageImageProps) {
  const contextWorkspace = useWorkspaceRoot();
  const root = workspace ?? contextWorkspace;
  const caption = showCaption ?? kind === "markdown";
  const classification = classifyImageSource(source, { kind, workspace: root, bytes, path });
  if (classification.type === "inline") return <InlineImage src={classification.src} alt={alt} caption={caption} />;
  if (classification.type === "remote") return <RemoteImageCard url={classification.url} host={classification.host} alt={alt} openable={classification.openable} />;
  if (classification.type === "local") return <LocalImage workspace={root ?? ""} path={classification.path} name={classification.name} alt={alt} caption={caption} />;
  return <ImageFallbackCard reason={classification.reason} name={classification.name} path={classification.path} bytes={classification.bytes} detail={classification.detail} />;
}

