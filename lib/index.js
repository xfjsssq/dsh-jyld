// DSH-OpenSquilla plugin entry.
//
// Registers a TokenRhythm provider adapter on `ctx.llm` (OpenAI-compatible,
// modeled on the harness's own provider adapters) plus the OpenSquilla-derived
// per-turn routing: pre-step classification feeding an agent/request model
// swap, a heuristic B-tier with a remote C-tier slot, and an asynchronous
// readiness assembler. Connection facts and routing facts re-resolve per
// operation, so settings changes reach the next step without a restart.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors. See NOTICE.md.
// @module dsh-opensquilla
import { assertUsableApiKey, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_REQUEST_IMAGE_BYTES, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, TokenRhythmAdapter } from "./adapter.js";
import { Config, DEFAULT_MODELS, PUBLIC_BASE_URL, resolveTiers, validTextTiers } from "./config.js";
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileBillingStateStore } from "./billing/store.js";
import { registerBillingRoutes } from "./billing/routes.js";
import { ReadinessAssembler } from "./assembler.js";
import { installGuidance } from "./guidance.js";
import { RoutingHistoryStore } from "./history.js";
import { installRouting, monotonicSeconds } from "./route.js";
import { installHistoryImageDegradation } from "./image-degrade.js";
import { registerRoutingRoutes } from "./routing/routes.js";
export { Config };
export { DEFAULT_MODELS, PUBLIC_BASE_URL, resolveTiers, validTextTiers } from "./config.js";
export { TokenRhythmAdapter } from "./adapter.js";
export { routeTurn, classifyTurn, catalogTierCapabilities, turnFactsFromMessages, estimateTokens } from "./route.js";
export { runPolicy, largeContextMinTier, resolveLargeContextFloorTier, previousFinalEntry, previousFinalTier, detectComplaint } from "./policy/engine.js";
export { HeuristicRouterStrategy } from "./classify/heuristic.js";
export { RemoteRouterStrategy } from "./classify/remote.js";
export { RoutingHistoryStore, MAX_ROUTING_HISTORY, ROUTING_HISTORY_WINDOW_SECONDS } from "./history.js";
export { ReadinessAssembler } from "./assembler.js";
export { normalizeTextTier, tierIndex, canonicalOrder, TEXT_TIERS, IMAGE_TIER, DEFAULT_TEXT_TIER, HIGHEST_TEXT_TIER, TOKENRHYTHM_TIERS } from "./tiers.js";
export const name = 'dsh-opensquilla';
export const inject = ['llm'];
const NS = settingsNamespace('dsh-opensquilla');
/** The single provider route this plugin owns and routes within. */
const PROVIDER = 'tokenrhythm';
/** Virtual model id advertised in the catalog; selecting it opts the call
 * into per-turn routing, and the agent/request listener swaps it for the
 * chosen tier's concrete provider+model. */
export const ROUTING_MODEL_ID = 'auto';
const BASE_URL_ENV = 'TOKENRHYTHM_BASE_URL';
export function classifierPortOf(url) {
    try {
        const parsed = new URL(url);
        const port = Number(parsed.port);
        return Number.isInteger(port) && port > 0 ? port : 8756;
    }
    catch {
        return 8756;
    }
}
function resolveCatalog(models) {
    const seen = new Set();
    return (models ?? DEFAULT_MODELS).map((model) => {
        if (model.id.length === 0)
            throw new Error('dsh-opensquilla: catalog model ids must be non-empty');
        if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
            throw new Error(`dsh-opensquilla: catalog model "${model.id}" contextWindow must be a positive integer`);
        }
        if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
            throw new Error(`dsh-opensquilla: catalog model "${model.id}" maxTokens must be a positive integer`);
        }
        const inputModalities = model.inputModalities ?? ['text'];
        if (seen.has(model.id))
            throw new Error(`dsh-opensquilla: duplicate catalog model "${model.id}"`);
        seen.add(model.id);
        return {
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.description === undefined ? {} : { description: model.description },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            inputModalities: [...inputModalities],
        };
    });
}
/**
 * The one explicit resolve step from raw config to validated plugin facts.
 * Called for the composition entry at load (fail loud) and for each settings
 * snapshot at its first use (keep the last good facts on failure).
 */
export function resolveAdapterOptions(config, environment) {
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`dsh-opensquilla: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
    if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
        throw new Error('dsh-opensquilla: maxRequestImageBytes must be a positive safe integer');
    }
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const models = resolveCatalog(config.models !== undefined && config.models.length > 0 ? config.models : undefined);
    const tiers = resolveTiers(config.tiers);
    // A tier pointed at the virtual routing model itself would loop: routing
    // selects the tier, the swap re-enters routing. Clear it, which drops the
    // tier from validTiers and the image route (invalid configs never loop).
    for (const tier of Object.values(tiers)) {
        if (tier.model === ROUTING_MODEL_ID)
            tier.model = '';
    }
    const routing = config.routing ?? {};
    const routingEnabled = routing.routingEnabled ?? true;
    const budget = config.budget ?? {};
    const validTiers = validTextTiers(tiers);
    const routingOptions = {
        provider: PROVIDER,
        routingModelId: ROUTING_MODEL_ID,
        routingProviders: (routing.providers !== undefined && routing.providers.length > 0)
            ? [...new Set([...routing.providers, PROVIDER])]
            : [PROVIDER],
        tiers,
        validTiers,
        classifierMode: routing.classifierMode ?? 'auto',
        classifierUrl: routing.classifierUrl ?? 'http://127.0.0.1:8756',
        routingNotice: routing.routingNotice ?? true,
        promptHint: routing.promptHint ?? true,
        policy: {
            confidenceThreshold: routing.confidenceThreshold ?? 0.5,
            defaultTier: routing.defaultTier ?? 'c0',
            complaintUpgradeEnabled: routing.complaintUpgradeEnabled ?? true,
            antiDowngradeEnabled: routing.antiDowngradeEnabled ?? false,
        },
    };
    return {
        connection: {
            baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL,
            apiKeyEnv: credentialRef(config.apiKeyEnv ?? 'TOKENRHYTHM_API_KEY'),
            defaults: {
                thinking: config.thinking,
                reasoningEffort: config.reasoningEffort,
            },
            maxTokens,
            defaultContextWindow,
            models,
            streamIdleTimeoutMs,
            maxRequestImageBytes,
            retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-opensquilla: retryPolicy'),
        },
        routing: routingOptions,
        routingEnabled,
        budget: {
            enabled: budget.enabled ?? false,
            action: budget.action ?? 'warn',
            limitUsd: budget.limitUsd ?? 0,
            capTier: budget.capTier,
        },
        billingEnabled: config.billing?.enabled ?? true,
        classifierBundleDir: config.classifierBundleDir,
        classifierPython: config.classifierPython,
    };
}
export function apply(ctx, config) {
    let current = () => config;
    let lastRaw;
    let lastGood;
    const options = () => {
        const raw = current();
        if (raw === lastRaw && lastGood !== undefined)
            return lastGood;
        try {
            const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
            lastRaw = raw;
            lastGood = next;
            return next;
        }
        catch (error) {
            // Only a live settings snapshot failing a beyond-schema bound reaches
            // this branch after load: keep serving the last good facts, say so once.
            if (lastGood === undefined)
                throw error;
            lastRaw = raw;
            ctx.logger.error('dsh-opensquilla: keeping the last good configuration after an invalid settings section');
            ctx.logger.error(error);
            return lastGood;
        }
    };
    options();
    const resolveApiKey = async (connection) => {
        const ref = connection.apiKeyEnv;
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'dsh-opensquilla', ref);
        }
        else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'dsh-opensquilla', ref);
            }
        }
        throw new LlmError(`dsh-opensquilla: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
            + ' service (the web Models page writes it), or export it in the launching environment', 'MISSING_CREDENTIAL');
    };
    let userId;
    const resolveUserId = () => userId ??= getOrCreateAnonymousUserId();
    const adapter = new TokenRhythmAdapter({
        options: () => options().connection,
        routingModelId: ROUTING_MODEL_ID,
        resolveApiKey,
        resolveUserId,
        resolveAttachments: () => ctx.get('attachments'),
    });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: '智能路由 (OpenSquilla)', settingsNs: NS, settingsPath: [] },
    ]);
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    let registeredPolicy = options().connection.retryPolicy;
    const ensureRegistrationFacts = () => {
        const policy = options().connection.retryPolicy;
        if (deepEqualJson(policy, registeredPolicy))
            return;
        // The registry captures the retry policy at registration; `replace`
        // re-reads it in one synchronous registry section.
        registration.replace([PROVIDER]);
        registeredPolicy = policy;
    };
    // Router status feeds the guidance prompt section; M1 always serves the
    // heuristic tier (auto mode falls back to it, remote mode without a
    // service is the degraded case).
    const statusRef = {
        current: { state: 'heuristic' },
    };
    const refreshStatus = () => {
        const resolved = options();
        if (!resolved.routingEnabled) {
            statusRef.current = { state: 'heuristic', detail: 'Routing is disabled; model selection is manual.' };
            return;
        }
        statusRef.current = resolved.routing.classifierMode === 'remote'
            ? { state: 'unavailable', detail: 'The configured classifier service is not reachable; turns use the default tier.' }
            : { state: 'heuristic' };
    };
    refreshStatus();
    // One shared monotonic clock feeds both the history timestamps and the
    // policy window math — two clocks would make the anti-downgrade window
    // never (or always) expire.
    const historyStore = new RoutingHistoryStore({ now: monotonicSeconds });
    const modelFacts = () => {
        const facts = new Map();
        for (const model of options().connection.models) {
            facts.set(model.id, { inputModalities: model.inputModalities, contextWindow: model.contextWindow });
        }
        return facts;
    };
    let routingTraceFn = () => [];
    if (options().routingEnabled) {
        const installed = installRouting(ctx, () => options().routing, ROUTING_MODEL_ID, historyStore, modelFacts, options().connection.defaultContextWindow, { info: message => ctx.logger.info(message), warn: message => ctx.logger.warn(message) });
        routingTraceFn = sessionId => sessionId === undefined ? [] : installed.trace(sessionId);
    }
    installGuidance(ctx, () => statusRef.current);
    // Host-wide safety net: a text-only follow-up in an image-bearing
    // conversation routes back to the text ladder, but its provider (e.g.
    // `jyld2` via llm-pi-ai) rejects raw image blocks. This listener replaces
    // HISTORY image blocks with a text pointer for every provider except this
    // plugin's own adapter (which degrades internally). The plugin's tokenrhythm
    // route bypasses the listener entirely (SELF_DEGRADING_PROVIDERS).
    // ctx.on listeners are auto-disposed with this plugin's scope.
    void installHistoryImageDegradation(ctx);
    // The settings section is installed below, before the first reconciliation.
    // This is deliberate: classifierBundleDir commonly lives in settings.yaml;
    // starting the assembler before that layer is attached silently disables C.
    let assembler;
    let assemblerConfigKey = '';
    const reconcileAssembler = () => {
        const resolved = options();
        const configKey = JSON.stringify({
            bundle: resolved.classifierBundleDir,
            python: resolved.classifierPython,
            url: resolved.routing.classifierUrl,
        });
        if (configKey === assemblerConfigKey)
            return;
        assemblerConfigKey = configKey;
        assembler?.dispose();
        assembler = undefined;
        if (resolved.classifierBundleDir === undefined)
            return;
        assembler = new ReadinessAssembler({
            // Stable location under the harness home: one venv across runs, and the
            // assembler skips rebuilds when it already exists.
            envDir: process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
                ? undefined
                : join(process.env.DSH_HOME, 'opensquilla-router', 'venv'),
            classifier: {
                entry: fileURLToPath(new URL('../python/squilla_router_service.py', import.meta.url)),
                bundleDir: resolved.classifierBundleDir,
                url: resolved.routing.classifierUrl,
                port: classifierPortOf(resolved.routing.classifierUrl),
                ...(resolved.classifierPython === undefined ? {} : { python: resolved.classifierPython }),
            },
        });
        assembler.start();
    };
    // Stop the current child process when the plugin unloads.
    ctx.effect(() => () => assembler?.dispose());
    // Sidebar balance widget: host routes mount only when a web host is
    // present (web profiles), leaving headless/CLI profiles untouched.
    if (options().billingEnabled) {
        const stateDir = (process.env.DSH_HOME === undefined || process.env.DSH_HOME === '')
            ? join(homedir(), '.dsh', 'dsh-opensquilla')
            : join(process.env.DSH_HOME, 'dsh-opensquilla');
        const billingStore = new FileBillingStateStore(join(stateDir, 'billing.json'));
        // DeepSeek official balance reuses the host's own credential seam; the
        // same key that powers the llm-deepseek adapter is read here.
        const resolveDeepSeekKey = async () => {
            const credentials = ctx.get('credentials');
            if (credentials !== undefined) {
                const hit = await credentials.resolve(credentialRef('DEEPSEEK_API_KEY'));
                if (hit !== undefined)
                    return assertUsableApiKey(hit.value, 'dsh-opensquilla', 'DEEPSEEK_API_KEY');
            }
            const ambient = launchEnvironmentOf(ctx).get('DEEPSEEK_API_KEY');
            if (ambient !== undefined && ambient.value.length > 0)
                return ambient.value;
            return undefined;
        };
        ctx.inject(['webServer'], (webCtx) => {
            const webServer = webCtx.webServer;
            if (webServer === undefined)
                return;
            return registerBillingRoutes(webServer, { store: billingStore, resolveDeepSeekKey });
        });
    }
    // Routing views for the web half: pool snapshot + live trace. Mounted for
    // every web host regardless of routingEnabled so the settings page can
    // re-enable routing through its own endpoint.
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer;
        if (webServer === undefined)
            return;
        return registerRoutingRoutes(webServer, {
            options: () => options().routing,
            routingEnabled: () => options().routingEnabled,
            trace: sessionId => routingTraceFn(sessionId),
        });
    });
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => {
            current = source;
            // The initial settings snapshot is installed through this callback.
            // Reconcile here so classifierBundleDir from settings.yaml is honored
            // before the first request, not only after a later settings edit.
            reconcileAssembler();
        },
        onChange: () => {
            ensureRegistrationFacts();
            refreshStatus();
            reconcileAssembler();
        },
    });
    // Programmatic/test composition may not expose a settings provider; still
    // start from the static entry when one was supplied.
    reconcileAssembler();
}
export const ConfigSchema = Config;
