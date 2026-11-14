import { Download, RefreshCw, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from './components/ui/dialog';
import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Progress } from './components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import type { Locale } from './i18n';
import { ErrorLine } from "./session-alerts-view";

/** The two update rows: Jouzu first, then the launcher that carries them. */
const labels: Record<Locale, {
  title: string; description: string; check: string; launcher: string; currentVersion: string;
  available: string; availableTag: string; upToDate: string; updateJouzu: string; updateLauncher: string;
  checking: string; downloading: string; installing: string; updated: string;
  checkFailed: string; retry: string; restart: string; cancel: string; unavailable: string;
  channel: string; stable: string; qa: string; qaHint: string; back: string;
}> = {
  en: {
    title: 'System', description: 'Jouzu, the launcher, and the tools they need.', check: 'Check for updates',
    launcher: 'Launcher', currentVersion: 'Current version', available: 'Available', availableTag: 'Update available', upToDate: 'Up to date',
    updateJouzu: 'Update Jouzu', updateLauncher: 'Update and restart', checking: 'Checking…',
    downloading: 'Downloading…', installing: 'Installing…', updated: 'Updated',
    checkFailed: 'Could not check for updates', retry: 'Retry',
    restart: 'The launcher restarts after updating.', cancel: 'Cancel',
    unavailable: 'Online updates are unavailable for this version.',
    channel: 'Update channel', stable: 'Stable', qa: 'QA (test builds)', qaHint: 'QA updates this installation in place and keeps your data. Switch back to Stable at any time.', back: 'Back to Stable (older than this build)',
  },
  ja: {
    title: 'システム', description: 'Jouzu、ランチャー、および必要なツールの状態です。', check: '更新を確認',
    launcher: 'ランチャー', currentVersion: '現在のバージョン', available: '更新先', availableTag: '更新があります', upToDate: '最新です',
    updateJouzu: 'Jouzu を更新', updateLauncher: '更新して再起動', checking: '確認中…',
    downloading: 'ダウンロード中…', installing: 'インストール中…', updated: '更新しました',
    checkFailed: '更新を確認できませんでした', retry: '再試行',
    restart: '更新後にランチャーを再起動します。', cancel: 'キャンセル',
    unavailable: 'このバージョンではオンライン更新を利用できません。',
    channel: '更新チャネル', stable: '安定版', qa: 'QA（テスト版）', qaHint: 'QA はこのインストールをそのまま更新し、データも引き継ぎます。いつでも安定版に戻せます。', back: '安定版に戻す（このビルドより古い版）',
  },
  'zh-Hans': {
    title: '系统', description: '查看 Jouzu、启动器以及所需工具的状态。', check: '检查更新',
    launcher: '启动器', currentVersion: '当前版本', available: '可更新至', availableTag: '有可用更新', upToDate: '已是最新',
    updateJouzu: '更新 Jouzu', updateLauncher: '更新并重启', checking: '正在检查…',
    downloading: '正在下载…', installing: '正在安装…', updated: '更新完成',
    checkFailed: '暂时无法检查更新', retry: '重试',
    restart: '更新后将重新启动启动器。', cancel: '取消',
    unavailable: '此版本暂不支持在线更新。',
    channel: '更新通道', stable: '正式版', qa: 'QA（测试版）', qaHint: 'QA 在原安装上直接升级，沿用你的数据。可随时切回正式版。', back: '切回正式版（比当前版本旧）',
  },
  'zh-Hant': {
    title: '系統', description: '查看 Jouzu、啟動器以及所需工具的狀態。', check: '檢查更新',
    launcher: '啟動器', currentVersion: '目前版本', available: '可更新至', availableTag: '有可用更新', upToDate: '已是最新',
    updateJouzu: '更新 Jouzu', updateLauncher: '更新並重新啟動', checking: '正在檢查…',
    downloading: '正在下載…', installing: '正在安裝…', updated: '更新完成',
    checkFailed: '暫時無法檢查更新', retry: '重試',
    restart: '更新後將重新啟動啟動器。', cancel: '取消',
    unavailable: '此版本暫不支援線上更新。',
    channel: '更新通道', stable: '正式版', qa: 'QA（測試版）', qaHint: 'QA 在原安裝上直接升級，沿用你的資料。可隨時切回正式版。', back: '切回正式版（比目前版本舊）',
  },
};

const noteText: Record<Locale, [string, string, string]> = {
  en: ["What's new", 'Source:', 'No description was published for this version.'],
  ja: ['変更点', '出典:', 'このバージョンの説明は公開されていません。'],
  'zh-Hans': ['更新内容', '来源：', '此版本未发布说明。'],
  'zh-Hant': ['更新內容', '來源：', '此版本未發布說明。'],
};

export type Phase = 'available' | 'current' | 'checking' | 'downloading' | 'installing' | 'complete' | 'error' | 'idle';
export interface UpdateViewState {
  phases: Phase[]; versions: string[]; targets: (string | null)[]; progress?: number;
  configured: boolean[]; errors: (string | null)[]; notes: string[]; sources: string[];
  check: () => void; install: (index: number) => void;
  /** The launcher row's feed. Absent where online updates are not configured. */
  channel?: { value: 'stable' | 'qa'; set: (value: 'stable' | 'qa') => void; downgrade: boolean };
  /** The Jouzu row offers this when the application files are not there to run. */
  repair?: { label: string; run: () => void };
}

const noteItems = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) =>
  line.startsWith('### ')
    ? <li key={index} className="text-xs font-medium text-muted-foreground">{line.slice(4)}</li>
    : line.startsWith('- ')
      ? <li key={index} className="flex gap-2 text-xs text-muted-foreground"><span aria-hidden="true">•</span><span>{line.slice(2)}</span></li>
      : <li key={index} className="text-xs text-muted-foreground">{line}</li>);

/** The update rows, driven by the state the launcher reports. */
export function UpdatePreview({ locale, live, focusIndex }: { locale: Locale; live: UpdateViewState; focusIndex?: number | null }) {
  const t = labels[locale];
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  // A jump from the header lands on the row that actually has something waiting, so the guidance is one step, not a search.
  useEffect(() => {
    if (focusIndex === null || focusIndex === undefined) return;
    const row = rowRefs.current[focusIndex];
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(focusIndex);
    const timer = setTimeout(() => setHighlight(null), 2400);
    return () => clearTimeout(timer);
  }, [focusIndex]);
  const busy = live.phases.some(phase => ['checking', 'downloading', 'installing'].includes(phase));
  const start = (index: number) => (index === 0 ? live.install(index) : setConfirmRestart(true));
  return <div className="space-y-6">
    <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}><DialogContent className="sm:max-w-sm"><DialogTitle>{t.updateLauncher}</DialogTitle><DialogDescription>{t.restart}</DialogDescription><div className="flex justify-end gap-2"><DialogClose asChild><Button variant="outline">{t.cancel}</Button></DialogClose><Button onClick={() => { setConfirmRestart(false); live.install(1); }}>{t.updateLauncher}</Button></div></DialogContent></Dialog>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t.title}</h2><p className="mt-1 text-sm text-muted-foreground">{t.description}</p></div><Button variant="ghost" className="h-9 w-9 p-0" aria-label={t.check} title={t.check} disabled={busy} onClick={live.check}><RefreshCw className={`size-4 ${live.phases.includes('checking') ? 'animate-spin' : ''}`} /></Button></div>
    <div className="divide-y divide-border rounded-lg border border-border px-5">{live.phases.map((phase, index) => <section key={index} ref={element => { rowRefs.current[index] = element; }} aria-label={index === 0 ? 'Jouzu' : t.launcher} className={`flex min-h-32 flex-col gap-2 py-4 transition-shadow ${highlight === index ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 font-medium">{index === 0 ? 'Jouzu' : t.launcher}{phase === 'available' && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{t.availableTag}</span>}</h3><p className="mt-1 text-sm text-muted-foreground">{t.currentVersion} {live.versions[index]}</p>{index === 0 && live.repair && <p className="mt-2"><Button variant="outline" disabled={busy} onClick={live.repair.run}>{live.repair.label}</Button></p>}</div>
        {phase === 'available' ? <Button disabled={busy} onClick={() => start(index)}><Download className="size-4" />{index === 0 ? t.updateJouzu : t.updateLauncher}</Button>
          : phase === 'error' ? <Button variant="outline" className="h-9 w-9 p-0" aria-label={t.retry} title={t.retry} disabled={busy} onClick={() => (live.targets[index] ? start(index) : live.check())}><RefreshCw className="size-4" /></Button>
            : <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{['checking', 'downloading', 'installing'].includes(phase) && <LoaderCircle className="size-4 animate-spin" />}{phase === 'current' ? t.upToDate : phase === 'complete' ? t.updated : phase === 'checking' ? t.checking : phase === 'downloading' ? t.downloading : phase === 'installing' ? t.installing : ''}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {!live.configured[index] && <p className="text-sm text-muted-foreground">{t.unavailable}</p>}
        {phase === 'available' && <p className="text-sm text-muted-foreground">{index === 1 && live.channel?.downgrade ? t.back : t.available} {live.targets[index]}</p>}
        {index === 1 && live.channel && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t.channel}</span><Select value={live.channel.value} disabled={busy} onValueChange={value => live.channel?.set(value as 'stable' | 'qa')}><SelectTrigger aria-label={t.channel} className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stable">{t.stable}</SelectItem><SelectItem value="qa">{t.qa}</SelectItem></SelectContent></Select>{live.channel.value === 'qa' && <p className="w-full text-xs text-muted-foreground">{t.qaHint}</p>}</div>}
        {['available', 'complete'].includes(phase) && (live.notes[index]
          ? <div className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2"><p className="text-xs font-medium">{noteText[locale][0]}</p><ul className="mt-1 space-y-1">{noteItems(live.notes[index])}</ul>{live.sources[index] && <p className="mt-1 text-[10px] text-muted-foreground/70">{noteText[locale][1]} {live.sources[index]}</p>}</div>
          : <p className="text-xs text-muted-foreground">{noteText[locale][2]}</p>)}
        {phase === 'error' && <ErrorLine raw={live.errors[index] ?? ""} failed={t.checkFailed} />}
        {(phase === 'downloading' || phase === 'installing') && <Progress value={phase === 'downloading' ? live.progress : undefined} />}
      </div>
    </section>)}</div>
  </div>;
}
