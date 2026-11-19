import assert from "node:assert/strict";
import test from "node:test";
import { exportPackageNames } from "./export-recipe.mjs";
import { assertFlowAgent } from "./verify-runtime.mjs";

test("recipe retains patched transitive agent-core even when not a direct bundle", () => {
  const names = exportPackageNames({ bundleDependencies: ["@earendil-works/pi-coding-agent"] });
  assert.ok(names.includes("@earendil-works/pi-agent-core"));
  assert.equal(new Set(names).size, names.length);
});

test("runtime gate rejects stock core and accepts queue checkpoint capability", () => {
  assert.throws(() => assertFlowAgent({}), /unpatched Pi agent-core/);
  assert.doesNotThrow(() => assertFlowAgent({ inspectQueuedMessages() {} }));
});
