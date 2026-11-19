import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, newId } from "./secure-context";

describe("helpers for insecure contexts (web access over plain http)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes v4 UUIDs without crypto.randomUUID", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(array: T) => real.getRandomValues(array) });
    expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("copies through the clipboard API when it exists", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a selection copy when the clipboard API is missing", async () => {
    vi.stubGlobal("navigator", {});
    const area = { value: "", style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", { createElement: () => area, body: { appendChild: vi.fn() }, execCommand });
    await copyText("hello");
    expect(area.value).toBe("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(area.remove).toHaveBeenCalled();
    execCommand.mockReturnValue(false);
    await expect(copyText("x")).rejects.toThrow();
  });
});

describe("the UI does not depend on a secure context", () => {
  it("uses these helpers instead of APIs that plain-http web access lacks", () => {
    const sources = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./secure-context.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources).filter(([, text]) => /crypto\.randomUUID|navigator\.clipboard|crypto\.subtle/.test(text)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
