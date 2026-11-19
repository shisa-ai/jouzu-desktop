import type { ReactNode } from "react";
import { ToolFrame, type ToolState } from "./tool-frame";

export type ActivityState = ToolState;
export { StateDot } from "./tool-frame";

/** Compatibility wrapper: every renderer that used ActivityRow now shares the
 * same disclosure, status badge and header geometry as the rest of the chat. */
export function ActivityRow({ title, summary, state, children, defaultOpen = false }: {
  title: string;
  summary?: string | undefined;
  state: ActivityState;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  return <ToolFrame title={title} subtitle={summary} state={state} defaultOpen={defaultOpen}>
    {children}
  </ToolFrame>;
}
