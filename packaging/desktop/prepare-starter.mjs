import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertInstalledTarget } from "./installed-target.mjs";
import { fileURLToPath } from "node:url";

export const PNPM_VERSION = "10.21.0";

export function installArguments(app, store) {
	return ["install", "--dir", app, "--store-dir", store, "--offline", "--frozen-lockfile", "--prod", "--ignore-scripts", "--config.node-linker=hoisted", "--config.package-import-method=copy", "--config.verify-store-integrity=true"];
}

function run(executable, args, cwd, env) {
	const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Starter preparation failed (${result.status}): ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function isWithin(parent, child) {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** Build-time only. Inputs must already be qualified and authenticated by CI.
 * The recipe contains ordinary package dependencies and a frozen pnpm lockfile.
 * The store must already be populated; no network fallback is allowed here.
 */
export function prepareStarter({ recipe, nodeRuntime, pnpmPackage, store, output }, execute = run) {
	for (const path of [recipe, nodeRuntime, pnpmPackage, store]) {
		if (!path || !existsSync(path)) throw new Error("All starter inputs must exist");
	}
	const destination = resolve(output);
	if (existsSync(destination)) throw new Error("Starter output must not exist");
	if (!existsSync(dirname(destination))) throw new Error("Starter output parent must exist");
	for (const path of [recipe, nodeRuntime, pnpmPackage, store]) {
		if (isWithin(path, destination)) throw new Error("Starter output must be outside its inputs");
	}
	const manifest = JSON.parse(readFileSync(join(recipe, "package.json"), "utf8"));
	if (manifest.packageManager !== `pnpm@${PNPM_VERSION}`) throw new Error(`Recipe must pin pnpm@${PNPM_VERSION}`);
	if (!existsSync(join(recipe, "pnpm-lock.yaml"))) throw new Error("Frozen pnpm lockfile is required");
	if (manifest.scripts || manifest.workspaces || manifest.bundleDependencies || manifest.bundledDependencies) throw new Error("Starter recipe must not contain scripts, workspaces or bundled dependencies");
	if (!manifest.dependencies?.jouzu) throw new Error("Starter recipe must select Jouzu");
	const pnpmMetadata = JSON.parse(readFileSync(join(pnpmPackage, "package.json"), "utf8"));
	if (pnpmMetadata.name !== "pnpm" || pnpmMetadata.version !== PNPM_VERSION) throw new Error("Wrong private pnpm package");
	const nodeRelative = process.platform === "win32" ? "node.exe" : "bin/node";
	if (!existsSync(join(nodeRuntime, nodeRelative))) throw new Error("Missing target Node executable");
	if (!existsSync(join(pnpmPackage, "bin", "pnpm.cjs"))) throw new Error("Missing private pnpm entrypoint");
	const temporary = `${destination}.staging-${process.pid}`;
	mkdirSync(temporary);
	try {
		cpSync(nodeRuntime, join(temporary, "node"), { recursive: true });
		cpSync(pnpmPackage, join(temporary, "pnpm"), { recursive: true });
		const app = join(temporary, "app");
		mkdirSync(app);
		for (const file of ["package.json", "pnpm-lock.yaml"]) cpSync(join(recipe, file), join(app, file));
		if (existsSync(join(recipe, "artifacts"))) cpSync(join(recipe, "artifacts"), join(app, "artifacts"), { recursive: true });
		if (existsSync(join(recipe, "patches"))) cpSync(join(recipe, "patches"), join(app, "patches"), { recursive: true });
		const node = join(temporary, "node", nodeRelative);
		const pnpm = join(temporary, "pnpm", "bin", "pnpm.cjs");
		const env = { ...process.env, JOUZU_NO_UPDATE: "1", PI_SKIP_VERSION_CHECK: "1", CI: "true" };
		if (execute(node, [pnpm, "--version"], temporary, env) !== PNPM_VERSION) throw new Error("Private pnpm version check failed");
		execute(node, [pnpm, ...installArguments(app, resolve(store))], temporary, env);
		const cli = join(app, "node_modules", "jouzu", "dist", "cli.js");
		if (!existsSync(cli)) throw new Error("Installed Jouzu CLI is missing");
		assertInstalledTarget(app);
		execute(node, [fileURLToPath(new URL("./verify-runtime.mjs", import.meta.url)), app], app, env);
		execute(node, [cli, "--version"], app, env);
		renameSync(temporary, destination);
		return { directory: destination, node: join("node", nodeRelative), pnpm: "pnpm/bin/pnpm.cjs", cli: "app/node_modules/jouzu/dist/cli.js" };
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [recipe, nodeRuntime, pnpmPackage, store, output, ...extra] = process.argv.slice(2);
	if (!output || extra.length) {
		console.error(`Usage: node ${basename(process.argv[1])} <recipe> <node-runtime> <pnpm-package> <seeded-store> <new-output>`);
		process.exitCode = 1;
	} else console.log(JSON.stringify(prepareStarter({ recipe, nodeRuntime, pnpmPackage, store, output }), null, 2));
}
