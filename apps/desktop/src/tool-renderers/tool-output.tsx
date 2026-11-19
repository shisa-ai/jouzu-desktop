import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../components/ui/button";
import { ChatMarkdown } from "../chat-markdown";
import { object, type ToolView } from "../chat-projection";
import { classifyText, diffRows, prettyJson } from "./tool-format";
import { record, toolText } from "./types";
import { ArtifactImage } from "./artifact-image";
import { artifactPathFromText } from "./artifact-path";
import { RevealPath } from "../reveal-path";
import { copyText } from "../secure-context";
import { useChatText } from "../chat-text";

const MAX_LINES = 2000;
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;
const ANSI = /\u001b\[([0-9;]*)m/g;
const ANSI_COLORS: Record<number, string> = {
  30: "text-black", 31: "text-red-500", 32: "text-green-500", 33: "text-yellow-500",
  34: "text-blue-500", 35: "text-purple-500", 36: "text-cyan-500", 37: "text-foreground",
  90: "text-muted-foreground", 91: "text-red-400", 92: "text-green-400", 93: "text-yellow-400",
  94: "text-blue-400", 95: "text-purple-400", 96: "text-cyan-400", 97: "text-foreground",
};

interface AnsiState { color?: string; bold: boolean; dim: boolean; underline: boolean }
interface AnsiPart { text: string; state: AnsiState }
const plainState = (): AnsiState => ({ bold: false, dim: false, underline: false });

/** Convert the SGR subset Pi tools emit into React spans; never interpret other escapes. */
export function ansiParts(text: string): AnsiPart[] {
  const parts: AnsiPart[] = [];
  let state = plainState();
  let at = 0;
  for (const match of text.matchAll(ANSI)) {
    if (match.index! > at) parts.push({ text: text.slice(at, match.index), state: { ...state } });
    const codes = match[1] ? match[1].split(";").filter(Boolean).map(Number) : [0];
    for (const code of codes) {
      if (code === 0) state = plainState();
      else if (code === 1) state = { ...state, bold: true };
      else if (code === 2) state = { ...state, dim: true };
      else if (code === 4) state = { ...state, underline: true };
      else if (code === 22) state = { ...state, bold: false, dim: false };
      else if (code === 24) state = { ...state, underline: false };
      else if (code === 39) state = { ...state, color: undefined };
      else if (ANSI_COLORS[code]) state = { ...state, color: ANSI_COLORS[code] };
    }
    at = match.index! + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), state: { ...state } });
  return parts;
}

function AnsiPre({ text, expanded = false }: { text: string; expanded?: boolean }) {
  return <pre className={`${expanded ? "max-h-[70vh]" : "max-h-96"} overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5`}>{ansiParts(text).map((part, index) => <span key={index} className={[part.state.color, part.state.bold ? "font-semibold" : "", part.state.dim ? "opacity-70" : "", part.state.underline ? "underline" : ""].filter(Boolean).join(" ")}>{part.text}</span>)}</pre>;
}

function CopyButton({ text }: { text: string }) {
  const t = useChatText();
  const [copied, setCopied] = useState(false);
  return <Button variant="ghost" className="h-7 gap-1 px-2 text-[11px]" onClick={async () => { try { await copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { setCopied(false); } }}>{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? t.copied : t.copy}</Button>;
}

function DownloadButton({ text }: { text: string }) {
  const t = useChatText();
  return <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tool-output.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }}>{t.download}</Button>;
}

function truncatedLines(text: string) {
  const lines = text.split("\n");
  return { lines: lines.slice(0, MAX_LINES), truncated: lines.length > MAX_LINES, total: lines.length };
}

function CodeLines({ text, expanded = false }: { text: string; expanded?: boolean }) {
  const { lines, truncated, total } = truncatedLines(text);
  return <div className={`${expanded ? "max-h-[70vh]" : "max-h-96"} overflow-auto rounded-md border border-border/60 bg-background`}>
    <table className="w-full border-collapse font-mono text-[11px] leading-5"><tbody>{lines.map((line, index) => <tr key={index}>
      <td className="w-10 select-none border-r border-border/60 px-2 text-right align-top text-muted-foreground/70">{index + 1}</td>
      <td className="whitespace-pre-wrap break-words px-3 align-top">{line || " "}</td>
    </tr>)}</tbody></table>
    {truncated && <p className="border-t border-border/60 px-3 py-1 text-[10px] text-muted-foreground">Showing first {MAX_LINES} of {total} lines.</p>}
  </div>;
}

function markdownPath(args: unknown): boolean {
  const value = record(args);
  const path = typeof value?.path === "string" ? value.path : "";
  return /\.(?:md|mdx|markdown)$/iu.test(path);
}

function readPath(args: unknown): string | undefined {
  const value = record(args);
  return typeof value?.path === "string" ? value.path : undefined;
}

export interface ToolImageBlock {
  mime: string;
  data: string;
  alt: string;
  bytes: number;
  tooLarge: boolean;
}

/**
 * Keep every image block a tool returned, including an oversized or unsupported
 * one: the image component renders a card explaining why it is not inline.
 */
export function imageBlocks(result: unknown, fallbackAlt: string): ToolImageBlock[] {
  const value = record(result);
  const blocks = value && Array.isArray(value.content) ? value.content : [];
  return blocks.flatMap(block => {
    const item = record(block);
    if (item?.type !== "image" || typeof item.data !== "string") return [];
    const mime = typeof item.mimeType === "string" ? item.mimeType : "";
    const bytes = Math.floor(item.data.length * 0.75);
    return [{ mime, data: item.data, alt: typeof item.alt === "string" ? item.alt : fallbackAlt, bytes, tooLarge: bytes > MAX_TOOL_IMAGE_BYTES }];
  });
}

function SearchOutput({ text, pattern, expanded = false }: { text: string; pattern?: string; expanded?: boolean }) {
  const { lines, truncated, total } = truncatedLines(text);
  const safe = pattern ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  return <div className={`${expanded ? "max-h-[70vh]" : "max-h-96"} overflow-auto rounded-md border border-border/60 bg-background p-2 font-mono text-[11px] leading-5`}>{lines.map((line, index) => {
    if (!safe) return <div key={index} className="whitespace-pre-wrap break-words">{line || " "}</div>;
    const pieces = line.split(new RegExp(`(${safe})`, "giu"));
    return <div key={index} className="whitespace-pre-wrap break-words">{pieces.map((piece, position) => piece.toLowerCase() === pattern?.toLowerCase() ? <mark key={position} className="rounded bg-primary/20 text-foreground">{piece}</mark> : <span key={position}>{piece}</span>)}</div>;
  })}{truncated && <p className="mt-1 text-[10px] text-muted-foreground">Showing first {MAX_LINES} of {total} lines.</p>}</div>;
}

function DiffOutput({ text, expanded = false }: { text: string; expanded?: boolean }) {
  const rows = diffRows(text);
  const { lines, truncated, total } = truncatedLines(rows.map(row => row.text).join("\n"));
  return <div className={`${expanded ? "max-h-[70vh]" : "max-h-96"} overflow-auto rounded-md border border-border/60 bg-background py-1 font-mono text-[11px] leading-5`}>
    {lines.map((line, index) => {
      const kind = diffRows(line)[0]?.kind ?? "context";
      const className = kind === "add" ? "bg-green-500/10 text-green-600 dark:text-green-400"
        : kind === "remove" ? "bg-red-500/10 text-red-600 dark:text-red-400"
          : kind === "hunk" ? "bg-primary/10 text-primary"
            : kind === "header" ? "text-muted-foreground" : "";
      return <div key={index} className={`whitespace-pre-wrap break-words px-2 ${className}`}>{line || " "}</div>;
    })}
    {truncated && <p className="px-2 py-1 text-[10px] text-muted-foreground">Showing first {MAX_LINES} of {total} lines.</p>}
  </div>;
}

function JsonOutput({ text, expanded = false }: { text: string; expanded?: boolean }) {
  return <AnsiPre text={prettyJson(text) ?? text} expanded={expanded} />;
}

function MarkdownOutput({ text, expanded = false }: { text: string; expanded?: boolean }) {
  const t = useChatText();
  const [rendered, setRendered] = useState(true);
  return <div className="rounded-md border border-border/60 bg-background">
    <div className="flex justify-end border-b border-border/60 px-2 py-1"><Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setRendered(value => !value)}>{rendered ? t.source : "Markdown"}</Button></div>
    <div className={`${expanded ? "max-h-[70vh]" : "max-h-96"} overflow-auto p-3`}>{rendered ? <ChatMarkdown text={text} /> : <AnsiPre text={text} expanded={expanded} />}</div>
  </div>;
}

function resultMeta(result: unknown) {
  const value = record(result);
  if (!value) return [];
  const meta: string[] = [];
  if (typeof value.exitCode === "number") meta.push(`exit ${value.exitCode}`);
  if (typeof value.durationMs === "number") meta.push(`${value.durationMs} ms`);
  if (typeof value.truncated === "boolean" && value.truncated) meta.push("truncated");
  return meta;
}

export function ToolOutput({ tool }: { tool: ToolView }) {
  const t = useChatText();
  const [expanded, setExpanded] = useState(false);
  const text = toolText(tool.result);
  const blocks = imageBlocks(tool.result, t.toolOutputImage);
  const details = record(record(tool.result)?.details);
  const prompt = typeof details?.prompt === "string" ? details.prompt : "";
  const model = typeof details?.model === "string" ? details.model : "";
  const size = typeof details?.size === "string" ? details.size : "";
  const metas = Array.isArray(details?.images) ? details.images : [];
  const fallbackPath = blocks.length === 1 ? artifactPathFromText(text) : undefined;
  const images = blocks.map((image, index) => {
    const meta = record(metas[index]);
    return {
      ...image,
      alt: prompt || image.alt,
      path: typeof meta?.path === "string" ? meta.path : fallbackPath,
      bytes: image.bytes,
      width: typeof meta?.width === "number" ? meta.width : undefined,
      height: typeof meta?.height === "number" ? meta.height : undefined,
    };
  });
  const path = readPath(tool.args);
  const kind = classifyText(text);
  const meta = resultMeta(tool.result);
  const long = text.length > 2000 || text.split("\n").length > 40;
  if (images.length) return <div className="space-y-3">{images.map((image, index) => <ArtifactImage key={index} image={image} caption={[model, size, image.width && image.height ? `${image.width}×${image.height}` : ""].filter(Boolean).join(" · ")} />)}{text && <AnsiPre text={text} expanded={expanded} />}</div>;
  if (!text) return <p className="text-xs text-muted-foreground">{t.noTextOutput}</p>;
  return <div className="space-y-1">
    <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate text-[10px] uppercase tracking-wide text-muted-foreground">{tool.name === "read" && path ? path : t.output}{meta.length ? ` · ${meta.join(" · ")}` : ""}</span>{tool.name === "read" && path && <RevealPath path={path} compact label={t.reveal} />}</span><div className="flex shrink-0"><CopyButton text={text} /><DownloadButton text={text} />{long && <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setExpanded(value => !value)}>{expanded ? t.collapse : t.expand}</Button>}</div></div>
    {tool.phase === "error" && <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">Tool failed{meta.length ? ` (${meta.join(", ")})` : ""}</p>}
    {tool.name === "bash" ? <AnsiPre text={text} expanded={expanded} />
      : tool.name === "read" && markdownPath(tool.args) ? <MarkdownOutput text={text} expanded={expanded} />
        : tool.name === "read" && kind === "json" ? <JsonOutput text={text} expanded={expanded} />
          : tool.name === "read" && kind === "diff" ? <DiffOutput text={text} expanded={expanded} />
            : tool.name === "read" ? <CodeLines text={text} expanded={expanded} />
              : tool.name === "grep" ? <SearchOutput text={text} pattern={typeof record(tool.args)?.pattern === "string" ? record(tool.args)?.pattern as string : undefined} expanded={expanded} />
                : kind === "json" ? <JsonOutput text={text} expanded={expanded} />
                  : kind === "diff" ? <DiffOutput text={text} expanded={expanded} />
                    : <AnsiPre text={text} expanded={expanded} />}
  </div>;
}
