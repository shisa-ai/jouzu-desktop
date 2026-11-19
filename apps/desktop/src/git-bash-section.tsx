import { invoke } from '@tauri-apps/api/core';
import { messages, type Locale } from './i18n';
import { ComponentSection, describe, useComponent, type ComponentApi } from './components/component-row';

interface Environment { path: string; git: string; bash: string }
export interface GitBashState {
  bundled: Environment | null;
  managed: Environment | null;
  system: Environment | null;
  /** A copy that is on disk but does not answer a launch; the row offers to repair it. */
  bundled_present: boolean;
  managed_present: boolean;
  system_present: boolean;
  archive: boolean;
  effective: Environment | null;
}

/** The version without the prefix the command prints, for display in the row. */
const version = (reported?: string) => reported?.replace(/^git version\s+/i, '') ?? '';


/** The Git Bash component: the copy in use, and the other copy the user can move to. */
export function GitBashSection({ locale, api }: { locale: Locale; api: ComponentApi<GitBashState> }) {
  const t = messages[locale];
  const { state, busy, error, run } = api;
  if (!state) return <ComponentSection title={t.gitBash} status={t.checking} busy={busy} error={error} installLabel={t.gitBashInstall} />;
  const own = state.bundled ?? state.managed;
  const installed = Boolean(state.effective);
  const usingSystem = installed && state.effective?.path === state.system?.path;
  // A copy that is here without answering a launch is repaired, not installed again; a copy this PC
  // keeps is only reported, because repairing another installation is not this app's business.
  const ownBroken = !installed && !own && (state.bundled_present || state.managed_present);
  const systemBroken = !installed && !ownBroken && state.system_present;
  // The copy in use is named, and the copy Jouzu ships is offered until it answers a launch.
  return <ComponentSection
    title={t.gitBash}
    status={installed
      ? describe([usingSystem ? t.gitBashSystem : t.gitBashBundled, version(state.effective?.git)])
      : ownBroken ? t.gitBashBroken : systemBroken ? t.gitBashSystemBroken : t.gitBashMissing}
    tone={installed ? 'ok' : 'missing'}
    note={installed ? undefined : t.gitBashRequired}
    busy={busy} error={error}
    install={own ? undefined : () => void run(() => invoke<GitBashState>('git_bash_install'))}
    installLabel={ownBroken ? t.gitBashRepair : `${t.gitBashInstall} (${t.recommended})`}
  />;
}

export function useGitBash(): ComponentApi<GitBashState> {
  return useComponent<GitBashState>('git_bash');
}
