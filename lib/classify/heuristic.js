// Dependency-free heuristic router strategy: the B-tier classifier used when
// the ML runtime is absent.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of
// `opensquilla/engine/routing/heuristic.py` (HeuristicRouterStrategy),
// rewritten in TypeScript. Band thresholds and confidences are chosen against
// the confidence gate's cutoffs (0.5 / 0.45 above default) exactly as
// upstream documents them. See NOTICE.md.
import { DEFAULT_TEXT_TIER, TEXT_TIERS, TIER_TO_ROUTE_CLASS, normalizeTextTier } from "../tiers.js";
export const HEURISTIC_SOURCE = 'heuristic';
export const HEURISTIC_MODEL_VERSION = 'heuristic-v1';
// Band thresholds (characters of the semantic message / fenced block count).
export const HEAVY_MIN_CHARS = 12_000;
export const HEAVY_MIN_FENCED_BLOCKS = 3;
export const CODE_OR_MATERIAL_MIN_CHARS = 2_500;
export const SHORT_PLAIN_MAX_CHARS = 240;
export const MEDIUM_PLAIN_MAX_CHARS = 1_200;
// Confidence values relative to the confidence gate's default threshold of
// 0.5 (0.45 effective for tiers above the default via the 0.05 margin).
export const CONFIDENT_HIGH_TIER_CONFIDENCE = 0.6;
export const CONFIDENT_LOW_TIER_CONFIDENCE = 0.55;
export const BORDERLINE_CONFIDENCE = 0.4;
// Thinking modes consistent with the tier floors the policy engine's
// reconcile step enforces (c2 → T2, c3 → T3, default tier → T1).
const TIER_THINKING_MODE = { c0: 'T0', c1: 'T1', c2: 'T2', c3: 'T3' };
/** Deterministic surface features the bands are built from. */
export function extractFeatures(message, historyDepth, attachmentCount) {
    const fencedBlocks = Math.floor(countOccurrences(message, '```') / 2);
    return {
        charLen: message.length,
        hasCodeFence: message.includes('```'),
        codeFenceBlocks: fencedBlocks,
        attachmentCount: attachmentCount ?? 0,
        historyDepth,
    };
}
function countOccurrences(haystack, needle) {
    if (needle.length === 0)
        return 0;
    let count = 0;
    let offset = haystack.indexOf(needle);
    while (offset !== -1) {
        count++;
        offset = haystack.indexOf(needle, offset + needle.length);
    }
    return count;
}
/** Map extracted features to (band, tier, confidence). Band order = strongest signal wins. */
export function classifyFeatures(features) {
    const { charLen, hasCodeFence, codeFenceBlocks, attachmentCount } = features;
    if (charLen >= HEAVY_MIN_CHARS || codeFenceBlocks >= HEAVY_MIN_FENCED_BLOCKS) {
        return ['heavy', 'c3', CONFIDENT_HIGH_TIER_CONFIDENCE];
    }
    if (hasCodeFence || charLen >= CODE_OR_MATERIAL_MIN_CHARS || attachmentCount > 0) {
        return ['code_or_material', 'c2', CONFIDENT_HIGH_TIER_CONFIDENCE];
    }
    if (charLen <= SHORT_PLAIN_MAX_CHARS) {
        return ['short_plain', 'c0', CONFIDENT_LOW_TIER_CONFIDENCE];
    }
    if (charLen <= MEDIUM_PLAIN_MAX_CHARS) {
        return ['medium_plain', 'c1', CONFIDENT_LOW_TIER_CONFIDENCE];
    }
    // Deliberately below the gate threshold: defer to the configured
    // default_tier for ambiguous mid-length plain text.
    return ['borderline_plain', 'c1', BORDERLINE_CONFIDENCE];
}
/** Pick the closest configured tier, preferring equal-or-higher tiers. */
export function nearestValidTier(tier, validTiers) {
    if (validTiers.length === 0)
        return DEFAULT_TEXT_TIER;
    if (validTiers.includes(tier))
        return tier;
    const start = Math.max(TEXT_TIERS.indexOf(tier), 1);
    for (let i = start; i < TEXT_TIERS.length; i++) {
        const candidate = TEXT_TIERS[i];
        if (validTiers.includes(candidate))
            return candidate;
    }
    for (let i = start - 1; i >= 0; i--) {
        const candidate = TEXT_TIERS[i];
        if (validTiers.includes(candidate))
            return candidate;
    }
    return validTiers[0];
}
/**
 * Deterministic fallback classifier used when the ML runtime is absent.
 * The `error` field records the runtime load failure that triggered the
 * fallback, for operator-facing diagnostics.
 */
export class HeuristicRouterStrategy {
    error;
    source = HEURISTIC_SOURCE;
    requiresHistory = true;
    constructor(error) {
        this.error = error;
    }
    async classify(input) {
        const features = extractFeatures(input.message, input.history?.length ?? 0, input.attachmentCount);
        const [band, bandTier, confidence] = classifyFeatures(features);
        const tier = normalizeTextTier(nearestValidTier(bandTier, input.validTiers)) ?? bandTier;
        const routeClass = TIER_TO_ROUTE_CLASS[tier] ?? 'R1';
        return {
            tier,
            confidence,
            source: HEURISTIC_SOURCE,
            extra: {
                // Mirror the ML adapter's extra shape so the policy stages, routing
                // history, and telemetry consume this unchanged.
                routeClass,
                top1Label: routeClass,
                thinkingMode: TIER_THINKING_MODE[tier] ?? 'T1',
                // P1 (standard prompting) everywhere: a length heuristic is too weak
                // a signal to inject P0 compression hints into user text.
                promptPolicy: 'P1',
                modelVersion: HEURISTIC_MODEL_VERSION,
                heuristicBand: band,
                heuristicFeatures: features,
            },
        };
    }
}
