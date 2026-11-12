// Runs the relayer, executor and notifier in one container (Railway).
// Each service is compiled JS run with plain node. If any one exits, the
// others are stopped and the container exits non-zero so Railway restarts it.
// Per-service overrides: NOTIFIER__NEAR_RPC_URL=... sets NEAR_RPC_URL for the
// notifier only (same for RELAYER__ and EXECUTOR__).
import { spawn } from "node:child_process";

const services = [
  { name: "relayer", entry: "services/relayer/dist/server.js" },
  { name: "executor", entry: "services/executor/dist/index.js" },
  { name: "notifier", entry: "services/notifier/dist/index.js" },
].filter((s) => !(process.env.DISABLE_SERVICES ?? "").split(",").includes(s.name));

const children = new Map();
let stopping = false;

function prefix(name, stream, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
  if (children.size === 0) process.exit(code);
}

function envFor(name) {
  const env = { ...process.env };
  const pre = `${name.toUpperCase()}__`;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith(pre)) env[k.slice(pre.length)] = v;
  return env;
}

for (const s of services) {
  const child = spawn(process.execPath, ["--max-old-space-size=160", s.entry], { stdio: ["ignore", "pipe", "pipe"], env: envFor(s.name) });
  prefix(s.name, child.stdout, process.stdout);
  prefix(s.name, child.stderr, process.stderr);
  children.set(s.name, child);
  child.on("exit", (code, signal) => {
    children.delete(s.name);
    console.error(`[start] ${s.name} exited (code ${code}, signal ${signal})`);
    if (!stopping) stopAll(code || 1);
    else if (children.size === 0) process.exit(code ?? 0);
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stopAll(0));
