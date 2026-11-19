import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// The app's own button: a terminal in a folder, with the environment this installation manages,
// that does not start Jouzu. The shell is the Git Bash the installation prepared, so the user gets a
// shell to work in and can start Jouzu from it with jz or jouzu.
const [app, managed, host, shell, home, folder] = process.argv.slice(2);
if (!app || !managed || !host || !shell || !home || !folder) {
	console.error("usage: open-terminal.mjs <app> <managed> <host> <shell> <home> <folder>");
	process.exit(2);
}
const node = process.execPath;
const nodeDirectory = dirname(node);
const npm = join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js");
const entries = join(managed, "bin");
const git = [dirname(shell), join(dirname(shell), "..", "cmd"), join(dirname(shell), "..", "usr", "bin")];
// This installation's own commands answer first, then the runtime it carries, its tools and the Git Bash
// it prepared, so jz and jouzu work here even when the user never authorized a PATH entry.
const path = [...(existsSync(entries) ? [entries] : []), nodeDirectory, join(app, "..", "tools"), ...git, process.env.PATH ?? ""].join(delimiter);
const environment = {
	...process.env,
	PATH: path,
	JOUZU_HOME: home,
	JOUZU_LAUNCHER_BASH: shell,
	JOUZU_NO_UPDATE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	NODE_USE_SYSTEM_CA: "1",
	NODE_USE_ENV_PROXY: "1",
	npm_execpath: npm,
	npm_node_execpath: node,
};
// A tab in the window that is already open when there is one; Windows Terminal creates a window only
// when there is none.
spawn(host, ["-w", "0", "new-tab", "--title", "Jouzu", "--startingDirectory", folder, "--", shell, "--login", "-i"], {
	env: environment,
	detached: true,
	stdio: "ignore",
}).unref();
