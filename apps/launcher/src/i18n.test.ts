import { describe, it, expect } from "vitest";
import { locales, messages, resolveLocale } from "./i18n";
describe("interface languages", () => {
  it("provides every label in every language", () => {
    for (const locale of Object.keys(locales) as (keyof typeof locales)[]) {
      expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(messages.en).sort());
      expect(Object.values(messages[locale]).every(value => value.trim().length > 0)).toBe(true);
    }
  });
  it("resolves regional language preferences", () => {
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveLocale("zh-Hant-HK")).toBe("zh-Hant");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveLocale("fr-FR")).toBe("en");
  });
});
