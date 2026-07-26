# Puxli Cobalt API

Docker wrapper for the private processing API used by
[Puxli](https://puxli.xyz).

It runs the official [`ghcr.io/imputnet/cobalt:11`](https://github.com/imputnet/cobalt)
image for TikTok and X. YouTube, Instagram, Reddit, and Vimeo requests are handled by a queued
`yt-dlp` worker with FFmpeg; YouTube also uses the BgUtils PO-token provider. A small gateway
exposes both services through Render's single public port.

The worker accepts jobs only through the authenticated Vercel API. Completed
files use short-lived signed URLs and are removed after delivery. No secret is
stored in this repository.

Cobalt is licensed under the [GNU AGPL v3](https://github.com/imputnet/cobalt/blob/main/LICENSE).
