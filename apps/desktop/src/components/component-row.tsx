import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../components/ui/button';
import { ErrorLine } from "../session-alerts-view";
import { useChatText } from "../chat-text";

/** One row of the System section: which copy a component uses, and what is still missing. */
export function ComponentSection({ title, status, note, tone, busy, error, install, installLabel }: {
  title: string; status?: string; note?: string; tone?: 'ok' | 'missing';
  busy: boolean; error: string | null;
  install?: () => void; installLabel: string;
}) {
  const t = useChatText();
  return <section className="flex flex-col gap-2 border-t border-border px-5 py-4" aria-label={title}>
    <div>
      <h3 className="font-medium">{title}</h3>
      {status && <p className={`mt-1 text-sm ${tone === 'missing' ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>}
    </div>
    <div className="flex min-h-10 items-center gap-2">
        {<span className="flex size-4 items-center justify-center">{busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}</span>}
        {/* The slot keeps its height, but holds a button only when an action applies
            (ui-layer §6.3). Checking and a copy in use leave it empty. */}
        {<span className="flex h-10 min-w-40 items-center">{install && !busy ? <Button onClick={install}>{installLabel}</Button> : null}</span>}
    </div>
    {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
    {error && <ErrorLine raw={error} failed={t.componentActionFailed} />}
  </section>;
}

/** Joins what is known about a component, leaving out what is not. */
export const describe = (parts: (string | undefined)[]) => parts.filter(part => part).join(' · ');

export interface ComponentApi<State> {
  state: State | null;
  busy: boolean;
  error: string | null;
  run: (call: () => Promise<State>) => Promise<void>;
}

/** Reads a component's state and keeps it in step with the actions its row offers. */
export function useComponent<State>(command: string, enabled = true): ComponentApi<State> {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    try {
      const value = await invoke<State>(command);
      setState(value && typeof value === 'object' ? value : null);
    } catch (failure) { setError(String(failure)); }
  }, [command]);
  useEffect(() => { if (!enabled) return; void read(); }, [read, enabled]);
  const run = useCallback(async (call: () => Promise<State>) => {
    setBusy(true); setError(null);
    try {
      const value = await call();
      setState(value && typeof value === 'object' ? value : null);
    }
    catch (failure) { setError(String(failure)); await read(); }
    finally { setBusy(false); }
  }, [read]);
  return { state, busy, error, run };
}
