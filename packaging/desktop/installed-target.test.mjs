import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowsPlatform, assertInstalledTarget } from "./installed-target.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-target-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const app = join(root, "app");
	const pkg = join(app, "node_modules", "binding");
	mkdirSync(pkg, { recursive: true });
	return { root, app, pkg };
}

test("platform restrictions honor positive and negative selectors", () => {
	assert.equal(allowsPlatform(["linux"], "win32"), false);
	assert.equal(allowsPlatform(["!win32"], "linux"), true);
	assert.equal(allowsPlatform(["any", "!linux"], "linux"), false);
	assert.equal(allowsPlatform(undefined, "win32"), true);
});

test("rejects wrong target native package in installed tree", t => {
	const { app, pkg } = fixture(t);
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "linux-binding", os: ["linux"] }));
	assert.throws(() => assertInstalledTarget(app, { os: "win32", arch: "x64" }), /does not support os=win32/);
});

test("accepts target-correct and portable packages", t => {
	const { app, pkg } = fixture(t);
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "binding", os: ["win32"], cpu: ["x64"] }));
	assert.equal(assertInstalledTarget(app, { os: "win32", arch: "x64" }).packages, 1);
});

test("rejects links into build-machine store", t => {
	const { root, app } = fixture(t);
	const store = join(root, "store"); mkdirSync(store);
	symlinkSync(store, join(app, "node_modules", "external"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => assertInstalledTarget(app), /links outside/);
});

test("allows internal package-manager links without looping", t => {
	const { app, pkg } = fixture(t);
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "binding" }));
	symlinkSync(pkg, join(app, "node_modules", "alias"), process.platform === "win32" ? "junction" : "dir");
	assert.equal(assertInstalledTarget(app).packages, 1);
});
