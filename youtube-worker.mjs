import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const port = Number.parseInt(process.env.YOUTUBE_WORKER_PORT || "9100", 10);
const workDir = process.env.YOUTUBE_WORK_DIR || "/tmp/puxli-youtube";
const secret = process.env.PUXLI_API_KEY || "";
const publicUrl = (process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const allowedQualities = new Set(["max", "2160", "1440", "1080", "720", "480"]);
const allowedBitrates = new Set(["320", "256", "128"]);
const jobs = new Map();
const queue = [];
let active = false;

await mkdir(workDir, { recursive: true });

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function isAuthorized(request) {
  const expected = Buffer.from(`Api-Key ${secret}`);
  const supplied = Buffer.from(request.headers.authorization || "");
  return secret.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && (
      parsed.hostname === "youtu.be" || parsed.hostname.endsWith(".youtu.be") ||
      parsed.hostname === "youtube.com" || parsed.hostname.endsWith(".youtube.com")
    );
  } catch { return false; }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8_192) throw new Error("request_too_large");
  }
  return JSON.parse(body || "{}");
}

function sign(jobId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ jobId, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verify(token) {
  try {
    const [payload, signature] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded.jobId || !decoded.expiresAt || Date.now() > decoded.expiresAt) return null;
    return decoded;
  } catch { return null; }
}

function ytDlpArgs(job, extractorArgs) {
  const args = [
    "--no-playlist", "--no-progress", "--no-warnings",
    "--js-runtimes", "node",
    "--extractor-args", extractorArgs,
    "--concurrent-fragments", "2", "--socket-timeout", "30",
    "--retries", "3", "--fragment-retries", "3", "--max-filesize", "1500M",
    "--paths", workDir, "--output", `${job.id}.%(ext)s`,
  ];
  if (job.mode === "audio") {
    args.push("--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", `${job.audioBitrate}K`);
  } else {
    const height = job.quality === "max" ? "" : `[height<=${job.quality}]`;
    args.push("--format", `bv*${height}+ba/b${height}`, "--merge-output-format", "mp4");
  }
  args.push(job.url);
  return args;
}

async function run(job) {
  job.state = "processing";
  const extractorVariants = [
    "youtube:player_client=mweb;fetch_pot=always",
    "youtube:fetch_pot=always",
    "youtube:player_client=web_embedded",
  ];
  let lastError = "";
  let exitCode = 1;
  for (const extractorArgs of extractorVariants) {
    let errorOutput = "";
    const child = spawn("/opt/yt-dlp/bin/yt-dlp", ytDlpArgs(job, extractorArgs), {
      cwd: workDir, env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-8_000); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
    exitCode = await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    lastError = errorOutput;
    if (exitCode === 0) break;
  }
  if (exitCode !== 0) {
    console.error("YouTube processing failed", { jobId: job.id, exitCode, detail: lastError.slice(-1_000) });
    job.state = "error";
    return;
  }
  const files = await readdir(workDir);
  const output = files.find((name) => name.startsWith(`${job.id}.`) && !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (!output) { job.state = "error"; return; }
  job.filePath = path.join(workDir, output);
  const extension = path.extname(output).slice(1).replace(/[^a-z0-9]/gi, "") || (job.mode === "audio" ? "mp3" : "mp4");
  job.filename = `puxli-youtube-${job.id.slice(0, 8)}.${extension}`;
  job.state = "ready";
}

async function runNext() {
  if (active || queue.length === 0) return;
  active = true;
  const job = queue.shift();
  try { await run(job); }
  catch (error) {
    console.error("YouTube worker failed", { jobId: job.id, error: error instanceof Error ? error.message : "unknown" });
    job.state = "error";
  } finally { active = false; void runNext(); }
}

async function prepare(request, response) {
  if (!isAuthorized(request)) return json(response, 401, { status: "error", error: { code: "error.api.auth" } });
  const body = await readJson(request);
  if (!isYouTubeUrl(body.url)) return json(response, 400, { status: "error", error: { code: "error.api.link" } });
  if (queue.length >= 3) return json(response, 429, { status: "error", error: { code: "error.api.busy" } });
  const job = {
    id: crypto.randomUUID(), url: body.url, mode: body.mode === "audio" ? "audio" : "video",
    quality: allowedQualities.has(body.quality) ? body.quality : "max",
    audioBitrate: allowedBitrates.has(body.audioBitrate) ? body.audioBitrate : "320",
    state: "queued", createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  queue.push(job);
  void runNext();
  return json(response, 202, { status: "processing", jobId: job.id });
}

async function status(request, response) {
  if (!isAuthorized(request)) return json(response, 401, { status: "error", error: { code: "error.api.auth" } });
  const { jobId } = await readJson(request);
  const job = jobs.get(jobId);
  if (!job || Date.now() - job.createdAt > 30 * 60 * 1000) return json(response, 404, { status: "error", error: { code: "error.api.job" } });
  if (job.state === "error") return json(response, 422, { status: "error", error: { code: "error.api.youtube" } });
  if (job.state !== "ready") return json(response, 202, { status: "processing", jobId: job.id });
  const expiresAt = Date.now() + 10 * 60 * 1000;
  return json(response, 200, {
    status: "redirect", url: `${publicUrl}/youtube/download?token=${encodeURIComponent(sign(job.id, expiresAt))}`, filename: job.filename,
  });
}

async function download(request, response, url) {
  const token = verify(url.searchParams.get("token") || "");
  const job = token ? jobs.get(token.jobId) : null;
  if (!job || job.state !== "ready" || !job.filePath) return json(response, 404, { status: "error", error: { code: "error.api.file" } });
  job.state = "delivering";
  const file = await stat(job.filePath);
  response.writeHead(200, {
    "content-type": job.mode === "audio" ? "audio/mpeg" : "application/octet-stream",
    "content-length": file.size, "content-disposition": `attachment; filename="${job.filename}"`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  });
  createReadStream(job.filePath).pipe(response);
  response.once("close", async () => {
    jobs.delete(job.id);
    try { await unlink(job.filePath); } catch {}
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/youtube/health") return json(response, 200, { status: "ok" });
    if (request.method === "POST" && url.pathname === "/youtube/prepare") return await prepare(request, response);
    if (request.method === "POST" && url.pathname === "/youtube/status") return await status(request, response);
    if (request.method === "GET" && url.pathname === "/youtube/download") return await download(request, response, url);
    return json(response, 404, { status: "error", error: { code: "error.api.not_found" } });
  } catch (error) {
    console.error("YouTube request failed", { error: error instanceof Error ? error.message : "unknown" });
    return json(response, 500, { status: "error", error: { code: "error.api.internal" } });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`YouTube worker listening on ${port}`));
setInterval(async () => {
  const expired = [...jobs.values()].filter((job) => Date.now() - job.createdAt > 30 * 60 * 1000);
  for (const job of expired) {
    jobs.delete(job.id);
    if (job.filePath) try { await unlink(job.filePath); } catch {}
  }
}, 60_000).unref();
