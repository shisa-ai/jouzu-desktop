/**
 * A chat session owned by the host.
 *
 * This replaces the shell transport: one attach, one event stream, one place that
 * knows the host's session id. Nothing here reads JSONL or Tauri commands; the UI
 * consumes the normalized events the host publishes.
 */
import type { ApiEvent, HistoryPage, JouzuApi, OutgoingMessage, Receipt, SessionHandle } from "./jouzu-api";

let clientSequence = 0;

/** One identity per page load so a reconnect resumes instead of duplicating. */
export function newClientId(): string {
  clientSequence += 1;
  return `desktop-${globalThis.crypto.randomUUID().slice(0, 8)}-${clientSequence}`;
}

export class HostChatSession {
  private cursor: number | undefined;
  private unsubscribe?: () => void;

  private constructor(
    private readonly api: JouzuApi,
    readonly id: string,
    readonly clientId: string,
    private readonly handle: SessionHandle,
  ) {
    this.cursor = handle.cursor;
  }

  /** Attach to a saved session, or create a pending one when no path is given. */
  static async open(api: JouzuApi, workspacePath: string, sessionPath?: string): Promise<HostChatSession> {
    const clientId = newClientId();
    const handle = await api.sessions.attach(workspacePath, sessionPath);
    return new HostChatSession(api, handle.sessionId, clientId, handle);
  }

  get sessionPath(): string | null {
    return this.handle.sessionPath ?? null;
  }

  history(page: { limit?: number; before?: number } = {}): Promise<HistoryPage> {
    return this.api.sessions.history(this.id, page);
  }

  send(message: OutgoingMessage): Promise<Receipt> {
    return this.api.sessions.send(this.id, { ...message, clientId: message.clientId ?? this.clientId });
  }

  interrupt(): Promise<void> {
    return this.api.sessions.interrupt(this.id);
  }

  cancel(clientMessageId: string): Promise<void> {
    return this.api.sessions.cancel(this.id, clientMessageId);
  }

  queue(action: "continue" | "discard" | "retry"): Promise<void> {
    return this.api.sessions.queue(this.id, action);
  }

  /** Close this client's stream. The session itself keeps running. */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async stop(): Promise<void> {
    this.detach();
    await this.api.sessions.stop(this.id);
  }

  /** Follow the session. The cursor advances with every delivered event. */
  follow(
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
    capabilities: string[] = ["view", "control", "prompts"],
  ): void {
    this.detach();
    this.unsubscribe = this.api.subscribe(
      this.id,
      this.clientId,
      capabilities,
      this.cursor,
      event => {
        this.cursor = event.id;
        onEvent(event);
      },
      onError,
    );
  }
}