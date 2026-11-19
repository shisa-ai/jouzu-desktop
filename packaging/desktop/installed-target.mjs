import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

function inside(root, path) {
	const value = relative(root, path);
	return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

export function allowsPlatform(values, actual) {
	if (!Array.isArray(values) || values.length === 0) return true;
	if (values.includes(`!${actual}`)) return false;
	const positives = values.filter(value => !value.startsWith("!"));
	return positives.length === 0 || positives.includes("any") || positives.includes(actual);
}

/** Validate the installed target tree, not the cross-platform resolution lock.
 * Internal links are allowed for package-manager layouts; links into a build
 * store or elsewhere outside the application are rejected before distribution.
 */
export function assertInstalledTarget(app, { os = process.platform, arch = process.arch, libc } = {}) {
	const root = realpathSync(app);
	const seen = new Set();
	let packages = 0;
	function walk(path) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const target = realpathSync(path);
			if (!inside(root, target)) throw new Error(`Application links outside its directory: ${relative(root, path)}`);
			walk(target);
			return;
		}
		if (seen.has(path)) return;
		seen.add(path);
		if (stat.isDirectory()) {
			for (const name of readdirSync(path).sort()) walk(join(path, name));
		} else if (stat.isFile() && path.endsWith(`${sep}package.json`)) {
			// Limit checks to actual dependency package roots, not fixture manifests
			// shipped inside package source/test directories.
			const relativePath = relative(root, path).split(sep).join("/");
			if (!/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(relativePath)) return;
			const pkg = JSON.parse(readFileSync(path, "utf8"));
			for (const [key, value] of [["os", os], ["cpu", arch], ["libc", libc]]) {
				if (value && !allowsPlatform(pkg[key], value)) throw new Error(`Installed package ${pkg.name ?? relativePath} does not support ${key}=${value}`);
			}
			packages++;
		}
	}
	walk(root);
	return { packages };
}
