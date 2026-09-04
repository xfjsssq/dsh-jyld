# DSH-JYLD

`dsh-opensquilla` is a DeepSeek Harness plugin that routes each request to an appropriate model tier, keeps image conversations usable across text follow-ups, and shows TokenRhythm and DeepSeek account balances in the web sidebar.

## Features

- Automatic c0-c3 routing with heuristic classification and optional local ML classification.
- Image-aware routing to the configured vision tier.
- Safe degradation of earlier image blocks when a text-only model receives conversation history.
- TokenRhythm OpenAI-compatible provider adapter.
- Web sidebar balance panel for TokenRhythm and official DeepSeek balance.
- Routing settings, live routing trace, and model selection entry for Smart Routing.
- No API keys, cookies, passwords, model weights, or local virtual environments are included.

## Install

In a DSH installation with the `dsh` command available:

```powershell
dsh plugin --profile web add github:xfjsssq/dsh-jyld
```

Restart the DSH web profile after installation. Select **智能路由** in the model picker to enable automatic routing. Existing users can keep a specific model selected and use the plugin's balance panel independently.

The repository is intentionally installable directly from GitHub. The committed `lib/` directory is the runtime build, the client bundle is already included, and all runtime dependencies (including the `@deepseek-ai/*` host packages from npm) are installed automatically by the `dsh plugin add` command.

**Installing as an AI agent?** Read [AGENTS.md](./AGENTS.md) first — it contains the exact install steps, a four-point verification checklist, and a troubleshooting map.

## Configure credentials

Add provider credentials through DSH's normal credential/settings UI. Never put secrets in `settings.yaml`, a repository, an issue, or a screenshot.

- `TOKENRHYTHM_API_KEY`: used by the TokenRhythm model adapter.
- `DEEPSEEK_API_KEY`: used by the official DeepSeek balance panel and any DeepSeek route configured by the user.

The sidebar's TokenRhythm balance uses a web session. Open the `¥` panel and either sign in there or use the advanced **paste session Cookie** option after signing in to the official site. The password is held only for the login request; only a masked session status is sent to the browser.

## Optional ML classifier

The plugin works without Python or model files. For the optional ML classifier, obtain the compatible OpenSquilla inference bundle from its official source and configure its directory and Python interpreter in the `dsh-opensquilla` settings section. The plugin does not redistribute private weights or feature artifacts. If the service is unavailable, routing falls back to the built-in heuristic classifier.

## Configuration

The `dsh-opensquilla` settings section supports routing enablement, classifier mode, tier assignments, routing pool providers, classifier URL, and balance enablement. The web UI exposes the supported settings and writes them through the DSH settings service.

## Development

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm typecheck:client
pnpm run build
pnpm run build:client
```

`pnpm install` is for contributors only. End users should install the GitHub repository with `dsh plugin add`.

## Security and privacy

- Credentials are resolved through the DSH credential seam.
- TokenRhythm session state is stored on the host, not sent to the client bundle.
- The client receives masked session hints only.
- Do not commit `.env`, credential files, `billing.json`, local DSH homes, or generated secrets.

## License and attribution

Apache-2.0. See [NOTICE.md](./NOTICE.md) for OpenSquilla-derived logic, protocol references, and attribution details.
