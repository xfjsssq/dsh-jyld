// Remote (C-tier) strategy: talk to the local Python classification service.
//
// The service contract matches OpenSquilla's V4 Phase 3 classifier surface:
// POST /classify with the turn text + history, answering tier / confidence /
// thinking mode / prompt policy. The M2 milestone ships the service itself;
// until then (or whenever the service is down) `classify` rejects and the
// caller degrades to the heuristic strategy.
import { ROUTE_CLASS_TO_TIER } from "../tiers.js";
export const REMOTE_SOURCE = 'v4_phase3';
/**
 * C-tier client. `ready()` probes the service once; `classify` throws on any
 * transport/protocol failure so the strategy chain can fall through.
 */
export class RemoteRouterStrategy {
    options;
    source = REMOTE_SOURCE;
    requiresHistory = true;
    probed;
    constructor(options) {
        this.options = options;
    }
    /** One-shot health probe; undefined means never probed, false = known down. */
    get ready() {
        return this.probed;
    }
    async probe(signal) {
        try {
            const response = await fetch(`${this.options.baseUrl}/health`, this.timeoutSignal(signal));
            this.probed = response.ok;
        }
        catch {
            this.probed = false;
        }
        return this.probed ?? false;
    }
    timeoutSignal(outer) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('remote classify timeout'), this.options.timeoutMs ?? 1_500);
        if (outer !== undefined) {
            if (outer.aborted)
                controller.abort(outer.reason);
            else
                outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
        }
        // Timer never outlives the request lifecycle meaningfully; unref keeps process exit clean.
        timeout.unref?.();
        return { signal: controller.signal };
    }
    async classify(input) {
        const body = {
            message: input.message,
            valid_tiers: input.validTiers,
            history: input.history?.map(entry => ({ text: entry.text ?? '' })) ?? [],
        };
        const response = await fetch(`${this.options.baseUrl}/classify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            ...this.timeoutSignal(input.signal),
        });
        if (!response.ok) {
            throw new Error(`remote classifier HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (payload.tier === undefined)
            throw new Error('remote classifier returned no tier');
        this.probed = true;
        const routeClass = payload.route_class;
        const extra = {
            thinkingMode: payload.thinking_mode ?? 'T0',
            promptPolicy: payload.prompt_policy ?? 'P0',
        };
        if (routeClass !== undefined) {
            extra.routeClass = routeClass;
            extra.top1Label = routeClass;
        }
        if (payload.model_version !== undefined)
            extra.modelVersion = payload.model_version;
        if (payload.probabilities !== undefined)
            extra.probabilities = payload.probabilities;
        if (payload.flags !== undefined)
            extra.flags = payload.flags;
        return {
            tier: payload.tier,
            confidence: payload.confidence ?? 0,
            source: REMOTE_SOURCE,
            extra,
        };
    }
}
/** Map an R0–R3 route class to its canonical tier when the service speaks classes. */
export function tierFromRouteClass(routeClass) {
    if (routeClass === undefined)
        return undefined;
    return ROUTE_CLASS_TO_TIER[routeClass];
}
