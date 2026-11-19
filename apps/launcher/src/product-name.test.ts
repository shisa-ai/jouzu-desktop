import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Desktop has no launcher (#168): the app calls itself Jouzu Desktop in every language,
// including the installer's own text.
const shown = [
  "./i18n.ts",
  "./update-preview.tsx",
  "../../../packaging/launcher/desktop-installer-hooks.nsh",
];
const words = /launcher|ランチャー|启动器|啟動器/i;

describe("product name", () => {
  for (const path of shown) {
    it(`${path} never names a launcher`, () => {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      const lines = text.split("\n").filter(line => words.test(line));
      expect(lines).toEqual([]);
    });
  }
});
