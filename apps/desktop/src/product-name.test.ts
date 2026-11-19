import { describe, it, expect } from "vitest";
import i18n from "./i18n.ts?raw";
import updatePreview from "./update-preview.tsx?raw";
import installerHooks from "../../../packaging/desktop/desktop-installer-hooks.nsh?raw";

// Desktop has no launcher (#168): the app calls itself Jouzu Desktop in every language,
// including the installer's own text.
const shown: Record<string, string> = {
  "i18n.ts": i18n,
  "update-preview.tsx": updatePreview,
  "desktop-installer-hooks.nsh": installerHooks,
};
const words = /launcher|ランチャー|启动器|啟動器/i;

describe("product name", () => {
  for (const [name, text] of Object.entries(shown)) {
    it(`${name} never names a launcher`, () => {
      expect(text.split("\n").filter((line: string) => words.test(line))).toEqual([]);
    });
  }
});
