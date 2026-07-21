# Puxli Cobalt API

Minimal Docker wrapper for the private processing API used by
[Puxli](https://puxli.vercel.app).

It runs the official [`ghcr.io/imputnet/cobalt:11`](https://github.com/imputnet/cobalt)
image and creates Cobalt's API-key file at runtime from a Render secret. No secret
is stored in this repository.

Cobalt is licensed under the [GNU AGPL v3](https://github.com/imputnet/cobalt/blob/main/LICENSE).
