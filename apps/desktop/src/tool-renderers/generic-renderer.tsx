import { object } from "../chat-projection";
import { ToolFrame, ToolSection } from "./tool-frame";
import { ToolOutput } from "./tool-output";
import { toolText, type ToolRendererProps } from "./types";
import { useChatText } from "../chat-text";

/** Every tool gets a card, even when the runtime adds one we do not know yet. */
export function GenericRenderer({ tool }: ToolRendererProps) {
  const t = useChatText();
  const text = toolText(tool.result);
  const state = tool.phase === "running" ? "running" : tool.phase === "error" ? "error" : "done";
  const argumentText = tool.args === undefined ? undefined : JSON.stringify(tool.args, null, 2);
  const hasStructuredResult = !!object(tool.result);
  return <ToolFrame title={tool.name} subtitle={t.toolCall} state={state}>
    {tool.phase === "error" && !text && <p role="alert" className="text-[11px] text-destructive">{t.toolFailedSilently}</p>}
    {(text || hasStructuredResult) && <ToolOutput tool={tool} />}
    {argumentText && <ToolSection label={t.arguments} copyText={argumentText}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-muted-foreground">{argumentText}</pre>
    </ToolSection>}
    {!argumentText && !text && !hasStructuredResult && <p className="text-[11px] text-muted-foreground">{t.toolNoOutput}</p>}
  </ToolFrame>;
}
