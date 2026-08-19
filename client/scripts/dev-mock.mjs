import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const forwardedArguments = process.argv.slice(2);
const isWindows = process.platform === "win32";
const SHUTDOWN_GRACE_MS = 5000;

const services = [
  {
    label: "mock",
    command: process.execPath,
    args: ["--import", "tsx", "mocks/server/main.ts", ...forwardedArguments],
  },
  {
    label: "next",
    command: process.execPath,
    args: [nextBin, "dev", "-H", "127.0.0.1"],
  },
];

const running = new Set();
let shuttingDown = false;
let exitCode = 0;

function prefixLines(label, stream, target) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      target.write(`[${label}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (pending !== "") {
      target.write(`[${label}] ${pending}\n`);
    }
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  exitCode = code;
  for (const child of running) {
    killTree(child);
  }
  setTimeout(() => process.exit(exitCode), SHUTDOWN_GRACE_MS).unref();
  if (running.size === 0) {
    process.exit(exitCode);
  }
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  prefixLines(service.label, child.stdout, process.stdout);
  prefixLines(service.label, child.stderr, process.stderr);
  child.on("exit", (code) => {
    running.delete(child);
    if (!shuttingDown) {
      console.error(`[dev:mock] ${service.label} exited with code ${code ?? "unknown"}`);
    }
    shutdown(code ?? 1);
    if (running.size === 0) {
      process.exit(exitCode);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
