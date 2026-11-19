import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearDraft, draftKey, readDraft, writeDraft } from "./drafts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a key ignores separator and case differences but keeps the session apart", () => {
  expect(draftKey("C:\\Projects\\Alpha", "C:/Sessions/One.jsonl"))
    .toBe(draftKey("c:/projects/alpha/", "c:\\sessions\\one.jsonl"));
  expect(draftKey("C:/Projects/Alpha", null)).not.toBe(draftKey("C:/Projects/Alpha", "C:/Sessions/One.jsonl"));
});

test("attachments stay in memory and never reach storage", () => {
  const key = "test::attachments";
  const attachment = { id: "a", name: "p.png", size: 1, image: { type: "image" as const, data: "AA", mimeType: "image/png" as const } };
  writeDraft(key, { text: "keep me", attachments: [attachment] });
  vi.advanceTimersByTime(200);

  expect(JSON.parse(localStorage.getItem(`jouzu.draft.v1:${key}`)!)).toEqual({ text: "keep me" });
  expect(readDraft(key)?.attachments).toEqual([attachment]);
});

test("storage is written once after the debounce, not on every keystroke", () => {
  const key = "test::debounce";
  const setItem = vi.spyOn(localStorage, "setItem");
  writeDraft(key, { text: "a", attachments: [] });
  writeDraft(key, { text: "ab", attachments: [] });
  writeDraft(key, { text: "abc", attachments: [] });
  expect(setItem).not.toHaveBeenCalled();

  vi.advanceTimersByTime(200);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem(`jouzu.draft.v1:${key}`)!)).toEqual({ text: "abc" });
});

test("clearing removes the text from memory and storage", () => {
  const key = "test::clear";
  writeDraft(key, { text: "gone", attachments: [] });
  vi.advanceTimersByTime(200);
  clearDraft(key);

  expect(readDraft(key)).toBeUndefined();
  expect(localStorage.getItem(`jouzu.draft.v1:${key}`)).toBeNull();
});

test("an empty text removes the stored draft instead of writing one", () => {
  const key = "test::empty";
  writeDraft(key, { text: "first", attachments: [] });
  vi.advanceTimersByTime(200);
  writeDraft(key, { text: "", attachments: [] });
  vi.advanceTimersByTime(200);

  expect(localStorage.getItem(`jouzu.draft.v1:${key}`)).toBeNull();
});
