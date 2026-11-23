import type { Locale } from "../i18n";
import { builtinTheme } from "./builtin";
import { builtinThemeIds, type ThemeChoice, type ThemeMode, type ThemePackage, type ThemePlugin } from "./types";
import { addInstalled, installedThemes, MAX_THEMES, parseThemePackage, removeInstalled, type InstallError } from "./installed";
import "./shared/folio.css";
import "./shared/semantic.css";

const labelLanguages: Locale[] = ["en", "ja", "zh-Hans", "zh-Hant"];
const modeOrder: ThemeMode[] = ["light", "dark"];

function isPlugin(value: ThemePlugin): boolean {
  if (!value
    || typeof value.id !== "string"
    || !/^[a-z][a-z0-9-]*$/u.test(value.id)
    || (builtinThemeIds as readonly string[]).includes(value.id)
    || value.builtin === true
    || typeof value.labels !== "object"
    || !labelLanguages.every(language => typeof value.labels[language] === "string" && value.labels[language].trim().length > 0)
    || (value.style !== undefined && (typeof value.style !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value.style)))
    || (value.order !== undefined && (typeof value.order !== "number" || !Number.isFinite(value.order)))
    || !value.variants
    || typeof value.variants !== "object") return false;
  const modes = modeOrder.filter(mode => !!value.variants[mode]);
  return modes.length > 0 && modes.every(mode => {
    const variant = value.variants[mode];
    return !!variant && variant.mode === mode;
  });
}

/**
 * Discovered from the folder tree, not listed by hand: a new theme is a new
 * `plugins/<id>/theme.ts` plus its CSS, and the menu, storage check and first
 * paint all learn about it here. A plugin is a family with one or two variants.
 */
const discovered = Object.values(
  import.meta.glob<{ default: ThemePlugin }>("./plugins/*/theme.ts", { eager: true }),
).map(module => module.default);

const issues: string[] = [];
const accepted: ThemePlugin[] = [];
const seen = new Set<string>();
for (const plugin of discovered) {
  if (!isPlugin(plugin)) {
    issues.push(`skipped a theme that does not match the plugin contract: ${String((plugin as ThemePlugin | undefined)?.id ?? "unknown")}`);
    continue;
  }
  if (seen.has(plugin.id)) {
    issues.push(`skipped a duplicate theme id: ${plugin.id}`);
    continue;
  }
  seen.add(plugin.id);
  accepted.push(plugin);
}
for (const issue of issues) console.warn(`[themes] ${issue}`);

/** Empty in a healthy build; the registry test keeps it empty. */
export const themePluginIssues: readonly string[] = issues;

export const themePlugins: readonly ThemePlugin[] = accepted.sort(
  (left, right) => (left.order ?? 100) - (right.order ?? 100) || left.id.localeCompare(right.id),
);

const byId = new Map([builtinTheme, ...themePlugins].map(theme => [theme.id, theme]));
export type ThemeFamily = ThemePlugin | ThemePackage;

export function findTheme(id: string | null | undefined): ThemeFamily | undefined {
  if (!id) return undefined;
  return byId.get(id) ?? installedThemes().find(theme => theme.id === id);
}

export function isThemeId(value: string | null | undefined): boolean {
  return value === builtinTheme.id || !!findTheme(value);
}

export function isThemeMode(value: string | null | undefined): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The appearances a family provides. One entry means no System and no mode control. */
export function themeModes(themeId: string): ThemeMode[] {
  const family = findTheme(themeId);
  return family ? modeOrder.filter(mode => !!family.variants[mode]) : [];
}

/** Built-in first, then build-time plugins, then officially installed families. */
export function themeChoices(): readonly ThemeFamily[] {
  return [builtinTheme, ...themePlugins, ...installedThemes()];
}

export function themeLabel(theme: ThemeFamily, locale: Locale): string {
  return theme.labels[locale] ?? theme.labels.en ?? theme.id;
}

/**
 * What a family and a mode mean without touching the DOM. System is resolved
 * from the OS, then checked against the family: a light-only theme ignores it.
 */
export function appearanceOf(themeId: string, mode: ThemeChoice, prefersLight: boolean): {
  family: ThemeFamily;
  mode: ThemeMode;
  light: boolean;
} {
  const family = findTheme(themeId) ?? builtinTheme;
  const available = themeModes(family.id);
  const wanted: ThemeMode = mode === "system" ? (prefersLight ? "light" : "dark") : mode;
  const variant: ThemeMode = available.includes(wanted) ? wanted : available[0] ?? "dark";
  return { family, mode: variant, light: variant === "light" };
}

/**
 * Apply a family and a mode. The built-in Jouzu family keeps exactly the
 * classes it had; a plugin or installed family sets `data-theme`, `data-mode`
 * and its optional `data-theme-style`.
 */
export function applyTheme(themeId: string, mode: ThemeChoice): void {
  const prefersLight = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: light)").matches;
  const { family, mode: variant, light } = appearanceOf(themeId, mode, !!prefersLight);
  const root = document.documentElement;
  root.classList.toggle("light", light);
  root.style.colorScheme = light ? "light" : "dark";
  if ("builtin" in family && family.builtin === true) {
    delete root.dataset.theme;
    delete root.dataset.mode;
    delete root.dataset.themeStyle;
    return;
  }
  root.dataset.theme = family.id;
  root.dataset.mode = variant;
  if (family.style) root.dataset.themeStyle = family.style;
  else delete root.dataset.themeStyle;
}

/**
 * Read the stored family and mode, including the single-mode storage the app
 * used before themes became families. Called before the first paint.
 */
export function readAppearance(): { theme: string; mode: ThemeChoice } {
  const theme = localStorage.getItem("jouzu.ui.theme");
  const mode = localStorage.getItem("jouzu.ui.mode");
  if (theme && isThemeId(theme)) return { theme, mode: isThemeMode(mode) ? mode : "system" };
  if (theme === "dark" || theme === "light" || theme === "system") return { theme: builtinTheme.id, mode: theme };
  if (theme === "nocturne" || theme === "ink") return { theme: "editorial", mode: "dark" };
  if (theme === "folio" || theme === "paper") return { theme: "editorial", mode: "light" };
  return { theme: builtinTheme.id, mode: "dark" };
}

/** Validate and install one official family package. The caller persists/reloads. */
export function installTheme(value: unknown): { package: ThemePackage } | { error: InstallError } {
  const reserved = new Set([builtinTheme.id, ...themePlugins.map(plugin => plugin.id), ...installedThemes().map(theme => theme.id)]);
  const parsed = parseThemePackage(value, reserved);
  if ("error" in parsed) return parsed;
  if (installedThemes().length >= MAX_THEMES) return { error: "limit" };
  if (!addInstalled(parsed.package)) return { error: "storage" };
  return parsed;
}

export function removeInstalledTheme(id: string): void {
  removeInstalled(id);
}

export { installedThemes } from "./installed";