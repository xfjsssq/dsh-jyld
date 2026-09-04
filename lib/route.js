// Per-turn routing: capture the step's user input at `agent/pre-step`, run
// classify → policy, and swap the serving model at `agent/request`.
//
// The split mirrors the host's own model-selection design: pre-step decides
// what the model sees (it cannot change the model), agent/request replaces
// the frozen call configuration (it cannot touch messages). Routing takes
// over only when the resolved call targets this plugin's provider AND its
// model is the virtual routing model — a user-selected concrete model is
// never hijacked.
// @module dsh-opensquilla/route
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { formatPromptHintSuffix, getPromptHint } from "./policy/controller.js";
import { runPolicy } from "./policy/engine.js";
import { HeuristicRouterStrategy } from "./classify/heuristic.js";
import { RemoteRouterStrategy } from "./classify/remote.js";
import { DEFAULT_TEXT_TIER, IMAGE_TIER, canonicalOrder, normalizeTextTier } from "./tiers.js";
/** Rough token estimate; OpenSquilla uses chars/4 for its context metadata. */
export function estimateTokens(...texts) {
    let chars = 0;
    for (const text of texts)
        if (text !== undefined)
            chars += text.length;
    return Math.ceil(chars / 4);
}
/**
 * Classify one turn through the degradation chain: remote (C-tier) when
 * reachable, heuristic (B-tier) otherwise. An explicit `remote` mode that
 * fails yields the upstream unavailable shape (default tier, confidence 0)
 * instead of silently downgrading.
 */
export async function classifyTurn(facts, options, history, signal) {
    const input = {
        message: facts.message,
        validTiers: options.validTiers,
        history: history ?? [],
        attachmentCount: facts.attachmentCount,
        signal,
    };
    if (options.classifierMode !== 'heuristic') {
        const remote = new RemoteRouterStrategy({ baseUrl: options.classifierUrl });
        try {
            return await remote.classify(input);
        }
        catch {
            if (options.classifierMode === 'remote') {
                const defaultTier = normalizeTextTier(options.policy.defaultTier ?? DEFAULT_TEXT_TIER) ?? DEFAULT_TEXT_TIER;
                return {
                    tier: defaultTier,
                    confidence: 0,
                    source: 'v4_unavailable',
                    extra: { routeClass: 'R1', top1Label: 'R1', thinkingMode: 'T1', promptPolicy: 'P1', modelVersion: 'unavailable' },
                };
            }
            // auto: fall through to the heuristic strategy.
        }
    }
    return new HeuristicRouterStrategy().classify(input);
}
/**
 * One full routing pass: classify (or image bypass) → policy engine → final
 * decision + controller heads + P0 hint. Pure over its arguments; the caller
 * owns history storage.
 */
export async function routeTurn(facts, options, history, catalogCapabilities, contextWindowTokens, now, signal) {
    const extra = {};
    let decision;
    let outcome;
    // Route to the vision tier when THIS turn carries an image. Text-only
    // follow-ups in an image-bearing conversation belong to the text ladder:
    // the swap happens at request time, where the image-history degradation
    // listener replaces earlier image blocks with a text pointer so the text
    // model never receives raw image input it cannot consume.
    if (facts.turnHasImage) {
        // Deterministic vision route ahead of any classification: the image tier
        // first; confidence 1.0; no classifier runs on image turns.
        const tier = imageRouteTier(options);
        if (options.tiers[tier]?.model) {
            decision = { tier, model: options.tiers[tier].model, confidence: 1, source: 'image_route' };
        }
        else {
            // No executable image tier: keep the decision shape but mark it, so the
            // caller can fail visibly instead of misrouting vision input to text.
            decision = { tier, model: '', confidence: 1, source: 'image_route_unavailable' };
        }
    }
    else {
        outcome = await classifyTurn(facts, options, history, signal);
        decision = {
            tier: outcome.tier,
            model: options.tiers[outcome.tier]?.model ?? '',
            confidence: outcome.confidence,
            source: outcome.source,
        };
        extra.route_class = outcome.extra.routeClass;
        extra.top1_label = outcome.extra.top1Label;
        extra.model_version = outcome.extra.modelVersion;
    }
    const result = runPolicy({
        decision,
        message: facts.message,
        config: options.policy,
        tiers: options.tiers,
        validTiers: options.validTiers,
        routingHistory: history,
        extra,
        thinkingMode: outcome?.extra.thinkingMode ?? undefined,
        promptPolicy: outcome?.extra.promptPolicy ?? undefined,
        historyStrategy: true,
        materialEstimatedTokens: estimateTokens(facts.message, ...history?.map(entry => entry.text) ?? []),
        contextWindowTokens,
        now,
        turnHasImage: facts.turnHasImage,
        tierCapabilities: catalogCapabilities,
    });
    const metadata = { ...extra, ...result.metadataUpdates };
    const hintText = options.promptHint && result.promptPolicy === 'P0' && !facts.turnHasImage
        ? getPromptHint('P0', facts.message)
        : undefined;
    return {
        decision: result.decision,
        thinkingMode: result.thinkingMode,
        promptPolicy: result.promptPolicy,
        metadata,
        hintText: hintText === undefined ? undefined : formatPromptHintSuffix(hintText),
    };
}
/** The vision route: the image tier, then any other image-capable tier up the ladder. */
function imageRouteTier(options) {
    if (options.tiers[IMAGE_TIER]?.model)
        return IMAGE_TIER;
    for (const tier of canonicalOrder(Object.keys(options.tiers))) {
        if (options.tiers[tier]?.supportsImage)
            return tier;
    }
    return IMAGE_TIER;
}
/** Definite capability facts for the policy's capability gate, from the model catalog. */
export function catalogTierCapabilities(tiers, modelFacts) {
    const capabilities = {};
    for (const [tierName, tier] of Object.entries(tiers)) {
        const facts = modelFacts.get(tier.model);
        if (facts === undefined)
            continue;
        const entry = {};
        if (facts.inputModalities !== undefined)
            entry.supportsVision = facts.inputModalities.includes('image');
        if (facts.contextWindow !== undefined)
            entry.contextWindow = facts.contextWindow;
        capabilities[tierName] = entry;
    }
    return capabilities;
}
/** Extract the turn facts routing needs from the claimed user messages. */
export function turnFactsFromMessages(messages) {
    const parts = [];
    let turnHasImage = false;
    let attachmentCount = 0;
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'text' && typeof block.text === 'string')
                parts.push(block.text);
            else if (block.type === 'image')
                turnHasImage = true;
            else if (block.type !== 'tool-result')
                attachmentCount++;
        }
    }
    return { message: parts.join('\n'), turnHasImage, attachmentCount };
}
/** Whether a session's message log already contains an image block. */
function sessionContainsImage(session) {
    if (session === undefined || typeof session.deriveMessages !== 'function')
        return false;
    try {
        return session.deriveMessages().some(message => (message.content ?? []).some(block => block.type === 'image'));
    }
    catch {
        return false;
    }
}
/** Bounded FIFO trace: routing is long-lived, the widget polls the tail. */
export class RoutingTrace {
    capacity;
    entries = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    append(entry) {
        this.entries.push(entry);
        if (this.entries.length > this.capacity)
            this.entries.shift();
    }
    view() {
        return [...this.entries];
    }
}
export const ROUTING_TRACE_CAPACITY = 64;
/**
 * Register the pre-step capture + request-override pair for the lifetime of
 * `ctx`. History is kept per agent session (bounded, in-process).
 */
export function installRouting(ctx, options, _routingModelId, historyStore, modelFacts, contextWindowTokens, logger) {
    const contextWindow = () => (typeof contextWindowTokens === 'function' ? contextWindowTokens() : contextWindowTokens);
    const lastRouting = new WeakMap();
    const traces = new Map();
    const disposePreStep = ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const currentOptions = options();
        if (!currentOptions.routingEnabled)
            return decision;
        const sessionKey = agentSessionKey(agent);
        const history = historyStore.entries(sessionKey);
        const claimedFacts = turnFactsFromMessages(messages);
        // The pre-step's `messages` cover the current turn, not prior conversation.
        // If an earlier round already attached an image, the model still receives it
        // in the full history — so the vision route must stay active even when this
        // turn's own input is text-only.
        const conversationHasImage = agent.session !== undefined
            ? sessionContainsImage(agent.session)
            : false;
        const facts = claimedFacts.conversationHasImage === undefined
            ? { ...claimedFacts, conversationHasImage }
            : claimedFacts;
        const routing = await routeTurn(facts, currentOptions, history, catalogTierCapabilities(currentOptions.tiers, modelFacts()), contextWindow(), monotonicSeconds(), signal);
        lastRouting.set(agent, { turn, step, routing });
        const finalTier = normalizeTextTier(routing.decision.tier) ?? routing.decision.tier;
        historyStore.append(sessionKey, {
            text: facts.message,
            finalTier: routing.decision.tier,
            finalRouteClass: typeof routing.metadata.final_route_class === 'string' ? routing.metadata.final_route_class : undefined,
            routeClass: typeof routing.metadata.route_class === 'string' ? routing.metadata.route_class : undefined,
            source: routing.decision.source,
        });
        logger?.info?.(`dsh-opensquilla: routed turn ${turn} step ${step} to ${finalTier} (${routing.decision.model}) via ${routing.decision.source}`);
        if (routing.hintText !== undefined) {
            return {
                kind: 'enter',
                messages: [
                    ...decision.messages,
                    createUserMessage({
                        content: [{ type: 'text', text: routing.hintText }],
                        source: { kind: 'plugin', plugin: 'dsh-opensquilla', form: 'snapshot', sections: [{ name: 'opensquilla:prompt-hint', text: routing.hintText }] },
                    }),
                ],
            };
        }
        return decision;
    });
    // prepend pins this listener to the outermost waterfall layer: its post-
    // next() swap runs after every later-registered writer (notably the host's
    // installModelSelection), so the routing decision is what leaves the host.
    const disposeRequest = ctx.on('agent/request', async ({ agent, turn, step }, next) => {
        const resolved = await next();
        // Take over every request this plugin routed (pre-step already matched
        // turn/step), as long as the call belongs to a provider routing manages.
        // The web host's installModelSelection layer pins each request to the
        // session's LAST used model (agent.session.requestHeader()), so a text-only
        // follow-up after an image turn arrives pre-pinned to the image model —
        // exactly the wrong tier. Routing is opt-in; a step it routed is re-set to
        // the routing decision whenever the host aimed it at a managed provider,
        // while calls to genuinely external providers pass through untouched.
        const current = options();
        if (!current.routingEnabled)
            return resolved;
        const state = lastRouting.get(agent);
        if (state === undefined || state.turn !== turn || state.step !== step)
            return resolved;
        if (state.routing.decision.source === 'image_route_unavailable')
            return resolved;
        const managedProviders = new Set([current.provider, ...current.routingProviders]);
        if (!managedProviders.has(resolved.provider))
            return resolved;
        const tier = current.tiers[state.routing.decision.tier];
        if (tier === undefined || tier.model === '')
            return resolved;
        const swapped = {
            provider: tier.provider,
            model: tier.model,
            // The tier's provider may not implement the effort the virtual-model
            // call carried; dropping it restores the tier model's own default.
            ...resolved.temperature === undefined ? {} : { temperature: resolved.temperature },
            ...resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens },
            ...resolved.stop === undefined ? {} : { stop: resolved.stop },
        };
        state.applied = { provider: swapped.provider, model: swapped.model };
        const sessionKey = agentSessionKey(agent);
        let sessionTrace = traces.get(sessionKey);
        if (sessionTrace === undefined) {
            sessionTrace = new RoutingTrace(ROUTING_TRACE_CAPACITY);
            traces.set(sessionKey, sessionTrace);
        }
        sessionTrace.append({
            ts: monotonicSeconds(),
            sessionKey,
            turn,
            step,
            tier: state.routing.decision.tier,
            source: state.routing.decision.source,
            routeClass: typeof state.routing.metadata.final_route_class === 'string'
                ? state.routing.metadata.final_route_class
                : typeof state.routing.metadata.route_class === 'string' ? state.routing.metadata.route_class : undefined,
            confidence: state.routing.decision.confidence,
            applied: state.applied,
        });
        if (swapped.provider !== current.provider || swapped.model !== state.routing.decision.model) {
            logger?.warn?.(`dsh-opensquilla: turn ${turn} step ${step} left as ${swapped.provider}/${swapped.model}`
                + ` while the decision was ${current.provider}/${state.routing.decision.model}`);
        }
        return {
            ...swapped,
        };
    }, { prepend: true });
    // After a turn ends, append a compact DSH-native notice row showing the
    // actual provider/model/tier that served it — the values the agent/request
    // listener really returned, never the pre-step decision restated. A turn
    // that never went through the swap writes no notice at all.
    const disposeNotice = ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
        if (!options().routingEnabled || !options().routingNotice)
            return;
        const state = lastRouting.get(agent);
        if (state === undefined || state.turn !== turn)
            return;
        const routing = state.routing;
        if (state.applied === undefined)
            return;
        const finalTier = normalizeTextTier(routing.decision.tier) ?? routing.decision.tier;
        const decisionTier = options().tiers[routing.decision.tier];
        const mismatch = state.applied.model !== routing.decision.model
            || state.applied.provider !== (decisionTier?.provider ?? options().provider);
        const summary = mismatch
            ? `路由未生效 · ${state.applied.provider}/${state.applied.model}`
            : `路由 ${finalTier} · ${state.applied.provider}/${state.applied.model}`;
        const line = `[opensquilla] ${summary}（${routing.decision.source}）`;
        try {
            agent.session.append('user/message', {
                id: MessageId(`opensquilla-routing-${agent.id}-${turn}`),
                role: 'user',
                content: [{ type: 'text', text: line }],
                source: {
                    kind: 'plugin',
                    plugin: 'dsh-opensquilla',
                    form: 'notice',
                    summary,
                },
            }, { surfaceOp: 'append' });
        }
        catch (error) {
            logger?.warn?.(`dsh-opensquilla: failed to append routing notice: ${String(error)}`);
        }
    });
    return {
        dispose() {
            disposePreStep();
            disposeRequest();
            disposeNotice();
        },
        trace: sessionKey => traces.get(sessionKey)?.view() ?? [],
    };
}
let processStart = 0;
/**
 * Monotonic seconds, shared by the routing-history clock and the policy
 * engine's window math: the anti-downgrade window only expires when both
 * sides read the SAME clock, so this must never be instantiated twice.
 */
export function monotonicSeconds() {
    if (processStart === 0)
        processStart = performance.now();
    return (performance.now() - processStart) / 1000;
}
function agentSessionKey(agent) {
    // `agent.id` is the SessionId shared with `agent.session`, and equals the
    // web sessionId the client polls with — the stable key for per-session trace.
    return String(agent.id);
}
