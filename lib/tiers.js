// Tier vocabulary and the default TokenRhythm tier preset.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of
// `opensquilla/router_tiers.py` and `provider/presets/tokenrhythm.toml`,
// rewritten for DSH-OpenSquilla. See NOTICE.md.
/** Canonical text-tier ladder, cheapest first. Unknown custom tiers rank after these. */
export const TEXT_TIERS = ['c0', 'c1', 'c2', 'c3'];
/** Canonical tier id of the vision route. (PLAN.md calls it "image"; upstream is `image_model`.) */
export const IMAGE_TIER = 'image_model';
export const DEFAULT_TEXT_TIER = 'c1';
export const HIGHEST_TEXT_TIER = 'c3';
/** Legacy t0–t3 aliases kept for config compatibility with older OpenSquilla profiles. */
const LEGACY_ALIASES = { t0: 'c0', t1: 'c1', t2: 'c2', t3: 'c3' };
export const TIER_TO_ROUTE_CLASS = {
    c0: 'R0',
    c1: 'R1',
    c2: 'R2',
    c3: 'R3',
};
export const ROUTE_CLASS_TO_TIER = {
    R0: 'c0',
    R1: 'c1',
    R2: 'c2',
    R3: 'c3',
};
/** Ladder position of a canonical tier name; -1 for unknown names. */
export function tierIndex(tier) {
    if (tier === null || tier === undefined)
        return -1;
    const index = TEXT_TIERS.indexOf(tier);
    return index;
}
/** Normalize a tier name (including legacy aliases) to its canonical form. */
export function normalizeTextTier(tier) {
    if (!tier)
        return undefined;
    const alias = LEGACY_ALIASES[tier];
    if (alias)
        return alias;
    return tierIndex(tier) >= 0 ? tier : undefined;
}
/**
 * The shipped default preset, copied from OpenSquilla's TokenRhythm router
 * ladder. Values are configuration, not code: every model id can be
 * overridden through plugin config / settings (the seam future custom-vendor
 * slots plug into).
 */
export const TOKENRHYTHM_TIERS = {
    c0: { provider: 'tokenrhythm', model: 'deepseek-v4-flash-0731', supportsImage: false, imageOnly: false },
    c1: { provider: 'tokenrhythm', model: 'deepseek-v4-pro-0813', supportsImage: false, imageOnly: false },
    c2: { provider: 'tokenrhythm', model: 'kimi-k2.7-code', supportsImage: false, imageOnly: false },
    c3: { provider: 'tokenrhythm', model: 'glm-5.2', supportsImage: false, imageOnly: false },
    image_model: {
        provider: 'tokenrhythm',
        model: 'kimi-k2.6',
        supportsImage: true,
        imageOnly: true,
    },
};
/** Canonical ladder ordering of valid tier names: c0<c1<c2<c3, unknown names after (stable). */
export function canonicalOrder(validTiers) {
    return [...validTiers].sort((a, b) => {
        const ai = tierIndex(a);
        const bi = tierIndex(b);
        if (ai >= 0 && bi >= 0)
            return ai - bi;
        if (ai >= 0)
            return -1;
        if (bi >= 0)
            return 1;
        return 0;
    });
}
