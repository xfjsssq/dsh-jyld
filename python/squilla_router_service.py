#!/usr/bin/env python3
"""DSH-OpenSquilla C-tier classification service.

A thin HTTP wrapper around the OpenSquilla V4 Phase 3 router inference core
(runtime_src + model weights). The service speaks the contract consumed by the
plugin's TS side (src/classify/remote.ts):

    POST /classify  {"message", "valid_tiers", "history":[{text, ...}]}
        -> {"tier","confidence","route_class","thinking_mode","prompt_policy",
            "model_version","probabilities","difficulty","margin","flags"}
    GET  /health    -> {"ok","model_version","available"}

Weights and runtime_src live in a *bundle directory*; this service never
ships them. Dev/testing can point --bundle-dir at a locally installed
OpenSquilla copy; real users download a bundle from official channels.

The request/response mapping mirrors OpenSquilla's V4Phase3Strategy
(Apache-2.0); this file is an independent reimplementation over the runtime_src
inference core. See NOTICE.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any

DEFAULT_TIER = "c1"
ROUTE_CLASS_TO_TIER = {"R0": "c0", "R1": "c1", "R2": "c2", "R3": "c3"}
TIER_ORDER = ["c0", "c1", "c2", "c3"]


def find_valid_tier(start_tier: str, valid_tiers: list[str]) -> str:
    if not valid_tiers:
        return DEFAULT_TIER
    start_idx = TIER_ORDER.index(start_tier) if start_tier in TIER_ORDER else 1
    for idx in range(start_idx, len(TIER_ORDER)):
        if TIER_ORDER[idx] in valid_tiers:
            return TIER_ORDER[idx]
    for tier in TIER_ORDER:
        if tier in valid_tiers:
            return tier
    return valid_tiers[0]


class ClassifierRuntime:
    """Owns the inference core and the request/response mapping."""

    def __init__(self, bundle_dir: str) -> None:
        self.bundle_dir = Path(bundle_dir)
        self.model_version = "unknown"
        self.available = False
        self._core: Any | None = None
        self._request_type: Any | None = None
        self._config: dict[str, Any] = {}
        self._error: str | None = None
        try:
            self._init()
        except Exception as exc:  # noqa: BLE001 -- surface any init failure
            self._error = str(exc)

    def _init(self) -> None:
        import yaml

        runtime_src = self.bundle_dir / "runtime_src"
        if not runtime_src.is_dir():
            raise FileNotFoundError(f"missing runtime_src in {self.bundle_dir}")
        self._config = (
            yaml.safe_load((self.bundle_dir / "router.runtime.yaml").read_text(encoding="utf-8"))
            or {}
        )
        version_file = self.bundle_dir / "version.json"
        if version_file.exists():
            self.model_version = str(json.loads(version_file.read_text(encoding="utf-8")).get("version", "unknown"))

        sys.path.insert(0, str(runtime_src))
        from src.router.inference.core import InferenceCore  # type: ignore[import-not-found]
        from src.router.inference.types import InferenceRequest  # type: ignore[import-not-found]

        use_aux_head = bool(self._config.get("v4", {}).get("aux_head_inference", False))
        self._request_type = InferenceRequest
        self._core = InferenceCore.from_model_dir(
            self.bundle_dir,
            self._config,
            use_aux_head=use_aux_head,
        )
        self.available = True

    def _build_request(
        self,
        message: str,
        history: list[dict],
        *,
        prev_assistant_text: str | None = None,
        prev_assistant_usage: dict | None = None,
        flags_text_override: str | None = None,
    ) -> Any:
        history_texts = [str(entry.get("text", "")) for entry in history if entry.get("text")]
        context_tokens_est = max(
            0,
            (len(message) + sum(len(t) for t in history_texts) + len(prev_assistant_text or "")) // 4,
        )
        decisions: list[Any] = []
        for entry in history:
            route_class = entry.get("final_route_class") or entry.get("route_class")
            if route_class:
                decisions.append(
                    SimpleNamespace(
                        route_class=str(route_class),
                        difficulty=float(entry.get("difficulty_score", entry.get("difficulty", 0.0)) or 0.0),
                        margin=float(entry.get("margin", 0.0) or 0.0),
                    )
                )
        return self._request_type(
            current_user_text=message,
            history_user_texts=history_texts,
            prev_assistant_text=prev_assistant_text,
            prev_assistant_usage=prev_assistant_usage,
            prev_route_decisions=decisions,
            flags_text_override=flags_text_override,
            context_metadata={
                "turn_index": len(history),
                "history_user_turn_count": len(history_texts),
                "context_tokens_est": context_tokens_est,
                "has_code_block": "```" in message,
                "has_prev_assistant": bool(prev_assistant_text),
            },
        )

    def classify(
        self,
        message: str,
        valid_tiers: list[str],
        history: list[dict] | None = None,
        prev_assistant_text: str | None = None,
        prev_assistant_usage: dict | None = None,
        flags_text_override: str | None = None,
    ) -> dict[str, Any]:
        if not self.available or self._core is None or self._request_type is None:
            return self._unavailable(valid_tiers)
        request = self._build_request(
            message,
            history or [],
            prev_assistant_text=prev_assistant_text,
            prev_assistant_usage=prev_assistant_usage,
            flags_text_override=flags_text_override,
        )
        result = self._core.predict(request)
        return self._map_result(result, valid_tiers, message)

    def _unavailable(self, valid_tiers: list[str]) -> dict[str, Any]:
        tier = find_valid_tier(DEFAULT_TIER, valid_tiers)
        route_class = next((k for k, v in ROUTE_CLASS_TO_TIER.items() if v == tier), "R1")
        return {
            "tier": tier,
            "confidence": 0.0,
            "route_class": route_class,
            "thinking_mode": "T1",
            "prompt_policy": "P1",
            "model_version": self.model_version,
            "error": self._error or "runtime unavailable",
        }

    def _map_result(self, result: Any, valid_tiers: list[str], message: str) -> dict[str, Any]:
        decision = result.decision
        route_class = str(getattr(decision, "route_class", "R1"))
        tier = ROUTE_CLASS_TO_TIER.get(route_class, DEFAULT_TIER)
        if tier not in valid_tiers:
            tier = find_valid_tier(tier, valid_tiers)
        probabilities = dict(getattr(result, "probabilities", {}) or {})
        confidence = float(probabilities.get(route_class, 0.0))
        thinking_mode = getattr(decision, "thinking_mode", None) or "T0"
        prompt_policy = getattr(decision, "prompt_policy", None) or "P0"
        difficulty = float(getattr(decision, "difficulty_score", 0.0))
        return {
            "tier": tier,
            "confidence": confidence,
            "route_class": route_class,
            "thinking_mode": str(thinking_mode),
            "prompt_policy": str(prompt_policy),
            "model_version": self.model_version,
            "probabilities": probabilities,
            "difficulty": difficulty,
            "difficulty_score": difficulty,
            "margin": float(getattr(decision, "margin", 0.0)),
            "flags": dict(getattr(decision, "flags", {}) or {}),
            "aux_decision_probs": getattr(result, "aux_decision_probs", None),
        }


def make_handler(runtime: ClassifierRuntime) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_: Any) -> None:
            pass

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/health":
                self._json(200, {"ok": True, "available": runtime.available, "model_version": runtime.model_version})
                return
            self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/classify":
                self._json(404, {"ok": False, "error": "not found"})
                return
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "malformed JSON"})
                return
            message = str(body.get("message", ""))
            valid_tiers = [str(t) for t in (body.get("valid_tiers") or [])]
            history = [dict(h) for h in (body.get("history") or [])]
            prev_assistant_text = body.get("prev_assistant_text")
            prev_assistant_usage = body.get("prev_assistant_usage")
            flags_text_override = body.get("flags_text_override")
            try:
                result = runtime.classify(
                    message,
                    valid_tiers,
                    history=history,
                    prev_assistant_text=prev_assistant_text,
                    prev_assistant_usage=prev_assistant_usage,
                    flags_text_override=flags_text_override,
                )
                self._json(200, {"ok": True, **result})
            except Exception as exc:  # noqa: BLE001 -- per-turn failure must not kill the service
                self._json(200, {"ok": False, "error": str(exc), "tier": find_valid_tier(DEFAULT_TIER, valid_tiers), "confidence": 0.0})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="DSH-OpenSquilla C-tier classifier service")
    parser.add_argument("--bundle-dir", required=True, help="path to the v4.2_phase3_inference bundle (weights + runtime_src)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8756)
    args = parser.parse_args()

    runtime = ClassifierRuntime(args.bundle_dir)
    print(f"classifier: available={runtime.available} model_version={runtime.model_version} error={runtime._error}", flush=True)
    if not runtime.available:
        print(f"classifier: FATAL {runtime._error}", file=sys.stderr, flush=True)
        sys.exit(1)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    print(f"classifier: listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
