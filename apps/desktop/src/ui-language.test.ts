import { describe, expect, it } from "vitest";
import { chatTexts, explain } from "./chat-text";
import { InputError } from "./input-error";

// #100: with the interface set to another language, the main window, its panels
// and the Tools page show no English of their own.

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort();

describe("the main window's words", () => {
  it("exist in every language, with the same placeholders", () => {
    for (const [locale, text] of Object.entries(chatTexts)) {
      expect(Object.keys(text).sort(), locale).toEqual(Object.keys(chatTexts.en).sort());
      for (const [key, value] of Object.entries(text)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholders(value), `${locale}.${key}`).toEqual(placeholders(chatTexts.en[key as keyof typeof chatTexts.en]));
      }
    }
  });

  it("are written in the interface language, not in the source", () => {
    // Settings (App.tsx and its sections) take their words from i18n.ts.
    const skip = /\.test\.|\/App\.tsx$|\/main\.tsx$|-section\.tsx$/u;
    const sources = import.meta.glob<string>(["./*.tsx", "./tool-renderers/*.tsx", "./components/*.tsx"], { query: "?raw", import: "default", eager: true });
    const files = Object.entries(sources).filter(([file]) => !skip.test(file));
    expect(files.length).toBeGreaterThan(30);
    // Visible text, accessible names and string literals that read as English words.
    const english = [
      /\b(?:aria-label|title|placeholder|alt|label|description|failed)="[A-Z][a-z]+[^"]*"/gu,
      /(?<![=-])>\s*[A-Z][a-z]+(?: [a-z]+)*[.…]?\s*</gu,
      /"[A-Z][a-z]+(?: [a-z]+)+[.…]?"/gu,
    ];
    // Names that stay as they are in every language.
    const names = /^(?:[\w-]+=)?(?:>|")?(?:Flow|TextGuard|Approve|Deny|Jouzu|MCP)(?:"|<)?$/u;
    const found = files.flatMap(([file, raw]) => {
      const source = raw.replace(/^\s*(?:\/\/|\*|\/\*).*$/gmu, "");
      return english.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[0]))
        .filter(text => !names.test(text.replace(/\s+/gu, "")))
        .map(text => `${file}: ${text}`);
    });
    expect(found).toEqual([]);
  });

  it("explain input the interface refused in the interface language", () => {
    const refused = new InputError("image-too-small", "This image is 10×10px.", { width: 10, height: 10, min: 64 });
    expect(explain(chatTexts.ja, refused, chatTexts.ja.attachFailed)).toEqual({ text: "この画像は 10×10px です。モデルが受け付けるには各辺が 64px 以上必要です。", details: "This image is 10×10px." });
    expect(explain(chatTexts["zh-Hans"], new InputError("video-url-https", "Video URLs must use https."), chatTexts["zh-Hans"].attachFailed).text).toBe("视频 URL 必须使用 https。");
  });
});
