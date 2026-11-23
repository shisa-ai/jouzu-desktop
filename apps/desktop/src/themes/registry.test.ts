import { describe, expect, it } from "vitest";
import { appearanceOf, findTheme, isThemeId, isThemeMode, themeChoices, themeLabel, themeModes, themePluginIssues, themePlugins } from "./registry";
import { builtinTheme } from "./builtin";
import { locales, type Locale } from "../i18n";

describe("theme families", () => {
  it("discovers well-formed, unique families with real variants", () => {
    expect(themePluginIssues).toEqual([]);
    expect(themePlugins.length).toBeGreaterThan(0);
    const ids = themePlugins.map(theme => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of themePlugins) {
      expect(theme.id).toMatch(/^[a-z][a-z0-9-]*$/u);
      const modes = themeModes(theme.id);
      expect(modes.length).toBeGreaterThan(0);
      for (const mode of modes) expect(theme.variants[mode]?.mode).toBe(mode);
      for (const locale of Object.keys(locales) as Locale[]) expect(themeLabel(theme, locale).length).toBeGreaterThan(0);
    }
  });

  it("keeps the original family first and rejects the old top-level modes as themes", () => {
    expect(themeChoices()[0]).toBe(builtinTheme);
    expect(isThemeId("jouzu")).toBe(true);
    for (const theme of themePlugins) expect(isThemeId(theme.id)).toBe(true);
    for (const legacy of ["system", "dark", "light"]) expect(isThemeId(legacy)).toBe(false);
    expect(isThemeId("no-such-theme")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    const first = themePlugins[0];
    expect(findTheme(first!.id)).toMatchObject({ id: first!.id });
    expect(themeModes("jouzu")).toEqual(["light", "dark"]);
  });

  it("resolves System inside a family, and ignores it for a single-variant family", () => {
    expect(appearanceOf("jouzu", "system", true).light).toBe(true);
    expect(appearanceOf("jouzu", "system", false).light).toBe(false);
    expect(appearanceOf("jouzu", "light", false).light).toBe(true);
    expect(appearanceOf("jouzu", "dark", true).light).toBe(false);
    expect(appearanceOf("editorial", "system", true).mode).toBe("light");
    expect(appearanceOf("editorial", "system", false).mode).toBe("dark");
    expect(appearanceOf("editorial", "dark", true).mode).toBe("dark");
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
  });
});