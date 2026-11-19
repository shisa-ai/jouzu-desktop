import { describe, expect, it } from "vitest";
import { ansiParts, imageBlocks } from "./tool-output";
import { chatTexts } from "../chat-text";

describe("tool output ANSI rendering", () => {
  it("preserves plain text and removes SGR escapes", () => {
    expect(ansiParts("plain output")).toEqual([{ text: "plain output", state: { bold: false, dim: false, underline: false } }]);
  });

  it("maps the terminal colors and resets state", () => {
    const parts = ansiParts("a\u001b[31mred\u001b[0mz");
    expect(parts.map(part => part.text)).toEqual(["a", "red", "z"]);
    expect(parts[1]?.state.color).toBe("text-red-500");
    expect(parts[2]?.state.color).toBeUndefined();
  });

  it("keeps bold and underline state across segments", () => {
    const parts = ansiParts("\u001b[1;4mhead\u001b[22;24m tail");
    expect(parts[0]?.state).toMatchObject({ bold: true, underline: true });
    expect(parts[1]?.state).toMatchObject({ bold: false, underline: false });
  });
});
describe("tool output images", () => {
  it("extracts a supported image block", () => {
    const images = imageBlocks({ content: [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", data: "QUJD" }] }, chatTexts.en.toolOutputImage);
    expect(images).toEqual([{ mime: "image/png", data: "QUJD", alt: "Tool output image", bytes: 3, tooLarge: false }]);
  });

  it("keeps an unsupported type so the card can explain it", () => {
    expect(imageBlocks({ content: [{ type: "image", mimeType: "image/svg+xml", data: "x" }] }, chatTexts.en.toolOutputImage)).toEqual([
      { mime: "image/svg+xml", data: "x", alt: "Tool output image", bytes: 0, tooLarge: false },
    ]);
  });

  it("keeps oversized data for the card instead of dropping it", () => {
    const [image] = imageBlocks({ content: [{ type: "image", mimeType: "image/png", data: "x".repeat(12 * 1024 * 1024) }] }, chatTexts.en.toolOutputImage);
    expect(image.tooLarge).toBe(true);
    expect(image.bytes).toBeGreaterThan(8 * 1024 * 1024);
  });
});