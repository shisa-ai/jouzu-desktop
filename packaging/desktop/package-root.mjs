import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

// Resolve package roots without assuming package.json is an exported subpath.
export function packageRootFromConsumer(consumer, name) {
	if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("Invalid package name");
	const require = createRequire(join(consumer, "package.json"));
	for (const base of require.resolve.paths(name) ?? []) {
		const candidate = join(base, name);
		if (!existsSync(join(candidate, "package.json"))) continue;
		const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		if (manifest.name !== name) throw new Error(`Package identity mismatch for ${name}`);
		return realpathSync(candidate);
	}
	throw new Error(`Cannot resolve ${name} from consumer`);
}
