import { object } from "../chat-projection";
import { ToolOutput } from "./tool-output";
import { ToolFrame, ToolSection } from "./tool-frame";
import type { ToolRendererProps } from "./types";
import { chatTexts, fill, useChatText, type ChatText } from "../chat-text";

const labeled = (t: ChatText): Record<string, { title: string; summary: (args: Record<string, unknown>) => string | undefined }> => ({
  bash: { title: t.toolCommand, summary: args => typeof args.command === "string" ? args.command : undefined },
  read: { title: t.toolRead, summary: args => typeof args.path === "string" ? args.path : undefined },
  grep: { title: t.toolSearch, summary: args => [args.pattern, args.path].filter(value => typeof value === "string").join(" · ") || undefined },
  ls: { title: t.toolList, summary: args => typeof args.path === "string" ? args.path : undefined },
  write: { title: t.toolWrite, summary: args => typeof args.path === "string" ? args.path : undefined },
  edit: { title: t.edit, summary: args => typeof args.path === "string" ? args.path : undefined },
  apply_patch: { title: t.toolPatch, summary: args => typeof args.patch === "string" ? args.patch.split("\n")[0] : undefined },
  web_fetch: { title: t.toolFetch, summary: args => typeof args.url === "string" ? args.url : undefined },
  batch_web_fetch: {
    title: t.toolBatchFetch,
    summary: args => {
      const urls = Array.isArray(args.urls) ? args.urls : [];
      return urls.length ? fill(t.urlCount, { n: urls.length }) : undefined;
    },
  },
  "tff-search_web": { title: t.toolWebSearch, summary: args => typeof args.query === "string" ? args.query : undefined },
  get_goal: { title: t.toolGoal, summary: args => typeof args.status === "string" ? args.status : undefined },
  vcc_recall: { title: t.toolRecall, summary: args => typeof args.query === "string" ? args.query : undefined },
});
export function isSimpleTool(name: string) { return name in labeled(chatTexts.en); }
export function SimpleToolRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const definition = labeled(t)[tool.name]!;
  const args = object(tool.args) ? tool.args : {};
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const argumentText = tool.args === undefined ? undefined : JSON.stringify(tool.args, null, 2);
  return <ToolFrame title={definition.title} subtitle={definition.summary(args)} state={state}>
    <ToolOutput tool={tool} />
    {argumentText && <ToolSection label={t.arguments} copyText={argumentText}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-muted-foreground">{argumentText}</pre>
    </ToolSection>}
  </ToolFrame>;
}
