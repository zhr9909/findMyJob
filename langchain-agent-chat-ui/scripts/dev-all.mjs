import { spawn } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const projectRoot = resolve(root, "..");
const isWindows = process.platform === "win32";
const shell = process.env.ComSpec ?? "cmd.exe";
const nodePath = process.env.FINDMYJOB_NODE_DIR ?? dirname(process.execPath);

function buildEnv() {
  const next = {};
  let currentPath = "";

  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === "path") {
      currentPath ||= value ?? "";
      continue;
    }
    next[key] = value;
  }

  next[isWindows ? "Path" : "PATH"] = [nodePath, currentPath]
    .filter(Boolean)
    .join(delimiter);
  return next;
}

const env = buildEnv();

const processes = [
  {
    name: "flask",
    command: "python",
    args: ["server.py"],
    cwd: projectRoot,
  },
  {
    name: "agents",
    command: resolve(nodePath, "npm.cmd"),
    args: ["run", "dev", "--workspace=agents"],
    cwd: root,
  },
  {
    name: "web",
    command: resolve(nodePath, "npm.cmd"),
    args: ["run", "dev", "--workspace=web"],
    cwd: root,
  },
];

function spawnProcess(item) {
  const usesWindowsShell = isWindows && item.command.toLowerCase().endsWith(".cmd");
  const command = usesWindowsShell ? shell : item.command;
  const args = usesWindowsShell
    ? ["/d", "/s", "/c", item.command, ...item.args]
    : item.args;

  return spawn(command, args, {
    cwd: item.cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const children = processes.map((item) => {
  const child = spawnProcess(item);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${item.name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${item.name}] ${chunk}`);
  });
  child.on("exit", (code) => {
    process.stdout.write(`[${item.name}] exited with code ${code}\n`);
  });

  return child;
});

function shutdown() {
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
