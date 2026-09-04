# NOTICE

## DSH-OpenSquilla

Copyright 2026 DSH-OpenSquilla contributors

This project is licensed under the Apache License, Version 2.0.

## Derived from OpenSquilla

This software contains substantial portions of design and logic derived from
[OpenSquilla](https://github.com/opensquilla/opensquilla)
(SquillaRouter), Copyright OpenSquilla contributors, licensed under the
Apache License, Version 2.0.

The following components are behavioral ports of OpenSquilla source, rewritten
in TypeScript for the DeepSeek Harness plugin system:

- `src/tiers.ts` — from `opensquilla/router_tiers.py` and
  `provider/presets/tokenrhythm.toml` (tier constants, TokenRhythm preset).
- `src/policy/engine.ts` — from `opensquilla/engine/routing/policy.py`
  (RoutingPolicyEngine: confidence gate, complaint upgrade, anti-downgrade,
  capability gate, bind, controller reconciliation, large-context floor,
  budget gate).
- `src/policy/data.ts` — from `opensquilla/engine/routing/policy_data.py`
  (thresholds, complaint vocabulary) and prompt-policy hint strings from
  `opensquilla/squilla_router/controller.py`.
- `src/policy/controller.ts` — from `opensquilla/squilla_router/controller.py`
  (thinking-mode / prompt-policy derivation, decision normalization).
- `src/classify/heuristic.ts` — from
  `opensquilla/engine/routing/heuristic.py` (HeuristicRouterStrategy,
  the dependency-free B-tier classifier).
- `src/classify/strategy.ts`, `src/history.ts` — from the strategy protocol
  and routing-history semantics of `opensquilla/engine/steps/squilla_router.py`.

Modifications: substantial restructuring for TypeScript and the DeepSeek
Harness; removal of OpenSquilla-specific subsystems (artifact floors,
provider-mismatch veto, on-device calibration, self-learning, correlation
telemetry headers); the TokenRhythm transport is reimplemented against the
harness's own provider-adapter conventions. The upstream wire/transport code
in `src/adapter.ts`, `src/serialize.ts`, `src/sse.ts`, `src/translate.ts`
follows the OpenAI-compatible chat-completions protocol and the harness's
`llm-deepseek` reference adapter (MIT, Copyright DeepSeek AI contributors).

## Not included

- OpenSquilla's private model weights and feature artifacts (LightGBM
  boosters, ONNX MLP head, TF-IDF/SVD pickles, BGE ONNX bundle). This plugin
  does not bundle, download, or redistribute them; users who want the full
  ML classifier must obtain them from official channels themselves and are
  responsible for complying with OpenSquilla's terms.
- OpenSquilla, TokenRhythm, and their logos are trademarks of their
  respective owners; this project uses those names only nominatively to
  describe origin and the upstream service it connects to, and claims no
  endorsement.

## Balance widget: community-derived field schema

The balance feature (`src/billing/*`, `client/index.tsx`) follows the findings
of two open-source DSH plugins:

- The TokenRhythm balance API (`/api/usage-summary`, `/api/me`, web session
  cookie `tr_session=…`) and its field schema were established by
  [dsh-tokenrhythm-bill](https://github.com/162568316/dsh-tokenrhythm-bill)
  (MIT).
- The DeepSeek official balance query
  (`https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>`,
  `balance_infos[]` parsing, key resolved via the harness `DEEPSEEK_API_KEY`
  credential seam) follows
  [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
  (MIT).
- The in-plugin TokenRhythm account login flow (`POST /api/auth/login`,
  capturing `tr_session`/`tr_csrf` from Set-Cookie; password held only in
  memory) follows
  [dsh-tokenrhythm-bill](https://github.com/162568316/dsh-tokenrhythm-bill)
  (MIT).

All are independent reimplementations; no code is copied. The shared
sidebar-footer-action slot registration uses the host's own
`dsh-client-ui-sidebar` contract.

## BGE embedding assets (full ML mode only)

The upstream classifier embeds text with `BAAI/bge-small-zh-v1.5`
(MIT License) — https://huggingface.co/BAAI/bge-small-zh-v1.5,
https://github.com/FlagOpen/FlagEmbedding. Those assets are not shipped
here.

## C-tier classifier service

`python/squilla_router_service.py` wraps the OpenSquilla V4 Phase 3 router
inference core (`runtime_src` shipped inside a user-provided bundle,
Apache-2.0) with a small HTTP surface. The request/response mapping mirrors
OpenSquilla's `V4Phase3Strategy` (Apache-2.0); the wrapper is an independent
reimplementation, not a copy. Model weights and feature artifacts are never
distributed by this plugin.
