import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const app = join(root, "node_modules", "jouzu");
const cli = join(app, "dist", "cli.js");
const args = process.argv.slice(2);
const { parseJouzuArgs } = await import(pathToFileURL(join(app, "dist", "args.js")));
const { resolveJouzuPaths } = await import(pathToFileURL(join(app, "dist", "paths.js")));
const parsed = parseJouzuArgs(args);
// Desktop passes JOUZU_HOME. Run on its own, the bootstrap uses the same home: `data` beside
// the installation this file is in (<installation>/app/bootstrap.mjs). See #112.
process.env.JOUZU_HOME ||= join(root, "..", "data");
const paths = resolveJouzuPaths({ homeOverride: parsed.options.home });
const node = dirname(process.execPath);
const npm = join(node, "node_modules", "npm", "bin", "npm-cli.js");
const shell = process.env.JOUZU_LAUNCHER_BASH;
process.env.PATH = [node, join(root, "..", "tools"), ...(shell ? [dirname(shell), join(dirname(shell), "..", "cmd"), join(dirname(shell), "..", "usr", "bin")] : []), process.env.PATH || ""].join(delimiter);
process.env.JOUZU_NO_UPDATE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.NODE_USE_SYSTEM_CA = "1";
process.env.NODE_USE_ENV_PROXY = "1";
process.env.npm_execpath = npm;
process.env.npm_node_execpath = process.execPath;
process.env.npm_config_cache = join(paths.cacheDir, "npm");
process.env.npm_config_prefix = join(paths.configDir, "npm");
mkdirSync(paths.agentDir, { recursive: true });
const settingsPath = join(paths.agentDir, "settings.json");
const markerPath = join(paths.agentDir, "launcher-runtime.json");
const require = createRequire(join(app, "package.json"));
const lock = require("proper-lockfile");
const release = await lock.lock(settingsPath, { realpath: false, retries: { retries: 20, minTimeout: 50, maxTimeout: 200 } });
try {
  const read = path => existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : {};
  const settings = read(settingsPath);
  const previous = read(markerPath);
  if (shell && (!settings.shellPath || settings.shellPath === previous.shellPath)) settings.shellPath = shell;
  const npmCommand = [process.execPath, npm];
  if (!settings.npmCommand || JSON.stringify(settings.npmCommand) === JSON.stringify(previous.npmCommand)) settings.npmCommand = npmCommand;
  for (const [path, data] of [[settingsPath, settings], [markerPath, { shellPath: shell, npmCommand }]]) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temporary, path);
  }
} finally { await release(); }
process.argv = [process.execPath, cli, ...args];
await import(pathToFileURL(cli));
