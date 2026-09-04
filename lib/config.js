// Plugin config: the schemastery schema doubles as the settings-section
// shape. Every field is optional in yml; resolution happens per request for
// connection facts and per step for routing facts.
// @module dsh-opensquilla/config
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { TOKENRHYTHM_TIERS } from "./tiers.js";
/** Public TokenRhythm endpoint. */
export const PUBLIC_BASE_URL = 'https://tokenrhythm.studio/v1';
export const DEFAULT_API_KEY_ENV = 'TOKENRHYTHM_API_KEY';
const catalogModel = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    inputModalities: z.array(z.union(['text', 'image'])).min(1).default(['text']),
});
const tierOverride = z.object({
    model: z.string(),
    provider: z.string(),
    description: z.string(),
    supportsImage: z.boolean(),
    imageOnly: z.boolean(),
});
export const Config = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string(),
    thinking: z.union(['enabled', 'disabled']),
    reasoningEffort: z.union(['off', 'low', 'high', 'max']),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    defaultContextWindow: z.number().step(1).min(1),
    models: z.array(catalogModel),
    streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
    maxRequestImageBytes: z.number().step(1).min(1),
    retryPolicy: RetryPolicySchema,
    tiers: z.dict(tierOverride),
    routing: z.object({
        routingEnabled: z.boolean(),
        classifierMode: z.union(['auto', 'heuristic', 'remote']),
        classifierUrl: z.string(),
        providers: z.array(z.string()),
        routingNotice: z.boolean(),
        promptHint: z.boolean(),
        confidenceThreshold: z.number().min(0).max(1),
        defaultTier: z.string(),
        complaintUpgradeEnabled: z.boolean(),
        antiDowngradeEnabled: z.boolean(),
    }),
    budget: z.object({
        enabled: z.boolean(),
        action: z.union(['warn', 'cap']),
        limitUsd: z.number(),
        capTier: z.string(),
    }),
    billing: z.object({
        enabled: z.boolean(),
    }),
    classifierBundleDir: z.string(),
    classifierPython: z.string(),
});
/** Default catalog: the five preset tier models. Context windows mirror the
 * live public catalog at tokenrhythm.studio/api/models (2026-09-02). */
export const DEFAULT_MODELS = [
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash (c0)', contextWindow: 1_000_000 },
    { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro (c1)', contextWindow: 1_000_000 },
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (c2)', contextWindow: 256_000 },
    { id: 'glm-5.2', name: 'GLM 5.2 (c3)', contextWindow: 1_000_000 },
    {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6 (image)',
        contextWindow: 256_000,
        inputModalities: ['text', 'image'],
    },
];
/** Merge config tier overrides over the shipped preset. */
export function resolveTiers(overrides) {
    const merged = {};
    for (const [name, tier] of Object.entries(TOKENRHYTHM_TIERS)) {
        merged[name] = { ...tier };
    }
    for (const [name, override] of Object.entries(overrides ?? {})) {
        const base = merged[name] ?? { provider: override.provider ?? '', model: '', supportsImage: false, imageOnly: false };
        merged[name] = {
            provider: override.provider ?? base.provider,
            model: override.model ?? base.model,
            supportsImage: override.supportsImage ?? base.supportsImage,
            imageOnly: override.imageOnly ?? base.imageOnly,
        };
        const description = override.description ?? base.description;
        if (description !== undefined)
            merged[name].description = description;
    }
    return merged;
}
/** Text tiers that can actually execute (non-image-only, with a model). */
export function validTextTiers(tiers) {
    return Object.keys(tiers).filter(name => !tiers[name].imageOnly && tiers[name].model.length > 0);
}
