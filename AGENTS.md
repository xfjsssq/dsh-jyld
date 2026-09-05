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
- If the `dsh` command is not on PATH (common when DSH runs from a source
  checkout), call the built CLI directly:
  `node <DSH checkout>\apps\cli\lib\bin.js plugin --profile web add github:xfjsssq/dsh-jyld`.
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

Point 1 can be checked immediately after `add`; points 2–4 require a restart.

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
| C-tier bundle download stalls (KB/s, connection reset, resume unsupported) | downloading from GitHub / gh-proxy mirrors | do **not** fight GitHub for the bundle — the full bundle ships inside the official `opensquilla` wheel on PyPI; pull it via a domestic mirror (see "C-tier setup") |
| `classifier: FATAL ... No module named 'lightgbm'` (or onnxruntime / sklearn / yaml / numpy) | inference runtime deps not installed | `python -m pip install numpy scikit-learn joblib lightgbm onnxruntime tokenizers pyyaml -i https://pypi.tuna.tsinghua.edu.cn/simple` |
| `/health` returns `{"ok":true,"available":false,...}` | bundle dir wrong or runtime incomplete | verify `classifierBundleDir` points at the folder containing `runtime_src/` + `version.json`; check service stderr for the missing import |
| PowerShell `Invoke-RestMethod /classify` says "malformed JSON" | PowerShell 5.1 wrote a UTF-8 BOM into the request body | write the JSON body BOM-free (`[System.IO.File]::WriteAllText(..., (New-Object System.Text.UTF8Encoding($false)))`) or use curl.exe |

## Optional C-tier classification service (Python)

`python/squilla_router_service.py` is an optional local HTTP classifier
(`--bundle-dir <v4.2_phase3_inference bundle> --port 8756`). It is not started
during install; the plugin falls back to the built-in heuristic B-tier without
it. Only set it up if the user explicitly wants C-tier routing.

### C-tier setup (exact recipe)

This is the part that costs the most time in a fresh install — do it in this
order and use mirrors aggressively. The service **needs a real Python +
third-party runtime**, so do not treat it as stdlib-only.

#### 1. Get the model bundle (the fast, reliable way)

The complete `v4.2_phase3_inference` bundle (75 MB / 36 files: lgbm_main.bin,
bge_onnx, mlp, tfidf/svd features, runtime_src) ships **inside the official
`opensquilla` wheel on PyPI**. In mainland China pull it through a domestic
PyPI mirror — dramatically faster and more reliable than GitHub (observed:
direct/gh-proxy downloads stall at KB/s and get reset; the Tsinghua mirror
delivers the wheel in seconds).

```powershell
# 1. Download the wheel from a fast mirror (China) or PyPI (elsewhere)
pip download opensquilla==0.3.0 --no-deps -d %TEMP%\osq-wheel `
  -i https://pypi.tuna.tsinghua.edu.cn/simple

# 2. Unzip the wheel (a wheel is a zip); the bundle lives at this exact path
Expand-Archive %TEMP%\osq-wheel\opensquilla-0.3.0-py3-none-any.whl `
  -DestinationPath %TEMP%\osq-extracted

# 3. Copy the bundle folder to the classifier bundle dir
robocopy %TEMP%\osq-extracted\opensquilla\squilla_router\models\v4.2_phase3_inference `
  %USERPROFILE%\.dsh\opensquilla-router\v4.2_phase3_inference /E
```

#### 2. Install the inference runtime dependencies

The service script imports only the stdlib, but the bundled inference core
(`runtime_src`) imports these third-party packages — a bare Python will
`FATAL` without them:

```text
numpy  scikit-learn  joblib  lightgbm  onnxruntime  tokenizers  pyyaml
```

```powershell
# China: use the Tsinghua mirror; elsewhere drop the -i flag
python -m pip install numpy scikit-learn joblib lightgbm onnxruntime tokenizers pyyaml `
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

Python 3.11+ recommended. The plugin needs a concrete interpreter path for the
next step; find it with `(Get-Command python).Source`.

#### 3. Point the plugin at the bundle (settings.yaml)

Add two keys under the `dsh-opensquilla` section of `~/.dsh/settings.yaml`:

```yaml
dsh-opensquilla:
  classifierBundleDir: 'C:\Users\<user>\.dsh\opensquilla-router\v4.2_phase3_inference'
  classifierPython: 'C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe'
```

Do **not** run the service by hand. The plugin reads these keys and spawns +
supervises the service automatically when routing runs in `auto` (or `remote`)
mode. If the service is down, `auto` falls back to B-tier heuristic routing;
`remote` is C-tier-only.

#### 4. Smoke test

After a restart, confirm the classifier is healthy:

```powershell
Invoke-RestMethod http://127.0.0.1:8756/health
# -> {"ok":true,"available":true,"model_version":"v4"}
```

`available` must be `true`; if `false`, the bundle dir or Python runtime is
wrong (see the service's own stderr for the exact missing import).

#### Semantics reminder

- `auto` = C-tier when the service is healthy, automatic B-tier fallback when
  it is down.
- `remote` = C-tier only; requests error if the service is unavailable.

## Security

No API keys, cookies, passwords, or model weights are included in this repo.
All credentials are configured through DSH's own credential/settings UI after
install.
