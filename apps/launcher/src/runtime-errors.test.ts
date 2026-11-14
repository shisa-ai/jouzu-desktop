import { expect, test } from "vitest";
import { CAPACITY_MESSAGE, humanizeRuntimeError, isCapacityError, isFlowHistoryError } from "./runtime-errors";

test("the flow capacity error becomes an instruction the user can follow", () => {
  const raw = "Error: Submission retention limit reached; admission is held.";
  expect(isCapacityError(raw)).toBe(true);
  expect(humanizeRuntimeError(raw)).toBe(CAPACITY_MESSAGE);
  expect(humanizeRuntimeError(raw)).not.toMatch(/retention|admission|submission/i);
});

test("a full Flow request history is identified as recoverable", () => {
  expect(isFlowHistoryError("Request history is full (62 records, 991362 bytes). Run /flow clear, then retry.")).toBe(true);
  expect(isFlowHistoryError("Submission retention limit reached")).toBe(false);
});

test("other runtime errors are not rewritten", () => {
  const raw = "Error: Runtime exited (1); unfinished work was not replayed";
  expect(isCapacityError(raw)).toBe(false);
  expect(humanizeRuntimeError(raw)).toBe(raw);
  expect(isCapacityError(null)).toBe(false);
  expect(isCapacityError("")).toBe(false);
});

test("errors read as sentences, never as class-prefixed exceptions", async () => {
  const { describeError } = await import("./runtime-errors");
  const { ApiError } = await import("./api/jouzu-api");
  expect(describeError(new ApiError("runtime-unavailable", "The runtime is not ready", true))).toMatch(/not available/);
  expect(describeError(new Error("Error: boom"))).toBe("boom");
  expect(describeError("ApiError: host said no")).toBe("host said no");
  expect(describeError(new ApiError("internal", "Host request failed (500)"))).toBe("Host request failed (500)");
  expect(describeError(new Error("Submission retention limit reached"))).toBe(CAPACITY_MESSAGE);
});
