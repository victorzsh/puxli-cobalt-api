import http from "node:http";
import { spawn } from "node:child_process";

const publicPort = Number.parseInt(process.env.PORT || "10000", 10);
const children = new Set();
let stopping = false;

function start(name, command, args) {
  const child = spawn(command, args, { cwd: "/app", env: process.env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} exited unexpectedly`, { code, signal });
      shutdown(code || 1);
    }
  });
}

const server = http.createServer((request, response) => {
  const path = new URL(request.url || "/", "http://localhost").pathname;
  const upstreamPort = path.startsWith("/youtube/") || path.startsWith("/reddit/") ? 9100 : 9000;
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` },
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "error", error: { code: "error.api.unavailable" } }));
  });
  request.pipe(proxy);
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_000).unref();
}

process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));

const cobaltCommand = process.argv[2] || "node";
const cobaltArgs = process.argv.length > 3 ? process.argv.slice(3) : ["src/cobalt"];
start("bgutil", "node", ["/opt/bgutil/build/main.js"]);
start("youtube-worker", "node", ["/opt/puxli/youtube-worker.mjs"]);
start("cobalt", cobaltCommand, cobaltArgs);

server.listen(publicPort, "0.0.0.0", () => console.log(`Puxli gateway listening on ${publicPort}`));
