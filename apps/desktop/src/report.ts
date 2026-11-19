import { openUrl } from '@tauri-apps/plugin-opener';

/** The page a report is written on; opening it is the whole action. */
const ISSUES_URL = 'https://github.com/shisa-ai/jouzu-desktop/issues';

export async function openReport(): Promise<void> {
  await openUrl(ISSUES_URL);
}

