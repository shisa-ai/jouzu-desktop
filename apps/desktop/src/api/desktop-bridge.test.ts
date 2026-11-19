import { describe, expect, test, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { createDesktopBridge } from "./desktop-bridge";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));

describe("DesktopBridge native actions", () => {
  test("pickFolder returns the selected path", async () => {
    vi.mocked(open).mockResolvedValue("C:/work");
    const bridge = createDesktopBridge();
    await expect(bridge.native.pickFolder()).resolves.toBe("C:/work");
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  test("pickFolder returns null on cancellation", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(createDesktopBridge().native.pickFolder()).resolves.toBeNull();
  });
});
