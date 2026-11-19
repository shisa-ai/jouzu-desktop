import { describe, it, expect } from "vitest";
import { parseDiagnostics } from "./diagnostics";

describe("diagnostics answers", () => {
  it("accepts a record and keeps its fields", () => {
    const value = parseDiagnostics({ logs: "C:\logs", crashes: [{ path: "p", time: 1, message: "m", location: "l", version: "0.3.6" }] });
    expect(value?.logs).toBe("C:\logs");
    expect(value?.crashes[0]?.message).toBe("m");
  });
  it("rejects answers this interface cannot render", () => {
    for (const value of [undefined, null, 1, "logs", {}, { logs: "x" }, { logs: 1, crashes: [] }, { logs: "x", crashes: "no" }])
      expect(parseDiagnostics(value)).toBeNull();
  });
  it("drops a record that is not a crash record", () => {
    const value = parseDiagnostics({ logs: "x", crashes: [null, { path: "p" }, { path: "p", time: 1, message: "m" }] });
    expect(value?.crashes).toHaveLength(1);
  });
});
