import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installArguments, PNPM_VERSION, prepareStarter } from "./prepare-starter.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-starter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const inputs = Object.fromEntries(["recipe", "nodeRuntime", "pnpmPackage", "store"].map(key => {
		const path = join(root, key); mkdirSync(path); return [key, path];
	}));
	const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
	write(join(inputs.recipe, "package.json"), JSON.stringify({ private: true, packageManager: `pnpm@${PNPM_VERSION}`, dependencies: { jouzu: "0.1.18" } }));
	write(join(inputs.recipe, "pnpm-lock.yaml"), "fixture lock\n");
	write(join(inputs.nodeRuntime, process.platform === "win32" ? "node.exe" : "bin/node"), "fixture");
	write(join(inputs.pnpmPackage, "package.json"), JSON.stringify({ name: "pnpm", version: PNPM_VERSION }));
	write(join(inputs.pnpmPackage, "bin", "pnpm.cjs"), "fixture");
	return { ...inputs, output: join(root, "starter") };
}

test("offline preparation uses frozen lock and copies package content", () => {
	const args = installArguments("app", "store");
	for (const option of ["--offline", "--frozen-lockfile", "--ignore-scripts", "--prod", "--config.package-import-method=copy"]) assert.ok(args.includes(option));
});

test("materializes starter before publishing output", t => {
	const input = fixture(t);
	const calls = [];
	const result = prepareStarter(input, (node, args) => {
		calls.push({ node, args });
		assert.equal(existsSync(input.output), false);
		if (args.includes("install")) {
			const app = args[args.indexOf("--dir") + 1];
			const cli = join(app, "node_modules", "jouzu", "dist", "cli.js");
			mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fixture");
		}
		return args[0].endsWith("pnpm.cjs") && args.includes("--version") ? PNPM_VERSION : "jouzu 0.1.18";
	});
	assert.equal(calls.length, 4);
	assert.ok(existsSync(join(result.directory, result.cli)));
	assert.equal(existsSync(join(result.directory, "store")), false);
});

test("failed install never publishes a partial starter", t => {
	const input = fixture(t);
	assert.throws(() => prepareStarter(input, () => { throw new Error("offline package missing"); }), /offline package missing/);
	assert.equal(existsSync(input.output), false);
	assert.equal(existsSync(`${input.output}.staging-${process.pid}`), false);
});

test("requires pinned manager and frozen lockfile", t => {
	const input = fixture(t);
	rmSync(join(input.recipe, "pnpm-lock.yaml"));
	assert.throws(() => prepareStarter(input), /lockfile/);
});

test("refuses output inside a build input", t => {
	const input = fixture(t);
	assert.throws(() => prepareStarter({ ...input, output: join(input.store, "output") }), /outside its inputs/);
});
