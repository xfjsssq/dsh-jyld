# AGENTS.md — installing dsh-jyld with `dsh`

This repository is a DeepSeek Harness (DSH) plugin bundle. It is meant to be
installed by the `dsh` CLI — including when that CLI is driven by an AI agent
(DSH is an agent; a user may simply paste this repo URL and ask it to install).

## Install (exact command)

```sh
dsh plugin --profile web add github:xfjsssq/dsh-jyld
```

- `web` is the usual profile for the DSH web UI; substitute another profile
  name if the user asks. The command creates the profile if it does not exist.
- After a successful add, restart the profile so the new bundle layer loads
  (stop the running `dsh --profile web` process, start it again).
- Installing from a local copy instead of GitHub? Use a path **without
  spaces** — `dsh plugin add` mishandles paths containing spaces (observed:
  the path got split into two bogus dependencies). Copy the folder to a
  space-free location first, e.g. `C:\plugintest\dsh-jyld`.

## What the installer does automatically — do not redo it

`dsh plugin add` runs pnpm under the hood, which installs **all** runtime
dependencies declared in `package.json`, including the `@deepseek-ai/*`
packages. They are plain npm dependencies here (pinned: `0.1.1-rc.1`,
`@deepseek-ai/cordis` `4.0.1`, `@deepseek-ai/schemastery` `3.18.1`) and are
fetched from the public npm registry. You do **not** need to — and should
not — run `npm install`/`pnpm install` by hand, and you do **not** need to
link packages from a DSH source checkout.

## Verify the install (all four should pass)

1. Profile manifest (`~/.dsh/profiles/<profile>/package.json`) lists
   `dsh-opensquilla` under `dsh.profile.bundles`.
2. The profile starts and serves the web UI without `ERR_MODULE_NOT_FOUND`
   or "plugin tree failed to load" errors.
3. `GET /dsh-opensquilla/billing/session` returns `{"ok":true,...}`.
4. `GET /dsh-opensquilla-routing/pool` returns
   `{"ok":true,"routingEnabled":true,"provider":"tokenrhythm",...}`.

Then in the web UI: the model picker exposes the **智能路由 / auto** virtual
model, and the sidebar has the `¥` balance panel.

## Troubleshooting map

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find package '@deepseek-ai/...'` at boot | install predates real-dependency fix (old peerDeps-only tree) | `dsh plugin --profile <p> update dsh-opensquilla`, or remove + re-add |
| `Cannot find package 'eventsource-parser'` | dependencies not installed / stripped | re-add the plugin so pnpm installs deps |
| `dsh plugin add` creates two broken deps / "declares no dsh.bundle" for odd names | install path contained spaces | copy plugin to a space-free path, re-add |
| Profile boots but nothing listens | profile has only `@deepseek-ai/dsh-base` (no web app) | use the `web` profile, or add `@deepseek-ai/dsh-web-app` to its bundles |
| Port already in use | another instance running | start with `--port <n>` |
| GitHub unreachable | network blocks github.com | download repo ZIP, unpack to a space-free path, `add <path>` |

## Optional C-tier classification service (Python)

`python/squilla_router_service.py` is an optional local HTTP classifier
(stdlib only, `--bundle-dir <v4.2_phase3_inference bundle> --port 8756`).
It is not started during install; the plugin falls back to the built-in
heuristic B-tier without it. Only set it up if the user explicitly wants
C-tier routing.

## Security

No API keys, cookies, passwords, or model weights are included in this repo.
All credentials are configured through DSH's own credential/settings UI after
install.
