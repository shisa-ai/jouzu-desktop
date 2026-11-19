import { describe, expect, it } from "vitest";
import { loadCollapsed, saveCollapsed, toggleCollapsed } from "./sidebar-state";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

describe("sidebar state", () => {
  it("opens groups by default so sessions stay reachable", () => {
    expect(loadCollapsed(memory())).toEqual(new Set());
  });

  it("keeps a group the user collapsed closed across remounts", () => {
    const store = memory();
    const closed = toggleCollapsed(new Set(), "C:/work");
    saveCollapsed(closed, store);
    expect(loadCollapsed(store)).toEqual(new Set(["C:/work"]));
  });

  it("reopens a group the user expanded again", () => {
    const store = memory();
    saveCollapsed(toggleCollapsed(new Set(["C:/work"]), "C:/work"), store);
    expect(loadCollapsed(store)).toEqual(new Set());
  });

  it("ignores unreadable storage", () => {
    expect(loadCollapsed(memory({ "jouzu.ui.collapsed-workspaces": "{" }))).toEqual(new Set());
    expect(loadCollapsed(null)).toEqual(new Set());
  });
});