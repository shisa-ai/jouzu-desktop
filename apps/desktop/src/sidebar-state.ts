/**
 * Which workspace groups the user closed. A group is open by default so a session is
 * reachable, but a group the user collapsed must stay collapsed: the list used to
 * reset on every remount, which reopened groups on its own.
 */
const KEY = "jouzu.ui.collapsed-workspaces";

export function loadCollapsed(store: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(next: Set<string>, store: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* A webview without storage keeps the choice for this session only. */
  }
}

export function toggleCollapsed(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}