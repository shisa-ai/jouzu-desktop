import type { Locale } from "../i18n";
import { builtinThemeIds, type ThemeMode, type ThemePackage } from "./types";

const STORAGE_KEY = "jouzu.ui.themes";
export const MAX_THEMES = 10;
const MAX_CSS = 256 * 1024;
const labelLanguages: Locale[] = ["en", "ja", "zh-Hans", "zh-Hant"];
const variantModes: ThemeMode[] = ["light", "dark"];

export type InstallError = "invalid" | "reserved" | "duplicate" | "unsafe" | "too-large" | "unscoped" | "limit" | "storage";

type Parsed = { package: ThemePackage } | { error: InstallError };

let installed: ThemePackage[] = [];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseVariant(value: unknown, id: string): { css: string } | { error: InstallError } {
  if (!record(value) || typeof value.css !== "string") return { error: "invalid" };
  const css = value.css.trim();
  if (!css) return { error: "invalid" };
  if (css.length > MAX_CSS) return { error: "too-large" };
  if (/@import\b/iu.test(css) || /url\(\s*["']?(?:https?:)?\/\//iu.test(css) || /url\(\s*["']?(?:file|javascript):/iu.test(css)) {
    return { error: "unsafe" };
  }
  if (!new RegExp(`data-theme\\s*=\\s*["']?${escapeRegExp(id)}["']?`, "u").test(css)) return { error: "unscoped" };
  return { css };
}

/**
 * Validate one theme package. Pure: no DOM, no storage. `reserved` carries the
 * build-time ids and the other installed ids so a package cannot shadow them.
 *
 * A package is a family: `variants.light` and/or `variants.dark`, each with CSS.
 * One variant means the theme has no System choice.
 */
export function parseThemePackage(value: unknown, reserved: Iterable<string> = []): Parsed {
  if (!record(value)) return { error: "invalid" };
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) return { error: "invalid" };
  if ((builtinThemeIds as readonly string[]).includes(id)) return { error: "reserved" };
  if (new Set(reserved).has(id)) return { error: "duplicate" };
  if (!record(value.labels)) return { error: "invalid" };
  const english = value.labels.en;
  if (typeof english !== "string" || !english.trim()) return { error: "invalid" };
  const labels = {} as Record<Locale, string>;
  for (const language of labelLanguages) {
    const label = value.labels[language];
    labels[language] = typeof label === "string" && label.trim() ? label.trim() : english.trim();
  }
  if (value.style !== undefined && (typeof value.style !== "string" || !/^[a-z][a-z0-9-]*$/u.test(value.style))) return { error: "invalid" };
  if (value.order !== undefined && (typeof value.order !== "number" || !Number.isFinite(value.order))) return { error: "invalid" };

  // The previous single-mode package format is still accepted and becomes one variant.
  const raw = record(value.variants)
    ? value.variants
    : value.mode === "light" || value.mode === "dark"
      ? { [value.mode]: { css: value.css } }
      : null;
  if (!raw) return { error: "invalid" };
  const variants: ThemePackage["variants"] = {};
  for (const mode of variantModes) {
    if (!(mode in raw)) continue;
    const parsed = parseVariant(raw[mode], id);
    if ("error" in parsed) return parsed;
    variants[mode] = parsed;
  }
  if (!variants.light && !variants.dark) return { error: "invalid" };

  return {
    package: {
      id,
      labels,
      variants,
      ...(typeof value.style === "string" ? { style: value.style } : {}),
      ...(typeof value.order === "number" ? { order: value.order } : {}),
    },
  };
}

function inject(theme: ThemePackage): void {
  if (typeof document === "undefined") return;
  const selector = `style[data-jouzu-theme="${theme.id}"]`;
  let style = document.querySelector<HTMLStyleElement>(selector);
  if (!style) {
    style = document.createElement("style");
    style.dataset.jouzuTheme = theme.id;
    document.head.append(style);
  }
  style.textContent = [theme.variants.light?.css, theme.variants.dark?.css].filter((css): css is string => !!css).join("\n");
}

function removeStyle(id: string): void {
  if (typeof document === "undefined") return;
  document.querySelector<HTMLStyleElement>(`style[data-jouzu-theme="${id}"]`)?.remove();
}

function persist(list: readonly ThemePackage[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const byOrder = (left: { id: string; order?: number }, right: { id: string; order?: number }) =>
  (left.order ?? 100) - (right.order ?? 100) || left.id.localeCompare(right.id);

/**
 * Read installed packages, inject their CSS, and make them available to the
 * registry. Called before the first paint, so a saved official theme never
 * flashes the default palette.
 */
export function loadInstalledThemes(reserved: Iterable<string> = []): void {
  if (typeof localStorage === "undefined") return;
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return;
  }
  const taken = new Set(reserved);
  const next: ThemePackage[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (next.length >= MAX_THEMES) break;
    const parsed = parseThemePackage(item, taken);
    if ("package" in parsed) {
      next.push(parsed.package);
      taken.add(parsed.package.id);
      inject(parsed.package);
    }
  }
  installed = next.sort(byOrder);
}

export function installedThemes(): readonly ThemePackage[] {
  return installed;
}

export function addInstalled(theme: ThemePackage): boolean {
  if (installed.length >= MAX_THEMES) return false;
  const next = [...installed, theme].sort(byOrder);
  if (!persist(next)) return false;
  installed = next;
  inject(theme);
  return true;
}

export function removeInstalled(id: string): void {
  const next = installed.filter(theme => theme.id !== id);
  if (next.length === installed.length) return;
  installed = next;
  persist(installed);
  removeStyle(id);
}