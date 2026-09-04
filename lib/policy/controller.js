// Post-processing controllers: derive thinking mode and prompt policy.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of
// `opensquilla/squilla_router/controller.py`, rewritten for DSH-OpenSquilla.
// Pure functions, no I/O, no model runtime. See NOTICE.md.
import { TEXT_TIERS } from "../tiers.js";
import { PROMPT_HINT_EN, PROMPT_HINT_ZH } from "./data.js";
const TIER_ORDER = TEXT_TIERS;
const SYNTHETIC_PEAK = 0.85;
const DIFFICULTY_WEIGHTS = [0, 1, 2, 3];
const DEEP_FLAGS = new Set(['high_risk', 'debug', 'long_context']);
const FULL_PROMPT_FLAGS = new Set(['high_risk', 'long_context', 'debug', 'strict_format']);
const COMPRESS_BLOCK_FLAGS = new Set(['high_risk', 'strict_format', 'debug']);
function hasAnyFlag(flags, names) {
    if (!flags)
        return false;
    for (const name of names)
        if (flags[name])
            return true;
    return false;
}
/** Synthetic 4-class probability vector peaking on the given tier (fallback/default handling). */
export function syntheticOneHot(tier, dominant = SYNTHETIC_PEAK) {
    const n = TIER_ORDER.length;
    const residual = (1 - dominant) / Math.max(n - 1, 1);
    const idx = TIER_ORDER.indexOf(tier) >= 0 ? TIER_ORDER.indexOf(tier) : 1;
    const probs = Array(n).fill(residual);
    probs[idx] = dominant;
    return probs;
}
export function computeDifficulty(probs) {
    let total = 0;
    for (let i = 0; i < probs.length; i++) {
        total += (DIFFICULTY_WEIGHTS[i] ?? 0) * probs[i];
    }
    return total;
}
export function computeMargin(probs) {
    if (probs.length < 2)
        return probs.length > 0 ? probs[0] : 0;
    const ordered = [...probs].sort((a, b) => b - a);
    return Math.max(0, ordered[0] - ordered[1]);
}
export function deriveThinkingMode(probs, flags, { t3MinIdx = 2, t0MaxIdx = 0, t0MinMargin = 0.5, t1MaxIdx = 1, t1MinMargin = 0.4, } = {}) {
    let top1Idx = 0;
    for (let i = 1; i < probs.length; i++)
        if (probs[i] > probs[top1Idx])
            top1Idx = i;
    const margin = computeMargin(probs);
    if (top1Idx >= TIER_ORDER.length - 1)
        return 'T3';
    if (top1Idx >= t3MinIdx && hasAnyFlag(flags, DEEP_FLAGS))
        return 'T3';
    if (top1Idx <= t0MaxIdx && margin >= t0MinMargin)
        return 'T0';
    if (top1Idx <= t1MaxIdx && margin >= t1MinMargin)
        return 'T1';
    return 'T2';
}
export function derivePromptPolicy(probs, flags, { maxDifficulty = 0.8, minMargin = 0.4 } = {}) {
    if (hasAnyFlag(flags, FULL_PROMPT_FLAGS))
        return 'P2';
    if (computeDifficulty(probs) <= maxDifficulty
        && computeMargin(probs) >= minMargin
        && !hasAnyFlag(flags, COMPRESS_BLOCK_FLAGS)) {
        return 'P0';
    }
    return 'P1';
}
/** Forbid THINK_DEEP (T2/T3) + P0 compress — contradictory. */
export function normalizeDecisions(thinkingMode, promptPolicy) {
    if ((thinkingMode === 'T2' || thinkingMode === 'T3') && promptPolicy === 'P0') {
        return [thinkingMode, 'P1'];
    }
    return [thinkingMode, promptPolicy];
}
const THINKING_MODE_LEVEL = {
    T0: undefined,
    T1: 'low',
    T2: 'medium',
    T3: 'high',
};
/** Upstream thinking level vocabulary; DSH effort mapping lives in route.ts. */
export function thinkingModeToLevel(mode) {
    if (mode === undefined || mode === null)
        return undefined;
    return THINKING_MODE_LEVEL[mode];
}
const CJK_RANGES = [
    [0x4e00, 0x9fff],
    [0x3400, 0x4dbf],
    [0xf900, 0xfaff],
];
/** `zh` when the prompt is substantially CJK (>= 2 CJK chars), else `en`. */
export function promptHintLocale(text) {
    if (!text)
        return 'en';
    let cjkCount = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (CJK_RANGES.some(([start, end]) => code >= start && code <= end))
            cjkCount++;
    }
    return cjkCount >= 2 ? 'zh' : 'en';
}
/** Localized P0 hint text for the current input language; undefined for non-P0 policies. */
export function getPromptHint(policy, text) {
    if (!policy || policy !== 'P0')
        return undefined;
    return promptHintLocale(text) === 'zh' ? PROMPT_HINT_ZH : PROMPT_HINT_EN;
}
/** The exact envelope OpenSquilla injects user-visibly for an applied hint. */
export function formatPromptHintSuffix(hint) {
    return `\n\n---\n[RESPONSE_POLICY: ${hint}]`;
}
