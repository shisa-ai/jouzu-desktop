import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Sparkles } from "lucide-react";
import { useApi } from "./api/context";
import type { AssistantSnapshot } from "./api/jouzu-api";
import { Button } from "./components/ui/button";
import { ChatMarkdown } from "./chat-markdown";
import { describeError } from "./runtime-errors";

/** A host-managed session: no workspace, model, or coding-command controls. */
export function AssistantWorkspace() {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    setOpening(true);
    setError(null);
    const load = api.sessions.assistant;
    void (load ? load() : Promise.reject(new Error("Assistant is unavailable on this host.")))
      .then(value => { if (!disposed) setSnapshot(value); })
      .catch(value => { if (!disposed) setError(describeError(value)); })
      .finally(() => { if (!disposed) setOpening(false); });
    return () => { disposed = true; };
  }, [api, attempt]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [snapshot?.messages.length, sending]);
  async function send() {
    const text = draft.trim();
    if (!api.sessions.sendAssistant || !text || submitting.current || opening) return;
    submitting.current = true;
    setSending(true);
    setError(null);
    try {
      setSnapshot(await api.sessions.sendAssistant(text));
      setDraft(value => value.trim() === text ? "" : value);
    } catch (value) {
      setError(describeError(value));
      // An admitted turn or metadata change may have persisted even if its reply failed.
      try { if (api.sessions.assistant) setSnapshot(await api.sessions.assistant()); } catch { /* Keep the original failure visible. */ }
    } finally { submitting.current = false; setSending(false); }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    {snapshot?.messages.length ? <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5"><div className="mx-auto max-w-3xl space-y-5">{snapshot.messages.map((message, index) => <article key={index} aria-label={`${message.role} message`} className={message.role === "user" ? "rounded-xl bg-muted p-4" : "px-1"}><ChatMarkdown text={message.text} /></article>)}<div ref={end} /></div></div> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card"><Sparkles className="size-6 text-primary" aria-hidden="true" /></span>
      <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
      <p className="max-w-md text-sm text-muted-foreground">Organize projects, connect workspaces, and keep track of sessions.</p>
    </div>}
    <div className="mx-auto w-full max-w-3xl px-4 pb-5">
      {!!snapshot?.projects.length && <details className="mb-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Projects ({snapshot.projects.length})</summary><ul className="mt-2 max-h-40 space-y-2 overflow-auto">{snapshot.projects.map(project => <li key={project.id} className="rounded-lg border border-border p-2"><strong>{project.name}</strong>{project.description && <p className="text-muted-foreground">{project.description}</p>}<span className="text-xs text-muted-foreground">{project.workspaceIds.length} workspaces · {project.sessionIds.length} sessions</span></li>)}</ul></details>}
      {error && <div role="alert" className="mb-3 rounded-lg border border-destructive/40 p-3 text-sm"><p>{error}</p>{!sending && <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Reload Assistant</Button>}</div>}
      <form aria-label="Assistant composer" onSubmit={event => { event.preventDefault(); void send(); }} className="rounded-2xl border border-border bg-card p-3">
        <textarea aria-label="Message Assistant" placeholder="Ask Assistant to organize your work…" rows={3} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        <div className="flex items-center justify-between gap-2">
          <span role="status" className="text-xs text-muted-foreground">{opening ? "Connecting Assistant…" : sending ? "Working…" : "Project and session coordination"}</span>
          <Button type="submit" className="size-8 p-0" aria-label="Send to Assistant" disabled={opening || sending || !snapshot || !draft.trim()}>{opening || sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button>
        </div>
      </form>
    </div>
  </div>;
}
