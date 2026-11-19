import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const base = process.platform === "win32"
  ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  : process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : join(homedir(), ".local", "share");
const env = {
  ...process.env,
  JOUZU_DESKTOP_DEV_HOME: process.env.JOUZU_DESKTOP_DEV_HOME ?? join(base, "Shisa.ai", "JouzuDesktopDev"),
};
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, ["tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json"], {
  cwd: resolve(here),
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", code => process.exit(code ?? 0));
