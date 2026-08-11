import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const port = Number.parseInt(process.env.YOUTUBE_WORKER_PORT || "9100", 10);
const host = process.env.YOUTUBE_WORKER_HOST || "127.0.0.1";
const workDir = process.env.YOUTUBE_WORK_DIR || "/tmp/puxli-youtube";
const secret = process.env.PUXLI_API_KEY || "";
const publicUrl = (process.env.YOUTUBE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const ytDlpPath = process.env.YT_DLP_PATH || "/opt/yt-dlp/bin/yt-dlp";
const jsRuntime = process.env.YOUTUBE_JS_RUNTIME || "node";
const cookiesPath = process.env.YOUTUBE_COOKIES_PATH || "";
const youtubeProxyUrl = process.env.YOUTUBE_PROXY_URL || "";
const allowedQualities = new Set(["max", "2160", "1440", "1080", "720", "480"]);
const allowedBitrates = new Set(["320", "256", "128"]);
const videoExtensions = new Set(["mp4", "m4v", "mov", "mkv", "webm"]);
const mediaOrigins = new Set([
  "https://puxli.xyz",
  "https://www.puxli.xyz",
  "https://editor.puxli.xyz",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://127.0.0.1:3100",
  "http://127.0.0.1:3200",
]);
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

function sourceFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (
      parsed.hostname === "youtu.be" || parsed.hostname.endsWith(".youtu.be") ||
      parsed.hostname === "youtube.com" || parsed.hostname.endsWith(".youtube.com")
    ) return "youtube";
    if (
      parsed.hostname === "reddit.com" || parsed.hostname.endsWith(".reddit.com") ||
      parsed.hostname === "redd.it" || parsed.hostname.endsWith(".redd.it")
    ) return "reddit";
    if (parsed.hostname === "instagram.com" || parsed.hostname.endsWith(".instagram.com")) return "instagram";
    if (parsed.hostname === "vimeo.com" || parsed.hostname.endsWith(".vimeo.com")) return "vimeo";
    return null;
  } catch { return null; }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8_192) throw new Error("request_too_large");
  }
  return JSON.parse(body || "{}");
}

function sign(jobId, expiresAt, optionIndex) {
  const payload = Buffer.from(JSON.stringify({
    jobId,
    expiresAt,
    ...(Number.isInteger(optionIndex) ? { optionIndex } : {}),
  })).toString("base64url");
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

function metadataArgs(url, extractorArgs) {
  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--skip-download",
    "--dump-single-json",
    "--js-runtimes", jsRuntime,
    "--extractor-args", extractorArgs,
    "--socket-timeout", "30",
    "--retries", "2",
  ];
  if (youtubeProxyUrl) args.push("--proxy", youtubeProxyUrl);
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(url);
  return args;
}

function scoreVideo(format) {
  const codec = String(format.vcodec || "").toLowerCase();
  let score = Number(format.tbr || 0);
  if (format.ext === "mp4") score += 1_000_000;
  if (codec.startsWith("avc1")) score += 300_000;
  else if (codec.startsWith("av01")) score += 200_000;
  else if (codec.startsWith("vp9") || codec.startsWith("vp0")) score += 100_000;
  if (format.filesize || format.filesize_approx) score += 10_000;
  return score;
}

function scoreAudio(format) {
  let score = Number(format.abr || format.tbr || 0);
  if (format.ext === "m4a") score += 100_000;
  if (format.filesize || format.filesize_approx) score += 10_000;
  return score;
}

function bestBy(formats, key, score) {
  const selected = new Map();
  for (const format of formats) {
    const value = key(format);
    const current = selected.get(value);
    if (!current || score(format) > score(current)) selected.set(value, format);
  }
  return [...selected.values()];
}

function downloadUrl(value, title, suffix) {
  const safeTitle = String(title || "puxli-youtube")
    .replace(/[^\p{L}\p{N}._ -]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "puxli-youtube";
  const url = new URL(value);
  url.searchParams.set("title", `${safeTitle}-${suffix}`);
  return url.toString();
}

function mediaUrl(job, optionIndex, expiresAt) {
  return `${publicUrl}/youtube/media?token=${encodeURIComponent(sign(job.id, expiresAt, optionIndex))}`;
}

function resolutionLabel(height) {
  if (height === 2160) return "2160p (4K)";
  if (height === 1440) return "1440p (2K)";
  return `${height}p`;
}

function optionFromVideo(format, kind, title) {
  const height = Number(format.height || 0);
  const ext = String(format.ext || "video").toUpperCase();
  return {
    type: "video",
    kind,
    url: downloadUrl(format.url, title, `${height}p`),
    label: `${resolutionLabel(height)} · ${ext}`,
    height,
    ext: String(format.ext || ""),
    codec: String(format.vcodec || ""),
    filesize: Number(format.filesize || format.filesize_approx || 0) || undefined,
    formatId: String(format.format_id || ""),
    requestHeaders: format.http_headers && typeof format.http_headers === "object" ? format.http_headers : undefined,
  };
}

function optionFromAudio(format, title) {
  const ext = String(format.ext || "audio").toUpperCase();
  const bitrate = Math.round(Number(format.abr || format.tbr || 0));
  return {
    type: "audio",
    kind: "audio",
    url: downloadUrl(format.url, title, "audio"),
    label: bitrate ? `${ext} · ${bitrate} kbps` : ext,
    ext: String(format.ext || ""),
    codec: String(format.acodec || ""),
    bitrate: bitrate || undefined,
    filesize: Number(format.filesize || format.filesize_approx || 0) || undefined,
    formatId: String(format.format_id || ""),
    requestHeaders: format.http_headers && typeof format.http_headers === "object" ? format.http_headers : undefined,
  };
}

function selectYouTubeOptions(metadata, mode) {
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  const direct = formats.filter((format) => (
    typeof format.url === "string"
    && format.url.startsWith("https://")
    && format.protocol === "https"
    && !format.has_drm
  ));
  const audioOnly = direct.filter((format) => format.vcodec === "none" && format.acodec !== "none");
  const audioByExtension = bestBy(audioOnly, (format) => format.ext || format.acodec, scoreAudio)
    .sort((left, right) => scoreAudio(right) - scoreAudio(left));

  if (mode === "audio") {
    return audioByExtension.slice(0, 3).map((format) => optionFromAudio(format, metadata.title));
  }

  const combined = bestBy(
    direct.filter((format) => Number(format.height) > 0 && format.vcodec !== "none" && format.acodec !== "none"),
    (format) => Number(format.height),
    scoreVideo,
  ).sort((left, right) => Number(right.height) - Number(left.height));
  const maxCombinedHeight = Math.max(0, ...combined.map((format) => Number(format.height || 0)));
  const videoOnly = bestBy(
    direct.filter((format) => (
      Number(format.height) > maxCombinedHeight
      && format.vcodec !== "none"
      && format.acodec === "none"
    )),
    (format) => Number(format.height),
    scoreVideo,
  ).sort((left, right) => Number(right.height) - Number(left.height));
  const options = [
    ...combined.slice(0, 4).map((format) => optionFromVideo(format, "combined", metadata.title)),
    ...videoOnly.slice(0, 7).map((format) => optionFromVideo(format, "video", metadata.title)),
  ];
  if (videoOnly.length > 0 && audioByExtension[0]) {
    options.push(optionFromAudio(audioByExtension[0], metadata.title));
  }
  return options;
}

async function extractYouTubeMetadata(url, extractorArgs) {
  let output = "";
  let errorOutput = "";
  let tooLarge = false;
  const child = spawn(ytDlpPath, metadataArgs(url, extractorArgs), {
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 12_000_000) {
      tooLarge = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-8_000);
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 2 * 60 * 1000);
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  if (tooLarge) throw new Error("metadata_too_large");
  if (exitCode !== 0) throw new Error(errorOutput || `yt_dlp_exit_${exitCode}`);
  return JSON.parse(output);
}

async function resolveYouTube(job) {
  const extractorVariants = process.env.YOUTUBE_BGUTIL === "enabled" ? [
    "youtube:player_client=mweb;fetch_pot=always",
    "youtube:fetch_pot=always",
    "youtube:player_client=web_embedded",
  ] : [
    "youtube:player_client=default,-android_sdkless",
    "youtube:player_client=web_safari",
    "youtube:player_client=web_embedded",
  ];
  let lastError = "";
  for (const extractorArgs of extractorVariants) {
    try {
      const metadata = await extractYouTubeMetadata(job.url, extractorArgs);
      const options = selectYouTubeOptions(metadata, job.mode);
      if (options.length === 0) throw new Error("no_direct_formats");
      job.title = String(metadata.title || "YouTube");
      job.thumbnail = typeof metadata.thumbnail === "string" ? metadata.thumbnail : undefined;
      job.extractorArgs = extractorArgs;
      job.options = options;
      job.state = "ready";
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown";
    }
  }
  throw new Error(lastError || "youtube_lookup_failed");
}

function ytDlpArgs(job, extractorArgs) {
  const args = [
    "--no-playlist", "--no-progress", "--no-warnings",
    "--js-runtimes", "node",
    "--concurrent-fragments", "2", "--socket-timeout", "30",
    "--retries", "3", "--fragment-retries", "3", "--max-filesize", "1500M",
    "--paths", workDir, "--output", `${job.id}.%(ext)s`,
  ];
  if (youtubeProxyUrl) args.push("--proxy", youtubeProxyUrl);
  if (extractorArgs) args.push("--extractor-args", extractorArgs);
  if (job.mode === "audio") {
    args.push("--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", `${job.audioBitrate}K`);
  } else {
    const height = job.quality === "max" ? "" : `[height<=${job.quality}]`;
    const format = job.source === "instagram"
      ? "b[ext=mp4]/b/bv*+ba/b"
      : `bv*${height}+ba/b${height}`;
    args.push("--format", format, "--merge-output-format", "mp4");
  }
  args.push(job.url);
  return args;
}

async function run(job) {
  job.state = "processing";
  if (job.source === "youtube") {
    await resolveYouTube(job);
    return;
  }

  const extractorVariants = job.source === "youtube" ? [
    "youtube:player_client=mweb;fetch_pot=always",
    "youtube:fetch_pot=always",
    "youtube:player_client=web_embedded",
  ] : job.source === "vimeo" ? [
    "vimeo:client=web",
    "",
  ] : [""];
  let lastError = "";
  let exitCode = 1;
  for (const extractorArgs of extractorVariants) {
    let errorOutput = "";
    const child = spawn(ytDlpPath, ytDlpArgs(job, extractorArgs), {
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
    console.error("Media processing failed", { source: job.source, jobId: job.id, exitCode, detail: lastError.slice(-1_000) });
    job.state = "error";
    return;
  }
  const files = await readdir(workDir);
  const output = files.find((name) => name.startsWith(`${job.id}.`) && !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (!output) { job.state = "error"; return; }
  job.filePath = path.join(workDir, output);
  const extension = path.extname(output).slice(1).replace(/[^a-z0-9]/gi, "") || (job.mode === "audio" ? "mp3" : "mp4");
  if (job.mode === "video" && !videoExtensions.has(extension.toLowerCase())) {
    console.error("Media worker rejected non-video output", { source: job.source, jobId: job.id, extension });
    try { await unlink(job.filePath); } catch {}
    job.filePath = null;
    job.state = "error";
    return;
  }
  job.filename = `puxli-${job.source}-${job.id.slice(0, 8)}.${extension}`;
  job.state = "ready";
}

async function runNext() {
  if (active || queue.length === 0) return;
  active = true;
  const job = queue.shift();
  try { await run(job); }
  catch (error) {
    console.error("Media worker failed", { source: job.source, jobId: job.id, error: error instanceof Error ? error.message : "unknown" });
    job.state = "error";
  } finally { active = false; void runNext(); }
}

async function prepare(request, response) {
  if (!isAuthorized(request)) return json(response, 401, { status: "error", error: { code: "error.api.auth" } });
  const body = await readJson(request);
  const source = sourceFromUrl(body.url);
  if (!source) return json(response, 400, { status: "error", error: { code: "error.api.link" } });
  if (queue.length >= 3) return json(response, 429, { status: "error", error: { code: "error.api.busy" } });
  const job = {
    id: crypto.randomUUID(), source, url: body.url, mode: body.mode === "audio" ? "audio" : "video",
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
  if (job.state === "error") return json(response, 422, { status: "error", error: { code: "error.api.media" } });
  if (job.state !== "ready") return json(response, 202, { status: "processing", jobId: job.id });
  const expiresAt = Date.now() + 10 * 60 * 1000;
  if (job.source === "youtube" && Array.isArray(job.options)) {
    return json(response, 200, {
      status: "picker",
      title: job.title,
      thumbnail: job.thumbnail,
      // Keep signed Google Video URLs server-side. The browser downloads through
      // the worker so CORS and YouTube's origin checks do not reject the file.
      picker: job.options.map((option, optionIndex) => {
        const publicOption = { ...option };
        delete publicOption.requestHeaders;
        return {
          ...publicOption,
          url: mediaUrl(job, optionIndex, expiresAt),
        };
      }),
    });
  }
  return json(response, 200, {
    status: "redirect", url: `${publicUrl}/${job.source}/download?token=${encodeURIComponent(sign(job.id, expiresAt))}`, filename: job.filename,
  });
}

async function downloadSelectedFormat(job, option) {
  if (!job.extractorArgs || !option.formatId) return null;
  const outputPrefix = `${job.id}-relay`;
  const args = [
    "--no-playlist", "--no-progress", "--no-warnings",
    "--js-runtimes", jsRuntime,
    "--extractor-args", job.extractorArgs,
    "--format", option.formatId,
    "--paths", workDir,
    "--output", `${outputPrefix}.%(ext)s`,
    "--socket-timeout", "30", "--retries", "2", "--fragment-retries", "2",
    job.url,
  ];
  if (youtubeProxyUrl) args.splice(2, 0, "--proxy", youtubeProxyUrl);
  if (cookiesPath) args.splice(2, 0, "--cookies", cookiesPath);

  let errorOutput = "";
  const child = spawn(ytDlpPath, args, {
    cwd: workDir,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-8_000); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  if (exitCode !== 0) {
    console.error("Selected YouTube format fallback failed", { jobId: job.id, formatId: option.formatId, detail: errorOutput.slice(-1_000) });
    return null;
  }
  const files = await readdir(workDir);
  const output = files.find((name) => name.startsWith(`${outputPrefix}.`) && !name.endsWith(".part") && !name.endsWith(".ytdl"));
  return output ? path.join(workDir, output) : null;
}

async function streamLocalMedia(filePath, response, option) {
  const file = await stat(filePath);
  response.writeHead(200, {
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="puxli-youtube.${option.kind === "audio" ? "m4a" : "mp4"}"`,
    "content-length": file.size,
    "content-type": option.kind === "audio" ? "audio/mp4" : "video/mp4",
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
  response.once("close", async () => { try { await unlink(filePath); } catch {} });
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

function getMediaOrigin(request) {
  const origin = request.headers.origin || "";
  return mediaOrigins.has(origin) ? origin : null;
}

function isGoogleVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

async function relayYouTubeMedia(request, response, url) {
  const requestOrigin = request.headers.origin || "";
  const origin = requestOrigin ? getMediaOrigin(request) : null;
  // Browser navigations/downloads commonly omit Origin. The signed token is
  // the authorization in that case; reject an explicitly invalid origin.
  if (requestOrigin && !origin) return json(response, 403, { status: "error", error: { code: "error.api.origin" } });

  const token = verify(url.searchParams.get("token") || "");
  const job = token ? jobs.get(token.jobId) : null;
  const option = job && Number.isInteger(token.optionIndex)
    ? job.options?.[token.optionIndex]
    : null;
  if (!job || job.source !== "youtube" || job.state !== "ready" || !option || !isGoogleVideoUrl(option.url)) {
    return json(response, 404, { status: "error", error: { code: "error.api.file" } });
  }

  const sourceHeaders = Object.fromEntries(
    Object.entries(option.requestHeaders || {})
      .filter(([name, value]) => typeof value === "string" && !["host", "content-length"].includes(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
  const upstream = await fetch(option.url, {
    redirect: "follow",
    headers: {
      ...sourceHeaders,
      // A download opened as a browser navigation advertises text/html. Keep
      // the media Accept header from yt-dlp instead of forwarding that value.
      accept: sourceHeaders.accept || "*/*",
      ...(request.headers.range ? { range: request.headers.range } : {}),
      referer: "https://www.youtube.com/",
      "user-agent": sourceHeaders["user-agent"] || "Mozilla/5.0",
    },
  });
  if (!upstream.ok || !upstream.body || !isGoogleVideoUrl(upstream.url)) {
    console.warn("YouTube direct media rejected; trying yt-dlp fallback", {
      jobId: job.id,
      formatId: option.formatId,
      status: upstream.status,
      finalHost: (() => { try { return new URL(upstream.url).hostname; } catch { return "invalid"; } })(),
    });
    const filePath = await downloadSelectedFormat(job, option);
    if (filePath) return await streamLocalMedia(filePath, response, option);
    return json(response, 502, { status: "error", error: { code: "error.api.upstream" } });
  }

  const headers = {
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="puxli-youtube.${option.kind === "audio" ? "m4a" : "mp4"}"`,
    "content-type": upstream.headers.get("content-type") || (option.kind === "audio" ? "audio/mp4" : "video/mp4"),
    "x-content-type-options": "nosniff",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-expose-headers"] = "content-disposition, content-length, content-range, content-type";
    headers["vary"] = "Origin";
  }
  for (const header of ["accept-ranges", "content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) headers[header] = value;
  }
  response.writeHead(upstream.status, headers);
  const mediaStream = Readable.fromWeb(upstream.body);
  mediaStream.on("error", (error) => {
    if (!response.destroyed) response.destroy(error);
  });
  response.once("close", () => mediaStream.destroy());
  mediaStream.pipe(response);
}

function allowMediaPreflight(request, response) {
  const origin = getMediaOrigin(request);
  if (!origin) return json(response, 403, { status: "error", error: { code: "error.api.origin" } });
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/youtube/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/instagram/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/reddit/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/vimeo/health") return json(response, 200, { status: "ok" });
    if (request.method === "POST" && (url.pathname === "/youtube/prepare" || url.pathname === "/instagram/prepare" || url.pathname === "/reddit/prepare" || url.pathname === "/vimeo/prepare")) return await prepare(request, response);
    if (request.method === "POST" && (url.pathname === "/youtube/status" || url.pathname === "/instagram/status" || url.pathname === "/reddit/status" || url.pathname === "/vimeo/status")) return await status(request, response);
    if (request.method === "OPTIONS" && url.pathname === "/youtube/media") return allowMediaPreflight(request, response);
    if (request.method === "GET" && url.pathname === "/youtube/media") return await relayYouTubeMedia(request, response, url);
    if (request.method === "GET" && (url.pathname === "/youtube/download" || url.pathname === "/instagram/download" || url.pathname === "/reddit/download" || url.pathname === "/vimeo/download")) return await download(request, response, url);
    return json(response, 404, { status: "error", error: { code: "error.api.not_found" } });
  } catch (error) {
    console.error("Media request failed", { error: error instanceof Error ? error.message : "unknown" });
    return json(response, 500, { status: "error", error: { code: "error.api.internal" } });
  }
});

server.listen(port, host, () => console.log(`Media worker listening on ${host}:${port}`));
setInterval(async () => {
  const expired = [...jobs.values()].filter((job) => Date.now() - job.createdAt > 30 * 60 * 1000);
  for (const job of expired) {
    jobs.delete(job.id);
    if (job.filePath) try { await unlink(job.filePath); } catch {}
  }
}, 60_000).unref();
