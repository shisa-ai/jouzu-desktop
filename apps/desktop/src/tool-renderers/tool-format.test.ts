import { describe, expect, it } from "vitest";
import { classifyText, diffRows, prettyJson } from "./tool-format";

describe("tool result formatting", () => {
  it("detects JSON objects and arrays without treating ordinary text as JSON", () => {
    expect(classifyText('{"ok":true}')).toBe("json");
    expect(classifyText("[1,2]")).toBe("json");
    expect(classifyText("{not json}")).toBe("text");
  });

  it("pretty prints valid JSON and leaves invalid JSON unformatted", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("{broken")).toBeUndefined();
  });

  it("classifies diff lines and ignores a lone plus sign", () => {
    const rows = diffRows("@@ -1 +1 @@\n-old\n+new\n+");
    expect(rows.map(row => row.kind)).toEqual(["hunk", "remove", "add", "add"]);
    expect(classifyText("+ just prose")).toBe("text");
  });
});
