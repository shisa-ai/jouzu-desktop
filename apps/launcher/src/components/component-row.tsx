import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../components/ui/button';
import { ErrorLine } from "../session-alerts-view";

/** One row of the System section: which copy a component uses, and what is still missing. */
export function ComponentSection({ title, status, note, tone, busy, error, install, installLabel }: {
  title: string; status?: string; note?: string; tone?: 'ok' | 'missing';
  busy: boolean; error: string | null;
  install?: () => void; installLabel: string;
}) {
  return <section className="flex flex-col gap-2 border-t border-border px-5 py-4" aria-label={title}>
    <div>
      <h3 className="font-medium">{title}</h3>
      {status && <p className={`mt-1 text-sm ${tone === 'missing' ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
        {<span className="flex size-4 items-center justify-center">{busy && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}</span>}
        {/* The action is always in the row: without an action it is disabled, so nothing the row shows
            arriving or leaving moves the layout. */}
        {<Button disabled={busy || !install} onClick={install}>{installLabel}</Button>}
    </div>
    {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
    {error && <ErrorLine raw={error} failed="This component action did not complete." />}
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
