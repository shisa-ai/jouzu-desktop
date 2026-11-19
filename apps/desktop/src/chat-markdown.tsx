import { Children, isValidElement, memo, useState, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./components/ui/button";
import { MessageImage } from "./message-image";
import { copyText } from "./secure-context";
import { useChatText } from "./chat-text";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function Code({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const t = useChatText();
  const [status, setStatus] = useState("");
  const code = Children.toArray(children).find(isValidElement) as { props?: { className?: string; children?: ReactNode } } | undefined;
  const language = /language-([\w-]+)/u.exec(code?.props?.className ?? "")?.[1] ?? "text";
  const text = nodeText(code?.props?.children ?? children);
  return <div className="my-3 overflow-hidden rounded-lg border border-border">
    <div className="flex items-center justify-between border-b border-border bg-muted px-2">
      <span className="px-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{language}</span>
      <Button variant="ghost" className="h-8 text-xs" onClick={async () => {
        try { await copyText(text); setStatus(t.copied); }
        catch { setStatus(t.copyFailed); }
      }}>{status || t.copyCode}</Button>
    </div>
    <pre {...props} className="overflow-x-auto bg-background p-3 text-xs leading-relaxed">{children}</pre>
  </div>;
}
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const t = useChatText();
  const [error, setError] = useState<string | null>(null);
  return <div className="select-text break-words text-left text-sm leading-7 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-border [&_td]:px-3 [&_th]:border [&_th]:border-border [&_th]:px-3">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: Code,
      a: ({ href, children }) => {
        let safe: string | undefined;
        try {
          const url = new URL(href ?? "");
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) safe = url.href;
        } catch { /* Leave the link inert. */ }
        const open = (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          if (!safe) { setError(t.linkNotExternal); return; }
          void invoke("open_external_url", { url: safe }).catch(() => setError(t.openLinkFailed));
        };
        return <a href={safe} className="inline break-all text-left text-primary underline" onClick={open} onAuxClick={event => { if (event.button === 1) open(event); }}>{children}</a>;
      },
      img: ({ src, alt }) => <MessageImage kind="markdown" source={src} alt={alt ?? ""} />,
    }}>{text}</ReactMarkdown>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
});
