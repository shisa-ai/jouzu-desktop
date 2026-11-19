// Builds everything a packaged Jouzu Desktop ships, from one source tree:
// the web UI (`dist`) and the release host (`host/target/release`). Tauri runs
// this before it compiles the shell, so an installer can never pair a fresh UI
// with a host left over from an earlier build.
//
// Every build gets a new id in `.build-id`. The host and the shell both compile
// it in (see their build.rs); a release shell refuses to start a host with a
// different id, instead of running a mixed install.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomBytes(4).toString("hex")}`;
writeFileSync(join(root, ".build-id"), `${buildId}\n`);
// The commit goes in beside the id, so every report names the exact source.
const git = (args) => spawnSync(`git ${args}`, { cwd: root, shell: true, encoding: "utf8" });
const head = git("rev-parse --short=12 HEAD").stdout?.trim() || "unknown";
const dirty = git("status --porcelain --untracked-files=no").stdout?.trim() ? "-dirty" : "";
writeFileSync(join(root, ".build-commit"), `${head}${dirty}\n`);
console.log(`Jouzu Desktop build ${buildId} commit ${head}${dirty}`);

function run(command) {
  const result = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm run build");

// Tauri passes the triple it is building for. Build the host for the same
// target, then stage it at the one path tauri.conf.json bundles from.
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const native = /^host: (.+)$/mu.exec(spawnSync("rustc -vV", { shell: true, encoding: "utf8" }).stdout ?? "")?.[1];
const cross = target && target !== native ? target : "";
run(`cargo build --release --locked --manifest-path host/Cargo.toml${cross ? ` --target ${cross}` : ""}`);
const windows = (cross || native || "").includes("windows");
const built = join(root, "host", "target", ...(cross ? [cross] : []), "release", windows ? "jouzu-host.exe" : "jouzu-host");
mkdirSync(join(root, "host", "target", "package"), { recursive: true });
copyFileSync(built, join(root, "host", "target", "package", "jouzu-host.exe"));
