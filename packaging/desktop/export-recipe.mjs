import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { packageRootFromConsumer } from "./package-root.mjs";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Export curated package content without its installed dependency tree.
 * Source must have completed Jouzu's exact patch/build qualification first.
 * Outputs are private build inputs, never automatically published to a registry.
 */
export const REQUIRED_PATCHED_TRANSITIVES = ["@earendil-works/pi-agent-core"];

export function exportPackageNames(manifest) {
	return [...new Set(["jouzu", ...(manifest.bundleDependencies ?? []), ...REQUIRED_PATCHED_TRANSITIVES])];
}

export function exportPackageRoot(root, name) {
	// Preserve the core actually used by coding-agent, including nested npm bundles.
	const consumer = name === "@earendil-works/pi-agent-core"
		? packageRootFromConsumer(root, "@earendil-works/pi-coding-agent")
		: root;
	return name === "jouzu" ? root : packageRootFromConsumer(consumer, name);
}

export function exportRecipe(source, output) {
	const root = realpathSync(source);
	const destination = resolve(output);
	if (existsSync(destination)) throw new Error("Recipe output must not exist");
	const jouzu = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (jouzu.name !== "jouzu") throw new Error("Expected built Jouzu package");
	if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("Build Jouzu before exporting a recipe");
	const names = exportPackageNames(jouzu);

	mkdirSync(destination, { recursive: true });
	const artifacts = join(destination, "artifacts"); mkdirSync(artifacts);
	const overrides = {};
	for (const name of names) {
		const input = exportPackageRoot(root, name);
		const metadata = JSON.parse(readFileSync(join(input, "package.json"), "utf8"));
		if (metadata.name !== name) throw new Error(`Unexpected package at ${name}`);
		const prepared = join(destination, "sources", name.replaceAll("/", "__"));
		cpSync(input, prepared, {
			recursive: true,
			filter: path => !["node_modules", ".git"].includes(basename(path)),
		});
		delete metadata.bundleDependencies;
		delete metadata.bundledDependencies;
		// No lifecycle scripts execute while producing or installing these artifacts.
		writeFileSync(join(prepared, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
		const npmCli = process.env.npm_execpath;
		if (!npmCli) throw new Error("Run via npm so npm_execpath identifies the private npm CLI");
		const result = spawnSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: prepared, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
		if (result.status !== 0) throw new Error(`Packing ${name} failed: ${result.stderr || result.error}`);
		const packed = JSON.parse(result.stdout)[0];
		overrides[name] = `file:artifacts/${packed.filename}`;
	}
	const recipe = { name: "jouzu-managed-installation", private: true, packageManager: "pnpm@10.21.0", dependencies: { jouzu: overrides.jouzu }, pnpm: { overrides } };
	writeFileSync(join(destination, "package.json"), `${JSON.stringify(recipe, null, 2)}\n`);
	return recipe;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, output] = process.argv.slice(2);
	if (!source || !output) throw new Error("Usage: npm exec -- node packaging/desktop/export-recipe.mjs <built-cli-package> <new-recipe-directory>");
	exportRecipe(source, output);
}
