import type { ThemePlugin } from "../../types";
import "./dark.css";
import "./light.css";

const editorial: ThemePlugin = {
  id: "editorial",
  labels: { en: "Editorial", ja: "エディトリアル", "zh-Hans": "编辑排版", "zh-Hant": "編輯排版" },
  style: "folio",
  order: 10,
  variants: {
    dark: { mode: "dark" },
    light: { mode: "light" },
  },
};

export default editorial;
