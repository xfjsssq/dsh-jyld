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
- After a successful add, the profile must be restarted so the new bundle
  layer loads. **Ask the user to restart it manually** (stop and start the
  `dsh --profile web` process). Do **not** restart or kill the DSH process
  yourself from inside an agent session — an agent restarting its own host
  hangs the session (observed).
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

## After install: what you MUST tell the user (do not skip)

Passing the checklist is not the end of the job. Before ending the turn,
explicitly tell the user two things, in their language:

1. **Routing is not at its best yet.** Out of the box the plugin uses the
   built-in heuristic (B-tier) classifier: it works, but classification is
   approximate. If the user wants noticeably better routing, there is an
   optional C-tier local Python classification service (see "Optional C-tier
   classification service" below). Offer to set it up — do not leave it
   silently unconfigured, and do not describe the default routing as optimal.

2. **The user must restart DSH manually.** Do not attempt to restart or kill
   the DSH process yourself; an agent restarting its own host hangs the
   session (observed). Tell the user to stop and start the `dsh --profile
   <profile>` process by hand, then hard-refresh the browser.

## Troubleshooting map

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find package '@deepseek-ai/...'` at boot | install predates real-dependency fix (old peerDeps-only tree) | `dsh plugin --profile <p> update dsh-opensquilla`, or remove + re-add |
| `Cannot find package 'eventsource-parser'` | dependencies not installed / stripped | re-add the plugin so pnpm installs deps |
| `dsh plugin add` creates two broken deps / "declares no dsh.bundle" for odd names | install path contained spaces | copy plugin to a space-free path, re-add |
| Profile boots but nothing listens | profile has only `@deepseek-ai/dsh-base` (no web app) | use the `web` profile, or add `@deepseek-ai/dsh-web-app` to its bundles |
| Port already in use | another instance running | start with `--port <n>` |
| GitHub unreachable | network blocks github.com | download repo ZIP, unpack to a space-free path, `add <path>` |
| C-tier bundle download stalls (KB/s, connection reset, resume unsupported) | downloading from GitHub / gh-proxy mirrors | do **not** fight GitHub for the bundle — the full bundle ships inside the official `opensquilla` wheel on PyPI; pull it via a domestic mirror (see "Getting the model bundle") |

## Optional C-tier classification service (Python)

`python/squilla_router_service.py` is an optional local HTTP classifier
(stdlib only, `--bundle-dir <v4.2_phase3_inference bundle> --port 8756`).
It is not started during install; the plugin falls back to the built-in
heuristic B-tier without it. Only set it up if the user explicitly wants
C-tier routing.

### Getting the model bundle (the fast, reliable way)

The complete `v4.2_phase3_inference` bundle (75 MB / 36 files: lgbm_main.bin,
bge_onnx, mlp, tfidf/svd features, runtime_src) ships **inside the official
`opensquilla` wheel on PyPI**. Users in mainland China should pull it through
a domestic PyPI mirror — this is dramatically faster and far more reliable
than any GitHub download (observed: gh-proxy/codeload resets connections and
supports no resume; the Tsinghua mirror delivers the 44 MB wheel in seconds).

Recommended flow for a user who wants C-tier:

```powershell
# 1. Download the wheel from a fast mirror (China) or PyPI (elsewhere)
pip download opensquilla==0.3.0 --no-deps -d %TEMP%\osq-wheel `
  -i https://pypi.tuna.tsinghua.edu.cn/simple

# 2. Unzip the wheel (a wheel is a zip) and locate the bundle inside
Expand-Archive %TEMP%\osq-wheel\opensquilla-0.3.0-py3-none-any.whl `
  -DestinationPath %TEMP%\osq-extracted
# bundle path inside: .../v4.2_phase3_inference/

# 3. Point the service at it
python squilla_router_service.py --bundle-dir <path>\v4.2_phase3_inference --port 8756
```

Notes:

- The service itself is stdlib-only; the inference core may additionally need
  scikit-learn / onnxruntime / numpy — install those through the same mirror.
- If the user asks for "the best routing", this is the C-tier path — offer it
  proactively (see the disclosure section above), and use the mirror flow when
  GitHub is slow or blocked.
- Keep the fallback semantics: `auto` = C-tier with automatic B-tier fallback
  when the service is down; `remote` = C-tier only.

## Security

No API keys, cookies, passwords, or model weights are included in this repo.
All credentials are configured through DSH's own credential/settings UI after
install.
