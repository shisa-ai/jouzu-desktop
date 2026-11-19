export type Environment = { kind: "windows" | "macos" | "linux" } | { kind: "wsl"; distro: string };
export interface Workspace { id: string; path: string; environment: Environment }
export function environmentLabel(environment: Environment): string {
  switch (environment.kind) {
    case "windows": return "Windows";
    case "macos": return "macOS";
    case "linux": return "Linux";
    case "wsl": return `${environment.distro} · WSL`;
  }
}
// Backend canonicalizes paths; never equate paths belonging to different distros.
export function rememberWorkspace(history: Workspace[], workspace: Workspace): Workspace[] {
  return [workspace, ...history.filter(item => item.id !== workspace.id)].slice(0, 20);
}
