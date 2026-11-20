import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { ComponentSection, useComponent } from './components/component-row';
import { messages, type Locale } from './i18n';

interface Resolution { name: string; path: string | null }
export interface CommandEntryState {
  directory: string;
  shims: boolean;
  onPath: boolean;
  position: 'absent' | 'first' | 'later';
  first: boolean;
  shadowed: boolean;
  commands: Resolution[];
}

const within = (path: string, directory: string) => {
  const normal = (value: string) => value.replaceAll(String.fromCharCode(92), '/').toLowerCase();
  return normal(path).startsWith(normal(directory) + '/');
};

/** The terminal command: jz and jouzu, which the app puts on the PATH when it installs. */
export function CommandEntrySection({ locale }: { locale: Locale }) {
  const t = messages[locale];
  const { state, busy, error, run } = useComponent<CommandEntryState>('command_entry_report');
  if (!state) return <ComponentSection title={t.commandEntry} status={t.checking} busy={busy} error={error} installLabel={t.commandEntryInstall} />;
  // A command another program provides is not Jouzu's to replace without asking, and a command that does
  // not run is repaired rather than installed again.
  const provided = state.commands.some(entry => entry.path && !within(entry.path, state.directory));
  const installed = state.shims && (state.first || (state.onPath && !provided));
  const install = () => void run(async () => {
    if (provided && !await confirm(t.commandEntryConfirm, { kind: 'warning' })) return state;
    return invoke<CommandEntryState>('command_entry_use');
  });
  // One action, and which one it is follows the state: the file that does not answer is
  // repaired, a command that is not the one answering is installed. A command that
  // already answers is in use, so the slot is empty (ui-layer §6.3).
  const action = !state.shims
    ? { label: t.commandEntryRepair, run: () => void run(() => invoke<CommandEntryState>('command_entry_repair')) }
    : installed
      ? null
      : { label: t.commandEntryInstall, run: install };
  return <ComponentSection
    title={t.commandEntry}
    status={!state.shims ? t.commandEntryBroken : installed ? t.commandEntryOn : t.gitBashMissing}
    tone={state.shims ? 'ok' : 'missing'}
    busy={busy} error={error}
    install={action?.run}
    installLabel={action?.label ?? t.commandEntryInstall}
  />;
}
