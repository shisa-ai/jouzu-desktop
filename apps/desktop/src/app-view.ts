/**
 * The host's app-wide snapshot (`AppView`): configuration operations and the
 * current settings. The host owns both; this module only follows the snapshot
 * and sends commands. Nothing here queues, retries or keeps a copy of its own.
 */
import { useSyncExternalStore } from "react";
import type { HostClient } from "./api/host-client";
import { eventRouter } from "./event-router";
import { parseControlState, type ControlState, type HeldCatalog } from "./control-state";

export type ConfigKind =
  | "status" | "profile" | "import" | "shisa-login" | "shisa-logout" | "refresh-catalogs"
  | "catalog-accept" | "catalog-reject" | "provider-oauth" | "provider-key" | "provider-remove"
  | "custom-provider" | "default-model" | "language" | "environment";

export interface ConfigDevice { url: string; code: string; provider?: string }
export interface ConfigRunning { operationId: string; kind: ConfigKind; startedAt: string; device?: ConfigDevice }
export interface ConfigQueued { operationId: string; kind: ConfigKind; position: number }
export interface ConfigResult {
  operationId: string;
  ok: boolean;
  code: string | null;
  params: Record<string, unknown>;
  text: string | null;
  /** The provider the operation was for; its result belongs to that provider only. */
  provider?: string | null;
  finishedAt: string;
}
export interface AppView {
  revision: number;
  config: { running: ConfigRunning | null; queued: ConfigQueued[]; lastResult: Partial<Record<ConfigKind, ConfigResult>> };
  /** `null` until the host has read the settings once. */
  settings: ControlState | null;
  /** Providers whose latest reply refused the stored key or sign-in, with the provider's words. */
  providerAuth?: Record<string, { refusedAt: string; text: string }>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Read a snapshot. Settings this window cannot read leave `settings` empty and
 *  are reported in `settingsError`; the operations stay readable either way. */
export function parseAppView(value: unknown): AppView & { settingsError: Error | null } {
  if (!record(value) || typeof value.revision !== "number" || !record(value.config)) throw new Error("The host sent an incompatible app snapshot.");
  const config = value.config;
  const running = record(config.running) ? config.running as unknown as ConfigRunning : null;
  const queued = Array.isArray(config.queued) ? config.queued as ConfigQueued[] : [];
  const lastResult = record(config.lastResult) ? config.lastResult as AppView["config"]["lastResult"] : {};
  let settings: ControlState | null = null;
  let settingsError: Error | null = null;
  try { settings = value.settings == null ? null : parseControlState(value.settings); }
  catch (error) { settingsError = error instanceof Error ? error : new Error(String(error)); }
  const providerAuth: AppView["providerAuth"] = {};
  if (record(value.providerAuth)) {
    for (const [id, entry] of Object.entries(value.providerAuth)) {
      if (record(entry) && typeof entry.text === "string") providerAuth[id] = { refusedAt: typeof entry.refusedAt === "string" ? entry.refusedAt : "", text: entry.text };
    }
  }
  return { revision: value.revision, config: { running, queued, lastResult }, settings, settingsError, providerAuth };
}

type Listener = () => void;
let client: HostClient | undefined;
let view: AppView | null = null;
/** A snapshot this window cannot read: an incompatible host. Never silent. */
let failure: Error | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function receive(value: unknown): void {
  let parsed: ReturnType<typeof parseAppView>;
  try { parsed = parseAppView(value); }
  catch (error) { failure = error instanceof Error ? error : new Error(String(error)); notify(); return; }
  if (view && parsed.revision <= view.revision) return;
  const { settingsError, ...next } = parsed;
  view = next;
  failure = settingsError;
  notify();
}

async function load(): Promise<void> {
  if (!client) return;
  let value: unknown;
  // An unreachable host is the connection's concern; the stream reconnects.
  try { value = await client.appView(); } catch (error) { console.warn("[jouzu] app snapshot", error); return; }
  receive(value);
}

/** Called once by the app shell with the host-backed client. */
export function configureAppView(host: HostClient): void {
  client = host;
  // A full snapshot rides on every change; after a gap the stream says resync.
  eventRouter.subscribe(event => {
    if (event.event === "app.updated") receive(event.data);
    else if (event.event === "resync") void load();
  });
  void load();
}

/** The snapshot as it is now, outside React. */
export function currentAppView(): AppView | null {
  return view;
}

/** Why the last snapshot could not be read, or `null`. */
export function useAppViewFailure(): Error | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => failure,
  );
}

export function useAppView(): AppView | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => view,
  );
}

function host(): HostClient {
  if (!client) throw new Error("The app snapshot is not configured.");
  return client;
}

/** Queue one operation. Resolves with its id once the host accepted it. */
export function enqueueConfig(kind: ConfigKind, body: Record<string, unknown> = {}): Promise<string> {
  return host().configEnqueue(kind, body).then(accepted => accepted.operationId);
}

/**
 * Queue one operation and resolve with its result once the snapshot reports it.
 * A refused request (invalid body, full queue) rejects at once.
 */
export async function runConfig(kind: ConfigKind, body: Record<string, unknown> = {}): Promise<ConfigResult> {
  const operationId = await enqueueConfig(kind, body);
  return new Promise(resolve => {
    const check = () => {
      if (!view) return false;
      const result = view.config.lastResult[kind];
      const { running, queued } = view.config;
      const waiting = running?.operationId === operationId || queued.some(item => item.operationId === operationId);
      // Its own result, or (when snapshots were skipped and a later operation of
      // the same kind already replaced it) the newer result, which is the state now.
      if (result?.operationId !== operationId && (waiting || !result)) return false;
      listeners.delete(onChange);
      resolve(result!);
      return true;
    };
    const onChange = () => { check(); };
    listeners.add(onChange);
    check();
  });
}

export function cancelConfig(operationId: string): Promise<void> {
  return host().configCancel(operationId);
}

/** Whether an operation of one of these kinds is running or waiting. */
export function configPending(current: AppView | null, kinds: readonly ConfigKind[]): boolean {
  if (!current) return false;
  const { running, queued } = current.config;
  return (!!running && kinds.includes(running.kind)) || queued.some(item => kinds.includes(item.kind));
}

/** The newest failed result among these kinds, for the card that owns them. A
 *  cancelled operation is not a failure. */
export function configFailure(current: AppView | null, kinds: readonly ConfigKind[]): ConfigResult | null {
  if (!current) return null;
  let latest: ConfigResult | null = null;
  for (const kind of kinds) {
    const result = current.config.lastResult[kind];
    if (!result || result.ok || result.code === "config-cancelled") continue;
    if (!latest || result.finishedAt > latest.finishedAt) latest = result;
  }
  return latest;
}

/**
 * A catalog revision held for the person's decision: the outcome a refresh (or a
 * sign-in, which refreshes) reported, unless a later decision settled it. The
 * operation id tells one report from the next.
 */
export function heldCatalog(current: AppView | null): { held: HeldCatalog; operationId: string } | null {
  if (!current) return null;
  const { lastResult } = current.config;
  const reports = (["refresh-catalogs", "shisa-login"] as const)
    .map(kind => lastResult[kind])
    .filter((result): result is ConfigResult => !!result?.ok && record(result.params?.catalog));
  const report = reports.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
  if (!report) return null;
  const held = (report.params.catalog as Record<string, unknown>).held;
  if (!record(held) || typeof held.revision !== "string" || typeof held.digest !== "string" || !Array.isArray(held.reasons)) return null;
  const decided = (["catalog-accept", "catalog-reject"] as const)
    .map(kind => lastResult[kind])
    .some(result => !!result?.ok && result.finishedAt > report.finishedAt);
  if (decided) return null;
  return { held: { sourceId: typeof held.sourceId === "string" ? held.sourceId : "", revision: held.revision, digest: held.digest, reasons: held.reasons.map(String), changes: held.changes ?? null }, operationId: report.operationId };
}

/** Test seam: replace the snapshot as if the host had sent it. */
export function setAppViewForTest(next: AppView | null): void {
  view = next;
  failure = null;
  notify();
}

/** Test seam: deliver a raw snapshot as the host would. */
export function receiveAppViewForTest(value: unknown): void {
  receive(value);
}
