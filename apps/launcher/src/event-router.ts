/**
 * One event stream for the whole page. Session and control consumers subscribe to
 * this router instead of opening their own `/events` connections.
 */
import type { HostClient } from "./api/host-client";
import type { ApiEvent } from "./api/jouzu-api";

type Listener = (event: ApiEvent) => void;

class EventRouter {
  private client?: HostClient;
  private unsubscribe?: () => void;
  private readonly listeners = new Set<Listener>();
  private lastSeq = 0;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  /** Whether the page's one stream is open; false only after it was open and dropped. */
  private online = true;
  private readonly statusListeners = new Set<() => void>();

  start(client: HostClient): void {
    this.client = client;
    this.stopped = false;
    this.connect();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The stream dropped and is being reopened (ui-layer §5: "Reconnecting…"). */
  get reconnecting(): boolean {
    return !this.online;
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    for (const listener of this.statusListeners) listener();
  }

  private connect(): void {
    if (!this.client || this.stopped) return;
    this.unsubscribe?.();
    this.unsubscribe = this.client.subscribeEvents(
      this.client.clientId,
      this.lastSeq,
      event => this.receive(event),
      () => { this.setOnline(false); this.scheduleReconnect(); },
      () => this.setOnline(true),
    );
  }

  private receive(event: ApiEvent): void {
    const seq = typeof event.seq === "number" ? event.seq : event.id;
    if (seq > this.lastSeq) this.lastSeq = seq;
    if (event.event === "resync") {
      const latest = event.data && typeof event.data.latestSeq === "number" ? event.data.latestSeq : seq;
      if (latest > this.lastSeq) this.lastSeq = latest;
    }
    for (const listener of this.listeners) listener(event);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, 1000);
  }
}

export const eventRouter = new EventRouter();

export function configureEventRouter(client: HostClient): void {
  eventRouter.start(client);
}
