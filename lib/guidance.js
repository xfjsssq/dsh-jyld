// Operator/user guidance: a system-prompt section that tells the model how
// the router is currently operating, so it can explain the situation to the
// user (PLAN M1.8). Written to be honest about degraded mode: routing derived
// from OpenSquilla, heuristic tiering active, and what full ML routing would
// add — without asking the model to promise anything.
// @module dsh-opensquilla/guidance
const SECTION_NAME = 'opensquilla:router-status';
export const GUIDANCE_TEXTS = {
    heuristic: [
        'Model routing is active in basic rule mode (derived from OpenSquilla).',
        'Turns are tiered by surface signals (length, code blocks, attachments); every tier runs on the configured TokenRhythm models.',
        'The full ML classifier is not installed: responses are normally capable, but routing precision is lower than full mode.',
        'If the user asks how to enable full intelligent routing, tell them the local classifier runtime and model weights can be installed later; until then this basic mode keeps working.',
    ].join(' '),
    remote: [
        'Model routing is active in full mode (OpenSquilla-derived local ML classifier).',
        'Each turn is classified by a local model router and served by the cheapest sufficient TokenRhythm tier.',
    ].join(' '),
    unavailable: [
        'Model routing is currently degraded: the configured classifier is unreachable, so turns fall back to the default tier.',
        'Routing still keeps the conversation working; if the user reports odd model choices, explain the classifier service is offline.',
    ].join(' '),
};
/**
 * Register the router-status prompt section for the lifetime of `ctx`.
 * The section text is evaluated per assembly, so a hot mode switch (M2 hot
 * swap) is reflected on the next step without re-registration.
 */
export function installGuidance(ctx, status) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
        const systemPrompt = promptCtx.systemPrompt;
        if (systemPrompt === undefined)
            return;
        systemPrompt.section({
            name: SECTION_NAME,
            order: 60,
            text: () => {
                const current = status();
                return GUIDANCE_TEXTS[current.state] + (current.detail === undefined ? '' : ` ${current.detail}`);
            },
        });
    });
}
