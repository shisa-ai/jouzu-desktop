import { describe, expect, it } from "vitest";
import { changedFiles, snapshotComplete, type WorkspaceSnapshot } from "./workspace-diff";

const snapshot = (files: { path: string; size: number; modified: number }[], truncated = false): WorkspaceSnapshot => ({ files, truncated });

describe("workspace diff", () => {
  it("reports added and modified files, not untouched ones", () => {
    const before = snapshot([
      { path: "C:/work/a.md", size: 10, modified: 1 },
      { path: "C:/work/b.txt", size: 10, modified: 1 },
    ]);
    const after = snapshot([
      { path: "C:/work/a.md", size: 10, modified: 1 },
      { path: "C:/work/b.txt", size: 12, modified: 2 },
      { path: "C:/work/hello.pdf", size: 900, modified: 3 },
    ]);
    expect(changedFiles(before, after)).toEqual(["C:/work/b.txt", "C:/work/hello.pdf"]);
  });

  it("compares paths case- and separator-insensitively", () => {
    const before = snapshot([{ path: "C:/Work/A.md", size: 1, modified: 1 }]);
    const after = snapshot([{ path: "c:\\work\\a.md", size: 1, modified: 1 }]);
    expect(changedFiles(before, after)).toEqual([]);
  });

  it("reports nothing without a baseline", () => {
    expect(changedFiles(null, snapshot([{ path: "C:/work/a.md", size: 1, modified: 1 }]))).toEqual([]);
  });

  it("marks a truncated snapshot as incomplete", () => {
    expect(snapshotComplete(snapshot([], false))).toBe(true);
    expect(snapshotComplete(snapshot([], true))).toBe(false);
    expect(snapshotComplete(null)).toBe(false);
  });
});