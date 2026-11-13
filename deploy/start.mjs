// Runs the relayer, executor and notifier in one container (Railway).
// Each service is compiled JS run with plain node. If any one exits, the
// others are stopped and the container exits non-zero so Railway restarts it.
// Per-service overrides: NOTIFIER__NEAR_RPC_URL=... sets NEAR_RPC_URL for the
// notifier only (same for RELAYER__ and EXECUTOR__).
import { spawn } from "node:child_process";
import http from "node:http";

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

// One public port (Railway gives a service one domain): /notifier/... goes to
// the notifier with the prefix stripped, everything else to the relayer.
// Set NOTIFY_PUBLIC_URL and the web app's NEXT_PUBLIC_NOTIFIER_URL to
// https://<domain>/notifier.
if (process.env.PORT) {
  const relayerPort = Number(process.env.RELAYER_PORT ?? 8787);
  const notifierPort = Number(process.env.NOTIFY_PORT ?? 8790);
  const server = http.createServer((req, res) => {
    let port = relayerPort;
    let path = req.url ?? "/";
    if (path === "/notifier" || path.startsWith("/notifier/") || path.startsWith("/notifier?")) {
      port = notifierPort;
      path = path.slice("/notifier".length) || "/";
      if (path.startsWith("?")) path = "/" + path;
    }
    const xff = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    const upstream = http.request(
      { host: "127.0.0.1", port, method: req.method, path, headers: { ...req.headers, "x-forwarded-for": xff } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":"service unavailable"}');
    });
    req.pipe(upstream);
  });
  server.listen(Number(process.env.PORT), "0.0.0.0", () => console.log(`[start] router on :${process.env.PORT} (/notifier → :${notifierPort}, else → :${relayerPort})`));
}
