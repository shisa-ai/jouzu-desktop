/**
 * The files a turn actually produced, independent of which tool wrote them.
 *
 * The transcript only carries the arguments of edit-like tools, so a file created by
 * a shell command never appeared in the turn summary. Comparing a workspace snapshot
 * taken when the turn started with one taken when it settled reports what really
 * changed on disk.
 */
export interface WorkspaceFile {
  path: string;
  size: number;
  modified: number;
}
export interface WorkspaceSnapshot {
  files: WorkspaceFile[];
  truncated?: boolean;
}

const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();

/** Files added or modified between two snapshots. Deletions are not outputs. */
export function changedFiles(before: WorkspaceSnapshot | null | undefined, after: WorkspaceSnapshot): string[] {
  if (!before) return [];
  const previous = new Map(before.files.map(file => [key(file.path), file]));
  const changed: string[] = [];
  for (const file of after.files) {
    const old = previous.get(key(file.path));
    if (!old || old.size !== file.size || old.modified !== file.modified) changed.push(file.path);
  }
  return changed;
}

/** Whether the snapshot stopped early; the summary must say it may be incomplete. */
export function snapshotComplete(snapshot: WorkspaceSnapshot | null | undefined): boolean {
  return !!snapshot && snapshot.truncated !== true;
}