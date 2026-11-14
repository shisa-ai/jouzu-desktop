import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bug, ExternalLink } from 'lucide-react';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { messages, type Locale } from './i18n';
import { openReport } from './report';
import { ErrorLine } from "./session-alerts-view";

/** Reporting opens the project's own issue page, which is where a report is written and sent. */
export function ReportSection({ locale }: { locale: Locale }) {
  const t = messages[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openLogs() {
    setError(null);
    try {
      await invoke('open_logs');
    } catch (failure) {
      setError(String(failure));
    }
  }

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await openReport();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  return <Card className="border-border shadow-none">
    <CardHeader><CardTitle>{t.reportTitle}</CardTitle></CardHeader>
    <CardContent className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void open()}>
          <Bug aria-hidden="true" />{t.reportAction}<ExternalLink aria-hidden="true" />
        </Button>
        <Button onClick={() => void openLogs()}>{t.logsOpen}</Button>
      </div>
      {error && <ErrorLine raw={error} failed="Could not create the report." onDismiss={() => setError(null)} />}
    </CardContent>
  </Card>;
}
