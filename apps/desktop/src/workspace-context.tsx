import { createContext, useContext, type ReactNode } from "react";

/**
 * The session workspace root: the boundary for reading a local transcript image
 * and for resolving a relative path before a native reveal.
 */
export const WorkspaceContext = createContext<string | undefined>(undefined);

export function WorkspaceProvider({ path, children }: { path?: string; children: ReactNode }) {
  return <WorkspaceContext.Provider value={path}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceRoot(): string | undefined {
  return useContext(WorkspaceContext);
}