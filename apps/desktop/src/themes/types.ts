import type { Locale } from "../i18n";

/** The theme the app has always shipped. Its CSS stays in `styles.css`. */
export const builtinThemeIds = ["jouzu"] as const;
export type BuiltinTheme = (typeof builtinThemeIds)[number];

export type ThemeMode = "light" | "dark";
/** What the person chooses inside a theme: System only exists for a two-variant theme. */
export type ThemeChoice = "system" | ThemeMode;

/** A shared structural base a theme can opt into. `folio` is the editorial look. */
export type ThemeStyle = string;

/**
 * One half of a theme. `mode` matches the key it is stored under, so a theme
 * cannot claim a light variant without actually providing one.
 */
export interface ThemeVariant {
  mode: ThemeMode;
}

/**
 * A design family, not a single palette. `variants` says which appearances the
 * theme provides: both means System/Light/Dark, one means that appearance only.
 */
export interface ThemePlugin {
  /** Stored in `jouzu.ui.theme`. Lowercase letters, digits and dashes. */
  id: string;
  labels: Record<Locale, string>;
  style?: ThemeStyle;
  order?: number;
  /** The app's original theme; its light/dark halves are `styles.css`. */
  builtin?: boolean;
  variants: Partial<Record<ThemeMode, ThemeVariant>>;
}

/**
 * A theme installed by the official channel. Same family model, with one CSS
 * stylesheet per variant. The app sets `data-theme="<id>"` and
 * `data-mode="light|dark"`; the CSS may scope by either.
 */
export interface ThemePackage {
  id: string;
  labels: Record<Locale, string>;
  style?: ThemeStyle;
  order?: number;
  variants: Partial<Record<ThemeMode, { css: string }>>;
}