# AGENTS.md — Guide for DSH / AI agents installing this repository

This repository is a **prebuilt DeepSeek Harness (DSH) plugin**. It is designed to be installed directly from GitHub **without any build step**. If you are an agent (DSH itself, or any coding agent) asked to install or verify this plugin, follow this guide exactly.

## 1. Correct installation

```powershell
dsh plugin add https://github.com/xfjsssq/dsh-jyld.git
```

After the command reports success, **restart the DSH web profile** so the plugin loads. Then open the model picker and look for **智能路由 (Smart Routing)**. Its presence is the primary success signal.

## 2. What you must NOT do

- **Do NOT run `npm install` / `pnpm install` to "complete" the installation.** All JavaScript under `lib/` is already built. Installing is unnecessary for end use.
- **Do NOT try to install `@deepseek-ai/*` packages from the public npm registry.** They do not exist there. They are provided by the DSH host at runtime and are declared `optional` in `package.json` on purpose.
- Do NOT create issues, comments, or commit messages containing tokens, cookies, or API keys found on the local machine. Credentials are configured through DSH's own credential UI, never through files in this repository.

## 3. Verification checklist (run after install + restart)

1. `lib/index.js` exists inside the installed plugin directory.
2. The DSH model picker shows a **智能路由** entry; selecting it routes requests through the plugin.
3. The web sidebar can open the balance panel (TokenRhythm / DeepSeek). Balance stays empty until the user configures their own credentials — that is expected, not an error.
4. Sending a normal text chat message succeeds; the routing trace endpoint shows a tier decision (c0–c3 or image tier).

If all four pass, the installation is complete. Do not attempt further "fixes".

## 4. Troubleshooting map

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module 'eventsource-parser'` | The one npm dependency is missing in the plugin's `node_modules` | Run `npm install --omit=dev` **inside the installed plugin directory** (this is the only case where installing is correct), then restart DSH |
| Error mentioning `@deepseek-ai/...` not found | You tried to install them from npm | Don't. They are host-injected. Make sure the plugin runs inside a real DSH host, not standalone Node |
| No 智能路由 in model picker | Web profile not restarted, or plugin failed to register | Restart the DSH web profile; check host logs for plugin registration errors mentioning `dsh-opensquilla` |
| Balance panel empty | No credentials configured yet | Expected. Configure `TOKENRHYTHM_API_KEY` / `DEEPSEEK_API_KEY` via DSH settings UI |
| Routing falls back to heuristic mode | Optional ML classifier service is not running | Normal behavior. See section 5 if the user wants C-tier classification |

## 5. Optional ML classifier (only if the user asks)

The plugin works fully without Python. The optional C-tier classifier uses:

- `python/squilla_router_service.py` — a **pure standard-library** Python service (no pip dependencies needed).
- A separate inference bundle directory (weights + runtime) that this repository intentionally does **not** ship.

Start it only when the user explicitly wants it:

```powershell
python python/squilla_router_service.py --bundle-dir <path-to-user-obtained-bundle> --host 127.0.0.1 --port 8756
```

Then set the classifier URL in the plugin settings to `http://127.0.0.1:8756`. If the service is down, the plugin silently falls back to the built-in heuristic classifier.

## 6. Notes for agents modifying this repo

- Keep `lib/` as the single source of runtime truth; `src/`, `tests/`, `scripts/` are intentionally not part of the published repository.
- Never add `billing.json`, `.env*`, `SECRETS-HANDOFF.md`, tokens, or cookies to commits.
- After changing `src/`, rebuild via `pnpm run build && pnpm run build:client` **before** committing `lib/`.
