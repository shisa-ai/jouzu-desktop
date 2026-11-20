import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatTextProvider, chatTexts } from "./chat-text";
import { ImageMissingNotice, imageChain, type ImageProvider } from "./tools-panel";

const image = (over: Partial<{ enabled: boolean; provider: string; model: string; size: string; maxImages: number }> = {}) => ({
  enabled: true,
  provider: "shisa",
  model: "gemini-3-pro-image",
  size: "2K",
  maxImages: 3,
  ...over,
});

const provider = (id: string, label: string, over: Partial<ImageProvider> = {}): ImageProvider => ({
  id,
  label,
  available: true,
  code: "",
  reason: "",
  models: [{ id: "gemini-3-pro-image", sizes: ["1K", "2K", "4K"] }],
  ...over,
});

const line = (html: string) => {
  const match = html.match(/data-image-no-provider[^>]*>([^<]*)</);
  return match?.[1] ?? "";
};

describe("the image chain shows only the level whose parent has a value (ui-layer §6.1)", () => {
  it("has no provider, model or size without a usable provider", () => {
    const chain = imageChain([provider("shisa", "Shisa.AI", { available: false, models: null })], image());
    expect(chain.canGenerate).toBe(false);
    expect(chain.selected).toBeUndefined();
    expect(chain.models).toEqual([]);
    expect(chain.sizes).toEqual([]);
  });

  it("uses the saved model and its sizes while the provider can make images", () => {
    const chain = imageChain([provider("shisa", "Shisa.AI")], image());
    expect(chain.canGenerate).toBe(true);
    expect(chain.model?.id).toBe("gemini-3-pro-image");
    expect(chain.sizes).toEqual(["1K", "2K", "4K"]);
    expect(chain.size).toBe("2K");
  });

  it("takes the first model when the saved one is not offered by that provider", () => {
    const chain = imageChain([provider("openrouter", "OpenRouter", { models: [{ id: "flux", sizes: [] }] })], image({ provider: "openrouter", model: "gone", size: "2K" }));
    expect(chain.model?.id).toBe("flux");
    // A runtime model takes no size, so the size level has nothing to show.
    expect(chain.sizes).toEqual([]);
  });

  it("falls back to an offered size when the saved one is not accepted", () => {
    const chain = imageChain([provider("shisa", "Shisa.AI", { models: [{ id: "lite", sizes: ["1K"] }] })], image({ model: "lite", size: "4K" }));
    expect(chain.size).toBe("1K");
  });
});

describe("the card with no usable provider (ui-layer §6.1)", () => {
  const unusable = [
    provider("shisa", "Shisa.AI", { available: false, code: "no-credential", reason: "host said: no credential", models: null }),
    provider("openrouter", "OpenRouter", { available: false, code: "no-credential", reason: "host said: no credential", models: null }),
  ];

  it("shows one line, names the providers to connect, and the destination exactly once in every language", () => {
    for (const locale of Object.keys(chatTexts) as (keyof typeof chatTexts)[]) {
      const texts = chatTexts[locale];
      const html = renderToStaticMarkup(<ChatTextProvider value={texts}><ImageMissingNotice providers={unusable} onModelProviders={() => {}} /></ChatTextProvider>);
      expect(line(html), locale).toContain("Shisa.AI");
      expect(line(html), locale).toContain("OpenRouter");
      expect(html.split(texts.modelProviders).length - 1, `${locale}: destination appears once`).toBe(1);
      // Reasons are under Details, not side by side on the page.
      expect(line(html), locale).not.toContain(texts.imageWhyNoCredential);
      expect(html, locale).toContain(texts.details);
      expect(html, locale).toContain(texts.imageWhyNoCredential);
    }
  });

  it("names a connected provider that cannot make images, once", () => {
    const html = renderToStaticMarkup(<ChatTextProvider value={chatTexts.en}><ImageMissingNotice
      providers={[provider("shisa", "Shisa.AI", { available: false, code: "no-credential", models: null })]}
      connected={[{ id: "openai-codex", name: "Codex" }, { id: "shisa", name: "Shisa.AI" }]}
      onModelProviders={() => {}}
    /></ChatTextProvider>);
    expect(line(html)).toBe("Codex cannot generate images. Connect Shisa.AI.");
    expect(html.split("Codex").length - 1).toBe(1);
  });

  it("asks for an image provider when the tool lists none", () => {
    const html = renderToStaticMarkup(<ChatTextProvider value={chatTexts.en}><ImageMissingNotice providers={[]} onModelProviders={() => {}} /></ChatTextProvider>);
    expect(line(html)).toBe("Connect an image provider to generate images.");
  });
});