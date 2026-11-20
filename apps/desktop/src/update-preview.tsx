import { Download, RefreshCw, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from './components/ui/dialog';
import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Progress } from './components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import type { Locale } from './i18n';
import { ErrorLine } from "./session-alerts-view";

/** One row: the product the person installed, with the runtime as its detail (ui-layer §6.2). */
const labels: Record<Locale, {
  title: string; description: string; product: string; check: string;
  runtime: string; runtimeMissing: string;
  availableTag: string; upToDate: string; updateDesktop: string; testBuild: string; installOlder: string;
  checking: string; downloading: string; installing: string;
  checkFailed: string; installFailed: string; retry: string; restart: string; olderHint: string; cancel: string;
  channel: string; stable: string; qa: string; qaHint: string;
}> = {
  en: {
    title: 'System', description: 'Jouzu Desktop and the tools it needs.', product: 'Jouzu Desktop', check: 'Check for updates',
    runtime: 'Runtime {version}', runtimeMissing: 'The runtime is missing.',
    availableTag: 'Update available', upToDate: 'Up to date', updateDesktop: 'Update and restart',
    testBuild: 'This is a test build', installOlder: 'Install Stable {version} (older)',
    checking: 'Checking…', downloading: 'Downloading…', installing: 'Installing…',
    checkFailed: 'Could not check for updates', installFailed: 'Could not install the update', retry: 'Retry',
    restart: 'Jouzu Desktop restarts after updating.',
    olderHint: 'This installs an older version of Jouzu Desktop. Your data stays.',
    cancel: 'Cancel',
    channel: 'Update channel', stable: 'Stable', qa: 'QA (test builds)',
    qaHint: 'QA updates this installation in place and keeps your data. Switch back to Stable at any time.',
  },
  ja: {
    title: 'システム', description: 'Jouzu Desktop と、必要なツールの状態です。', product: 'Jouzu Desktop', check: '更新を確認',
    runtime: 'ランタイム {version}', runtimeMissing: 'ランタイムが見つかりません。',
    availableTag: '更新があります', upToDate: '最新です', updateDesktop: '更新して再起動',
    testBuild: 'これはテストビルドです', installOlder: '安定版 {version} をインストール（古い版）',
    checking: '確認中…', downloading: 'ダウンロード中…', installing: 'インストール中…',
    checkFailed: '更新を確認できませんでした', installFailed: '更新をインストールできませんでした', retry: '再試行',
    restart: '更新後に Jouzu Desktop を再起動します。',
    olderHint: 'Jouzu Desktop の古いバージョンをインストールします。データはそのまま残ります。',
    cancel: 'キャンセル',
    channel: '更新チャネル', stable: '安定版', qa: 'QA（テスト版）',
    qaHint: 'QA はこのインストールをそのまま更新し、データも引き継ぎます。いつでも安定版に戻せます。',
  },
  'zh-Hans': {
    title: '系统', description: 'Jouzu Desktop 以及所需工具的状态。', product: 'Jouzu Desktop', check: '检查更新',
    runtime: '运行环境 {version}', runtimeMissing: '运行环境缺失。',
    availableTag: '有可用更新', upToDate: '已是最新', updateDesktop: '更新并重启',
    testBuild: '这是测试版', installOlder: '安装正式版 {version}（较旧）',
    checking: '正在检查…', downloading: '正在下载…', installing: '正在安装…',
    checkFailed: '暂时无法检查更新', installFailed: '更新未能安装', retry: '重试',
    restart: '更新后将重新启动 Jouzu Desktop。',
    olderHint: '这将安装较旧的 Jouzu Desktop 版本。你的数据会保留。',
    cancel: '取消',
    channel: '更新通道', stable: '正式版', qa: 'QA（测试版）',
    qaHint: 'QA 在原安装上直接升级，沿用你的数据。可随时切回正式版。',
  },
  'zh-Hant': {
    title: '系統', description: 'Jouzu Desktop 以及所需工具的狀態。', product: 'Jouzu Desktop', check: '檢查更新',
    runtime: '執行環境 {version}', runtimeMissing: '執行環境遺失。',
    availableTag: '有可用更新', upToDate: '已是最新', updateDesktop: '更新並重新啟動',
    testBuild: '這是測試版', installOlder: '安裝正式版 {version}（較舊）',
    checking: '正在檢查…', downloading: '正在下載…', installing: '正在安裝…',
    checkFailed: '暫時無法檢查更新', installFailed: '更新未能安裝', retry: '重試',
    restart: '更新後將重新啟動 Jouzu Desktop。',
    olderHint: '這將安裝較舊的 Jouzu Desktop 版本。你的資料會保留。',
    cancel: '取消',
    channel: '更新通道', stable: '正式版', qa: 'QA（測試版）',
    qaHint: 'QA 在原安裝上直接升級，沿用你的資料。可隨時切回正式版。',
  },
};

const noteText: Record<Locale, [string, string]> = {
  en: ["What's new", 'No description was published for this version.'],
  ja: ['変更点', 'このバージョンの説明は公開されていません。'],
  'zh-Hans': ['更新内容', '此版本未发布说明。'],
  'zh-Hant': ['更新內容', '此版本未發布說明。'],
};

export type Phase = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'installing' | 'error';

export interface DesktopUpdateState {
  /** The version of the app that is installed. */
  version: string | null;
  /** Commit and build identity, shown as a tooltip on the version. */
  stamp: string | null;
  phase: Phase;
  target: string | null;
  /** The channel's latest is older than this build (a QA build on Stable, #176). */
  downgrade: boolean;
  notes: string | null;
  progress?: number;
  error: string | null;
  /** Online updates are not configured for this build (a development build). */
  configured: boolean;
  /** The channel feed, shown beside the state that can follow it. */
  channel?: { value: 'stable' | 'qa'; set: (value: 'stable' | 'qa') => void };
  check: () => void;
  install: () => void;
}

export interface RuntimeDetailState {
  version: string | null;
  /** A runtime that is missing or does not start gets the row's one action: Repair. */
  broken: boolean;
}

const noteItems = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) =>
  line.startsWith('### ')
    ? <li key={index} className="text-xs font-medium text-muted-foreground">{line.slice(4)}</li>
    : line.startsWith('- ')
      ? <li key={index} className="flex gap-2 text-xs text-muted-foreground"><span aria-hidden="true">•</span><span>{line.slice(2)}</span></li>
      : <li key={index} className="text-xs text-muted-foreground">{line}</li>);

/** The one Jouzu Desktop row, driven by the state the shell reports. */
export function UpdatePreview({ locale, live, runtime, focusIndex, repair }: {
  locale: Locale;
  live: DesktopUpdateState;
  runtime: RuntimeDetailState;
  focusIndex?: number | null;
  repair?: { label: string; run: () => void };
}) {
  const t = labels[locale];
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const row = useRef<HTMLElement | null>(null);
  // A jump from the header lands on the row that has something waiting, so the guidance is one step, not a search.
  useEffect(() => {
    if (focusIndex === null || focusIndex === undefined) return;
    if (row.current) row.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(true);
    const timer = setTimeout(() => setHighlight(false), 2400);
    return () => clearTimeout(timer);
  }, [focusIndex]);
  const busy = ['checking', 'downloading', 'installing'].includes(live.phase);
  const state = live.phase;
  // A broken runtime is the row's one concern: Repair, not an update it cannot run.
  const broken = runtime.broken && !!repair;
  const realUpdate = state === 'available' && !live.downgrade && !broken;
  const testBuild = state === 'available' && live.downgrade && !broken;
  const channel = live.channel && !broken && ['current', 'available', 'error'].includes(state) ? live.channel : undefined;
  return <div className="space-y-6">
    <Dialog open={confirmInstall} onOpenChange={setConfirmInstall}><DialogContent className="sm:max-w-sm"><DialogTitle>{live.downgrade ? t.testBuild : t.updateDesktop}</DialogTitle><DialogDescription>{live.downgrade ? t.olderHint : t.restart}</DialogDescription><div className="flex justify-end gap-2"><DialogClose asChild><Button variant="outline">{t.cancel}</Button></DialogClose><Button onClick={() => { setConfirmInstall(false); live.install(); }}>{live.downgrade ? t.installOlder.replace('{version}', live.target ?? '') : t.updateDesktop}</Button></div></DialogContent></Dialog>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t.title}</h2><p className="mt-1 text-sm text-muted-foreground">{t.description}</p></div><Button variant="ghost" className="h-9 w-9 p-0" aria-label={t.check} title={t.check} disabled={busy || !live.configured} onClick={live.check}><RefreshCw className={`size-4 ${state === 'checking' ? 'animate-spin' : ''}`} /></Button></div>
    <div className="rounded-lg border border-border px-5">
      <section ref={element => { row.current = element; }} aria-label={t.product} className={`flex min-h-32 flex-col gap-3 py-4 transition-shadow ${highlight ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-medium">{t.product}</h3>
            <p className="mt-1 text-sm text-muted-foreground" title={live.stamp ?? undefined} data-desktop-version>{live.version ?? ''}</p>
            <p className="mt-1 text-xs text-muted-foreground">{runtime.broken || !runtime.version ? t.runtimeMissing : t.runtime.replace('{version}', runtime.version)}</p>
          </div>
          {runtime.broken && repair
            ? <Button variant="outline" disabled={busy} onClick={repair.run}>{repair.label}</Button>
            : realUpdate
              ? <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{t.availableTag}</span><Button disabled={busy} onClick={() => setConfirmInstall(true)}><Download className="size-4" />{t.updateDesktop}</Button></div>
              : state === 'error'
                ? <Button variant="outline" className="h-9 w-9 p-0" aria-label={t.retry} title={t.retry} disabled={busy} onClick={() => (live.target ? live.install() : live.check())}><RefreshCw className="size-4" /></Button>
                : state === 'downloading' || state === 'installing'
                  ? <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{state === 'downloading' ? t.downloading : t.installing}</span>
                  : state === 'checking'
                    ? <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t.checking}</span>
                    : state === 'current'
                      ? <span role="status" className="text-sm text-muted-foreground">{t.upToDate}</span>
                      : testBuild
                        ? <span role="status" className="text-sm text-muted-foreground">{t.testBuild}</span>
                        : null}
        </div>
        <div className="flex flex-col gap-2">
          {testBuild && <>
            <p><Button variant="outline" disabled={busy} onClick={() => setConfirmInstall(true)}>{t.installOlder.replace('{version}', live.target ?? '')}</Button></p>
            {channel && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t.channel}</span><Select value={channel.value} disabled={busy} onValueChange={value => channel.set(value as 'stable' | 'qa')}><SelectTrigger aria-label={t.channel} className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stable">{t.stable}</SelectItem><SelectItem value="qa">{t.qa}</SelectItem></SelectContent></Select>{channel.value === 'qa' && <p className="w-full text-xs text-muted-foreground">{t.qaHint}</p>}</div>}
          </>}
          {realUpdate && <>
            {channel && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t.channel}</span><Select value={channel.value} disabled={busy} onValueChange={value => channel.set(value as 'stable' | 'qa')}><SelectTrigger aria-label={t.channel} className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stable">{t.stable}</SelectItem><SelectItem value="qa">{t.qa}</SelectItem></SelectContent></Select>{channel.value === 'qa' && <p className="w-full text-xs text-muted-foreground">{t.qaHint}</p>}</div>}
            {live.notes
              ? <div className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2"><p className="text-xs font-medium">{noteText[locale][0]}</p><ul className="mt-1 space-y-1">{noteItems(live.notes)}</ul></div>
              : <p className="text-xs text-muted-foreground">{noteText[locale][1]}</p>}
          </>}
          {state === 'current' && channel && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t.channel}</span><Select value={channel.value} disabled={busy} onValueChange={value => channel.set(value as 'stable' | 'qa')}><SelectTrigger aria-label={t.channel} className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stable">{t.stable}</SelectItem><SelectItem value="qa">{t.qa}</SelectItem></SelectContent></Select>{channel.value === 'qa' && <p className="w-full text-xs text-muted-foreground">{t.qaHint}</p>}</div>}
          {/* A row with a target failed while installing it; one without failed to check. */}
          {state === 'error' && <ErrorLine raw={live.error ?? ''} failed={live.target ? t.installFailed : t.checkFailed} />}
          {state === 'error' && channel && <div className="flex flex-wrap items-center gap-3"><span className="text-sm">{t.channel}</span><Select value={channel.value} disabled={busy} onValueChange={value => channel.set(value as 'stable' | 'qa')}><SelectTrigger aria-label={t.channel} className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stable">{t.stable}</SelectItem><SelectItem value="qa">{t.qa}</SelectItem></SelectContent></Select></div>}
          {(state === 'downloading' || state === 'installing') && <Progress value={state === 'downloading' ? live.progress : undefined} />}
        </div>
      </section>
    </div>
  </div>;
}