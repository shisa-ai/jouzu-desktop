import { describe, expect, it } from "vitest";
import { parseThemePackage } from "./installed";

const labels = { en: "Moss", ja: "モス", "zh-Hans": "苔色", "zh-Hant": "苔色" };
const darkCss = ':root[data-theme="moss"][data-mode="dark"] { --color-background: #101712; }';
const valid = {
  id: "moss",
  labels,
  variants: { dark: { css: darkCss } },
};

describe("theme packages", () => {
  it("accepts a family with one or two variants", () => {
    expect(parseThemePackage(valid)).toEqual({ package: valid });
    const both = { ...valid, id: "moss-two", variants: { dark: { css: darkCss.replaceAll("moss", "moss-two") }, light: { css: darkCss.replaceAll("moss", "moss-two").replace("dark", "light") } } };
    expect(parseThemePackage(both)).toEqual({ package: both });
  });

  it("accepts the previous single-mode package as one variant", () => {
    expect(parseThemePackage({ id: "moss", mode: "dark", labels, css: darkCss })).toMatchObject({
      package: { id: "moss", variants: { dark: { css: darkCss } } },
    });
  });

  it("keeps the built-in and installed ids reserved", () => {
    expect(parseThemePackage({ ...valid, id: "jouzu" })).toEqual({ error: "reserved" });
    expect(parseThemePackage(valid, ["moss"])).toEqual({ error: "duplicate" });
  });

  it("requires English and falls back to it for the other languages", () => {
    expect(parseThemePackage({ ...valid, labels: { en: "Moss" } })).toMatchObject({
      package: { labels: { en: "Moss", ja: "Moss", "zh-Hans": "Moss", "zh-Hant": "Moss" } },
    });
    expect(parseThemePackage({ ...valid, labels: { ja: "モス" } })).toEqual({ error: "invalid" });
  });

  it("rejects a missing variant or an unscoped stylesheet", () => {
    expect(parseThemePackage({ ...valid, variants: {} })).toEqual({ error: "invalid" });
    expect(parseThemePackage({ ...valid, variants: { dark: { css: ".sidebar { display: none; }" } } })).toEqual({ error: "unscoped" });
  });

  it("rejects a package that pulls in a remote resource", () => {
    const css = `${darkCss}\n@import url("https://example.com/a.css");`;
    expect(parseThemePackage({ ...valid, variants: { dark: { css } } })).toEqual({ error: "unsafe" });
    expect(parseThemePackage({ ...valid, variants: { dark: { css: `${darkCss}\nbody { background: url(https://example.com/a.png); }` } } })).toEqual({ error: "unsafe" });
    expect(parseThemePackage({ ...valid, variants: { dark: { css: `${darkCss}\nbody { background: url("file:///C:/a.png"); }` } } })).toEqual({ error: "unsafe" });
  });

  it("caps the stylesheet size", () => {
    expect(parseThemePackage({ ...valid, variants: { dark: { css: `${darkCss}\n/*${"x".repeat(300 * 1024)}*/` } } })).toEqual({ error: "too-large" });
  });
});