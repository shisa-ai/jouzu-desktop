import type { ThemePlugin } from "./types";

/** The original Dark/Light pair, as the two variants of one theme. */
export const builtinTheme: ThemePlugin = {
  id: "jouzu",
  labels: { en: "Jouzu", ja: "Jouzu", "zh-Hans": "Jouzu", "zh-Hant": "Jouzu" },
  order: 0,
  builtin: true,
  variants: {
    dark: { mode: "dark" },
    light: { mode: "light" },
  },
};