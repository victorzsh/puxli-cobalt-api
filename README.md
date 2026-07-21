# Puxli download backend

Docker wrapper for the private processing API used by
[Puxli](https://puxli.vercel.app).

It runs the official [`ghcr.io/imputnet/cobalt:11`](https://github.com/imputnet/cobalt)
image for TikTok, Instagram, and X. YouTube requests are handled by a queued
`yt-dlp` worker with FFmpeg and the BgUtils PO-token provider. A small gateway
exposes both services through Render's single public port.

The worker accepts jobs only through the authenticated Vercel API. Completed
files use short-lived signed URLs and are removed after delivery. No secret is
stored in this repository.

Cobalt is licensed under the [GNU AGPL v3](https://github.com/imputnet/cobalt/blob/main/LICENSE).
