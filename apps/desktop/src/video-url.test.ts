import { describe, expect, it } from "vitest";
import { normalizeVideoUrl, videoMarker } from "./video-url";

describe("video URL capability", () => {
  it("accepts a public https URL and preserves its path", () => {
    expect(normalizeVideoUrl("https://cdn.example.com/a.mp4")).toBe("https://cdn.example.com/a.mp4");
  });

  it("rejects URLs the capy proxy rejects", () => {
    for (const value of ["http://cdn.example.com/a.mp4", "https://localhost/a.mp4", "https://127.0.0.1/a.mp4", "https://user:pass@cdn.example.com/a.mp4", "not a url"]) {
      expect(() => normalizeVideoUrl(value)).toThrow();
    }
  });

  it("sends the proxy marker verbatim", () => {
    expect(videoMarker("https://cdn.example.com/a.mp4")).toBe("@video:https://cdn.example.com/a.mp4");
  });
});
