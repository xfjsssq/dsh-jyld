// Post-classifier routing policy: named heuristic stages over one decision.
//
// Derived from OpenSquilla (https://github.com/opensquilla/opensquilla),
// Apache-2.0 © OpenSquilla contributors — behavioral port of
// `opensquilla/engine/routing/policy.py` (RoutingPolicyEngine), rewritten for
// DSH-OpenSquilla. The legacy ordering and interactions are preserved:
//
// confidence_gate → complaint_upgrade → anti_downgrade → capability_gate →
// bind → reconcile → large_context_floor → (budget_gate, default-off, last)
//
// Not ported (no DSH equivalent / single-provider plugin): artifact floor and
// provider-mismatch stages. Calibration is additive upstream and default-off;
// it stays off here. See NOTICE.md.
import { DEFAULT_TEXT_TIER, HIGHEST_TEXT_TIER, canonicalOrder, normalizeTextTier, ROUTE_CLASS_TO_TIER, TIER_TO_ROUTE_CLASS, tierIndex } from "../tiers.js";
import { normalizeDecisions } from "./controller.js";
import { COMPLAINT_TERMS, DEFAULT_CONTEXT_WINDOW_TOKENS, LARGE_CONTEXT_T2_FLOOR_TOKENS, LARGE_CONTEXT_T3_CONTEXT_RATIO, LARGE_CONTEXT_T3_FLOOR_TOKENS, THINKING_MODE_ORDER, } from "./data.js";
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function tierIndexOf(tier, validTiers) {
    const normalized = normalizeTextTier(tier) ?? tier;
    const ordered = canonicalOrder(validTiers);
    return ordered.indexOf(normalized);
}
function upgradeTier(tier, validTiers, steps) {
    const ordered = canonicalOrder(validTiers);
    const normalized = normalizeTextTier(tier) ?? tier;
    const idx = ordered.indexOf(normalized);
    if (idx < 0)
        return tier;
    return ordered[Math.min(idx + Math.max(steps, 0), ordered.length - 1)];
}
export function routeClassForTier(tier) {
    const normalized = normalizeTextTier(tier) ?? tier;
    return TIER_TO_ROUTE_CLASS[normalized];
}
function tierForRouteClass(routeClass) {
    if (routeClass === null || routeClass === undefined)
        return undefined;
    return ROUTE_CLASS_TO_TIER[String(routeClass)];
}
function minThinkingModeForTier(tier) {
    const normalized = normalizeTextTier(tier);
    if (normalized === HIGHEST_TEXT_TIER)
        return 'T3';
    if (normalized === 'c2')
        return 'T2';
    if (normalized === DEFAULT_TEXT_TIER)
        return 'T1';
    return undefined;
}
function promoteThinkingMode(current, minimum) {
    if (minimum === undefined)
        return current ?? undefined;
    if (current === undefined || current === null || THINKING_MODE_ORDER[current] === undefined)
        return minimum;
    if (THINKING_MODE_ORDER[current] < THINKING_MODE_ORDER[minimum])
        return minimum;
    return current;
}
/** Newest history entry inside the window (scanned backwards). */
export function previousFinalEntry(routingHistory, now, window) {
    if (!routingHistory || routingHistory.length === 0)
        return undefined;
    const cutoff = now - window;
    for (let i = routingHistory.length - 1; i >= 0; i--) {
        const entry = routingHistory[i];
        if ((entry.ts ?? now) >= cutoff)
            return entry;
    }
    return undefined;
}
export function previousFinalTier(entry) {
    if (!entry)
        return undefined;
    const tier = entry.finalTier;
    if (tier)
        return normalizeTextTier(tier) ?? tier;
    return tierForRouteClass(entry.finalRouteClass ?? entry.routeClass);
}
export function detectComplaint(message, maxChars) {
    const text = message.trim();
    if (maxChars !== undefined && maxChars > 0 && text.length > maxChars)
        return [];
    const lowered = text.toLowerCase();
    const hits = [];
    for (const term of COMPLAINT_TERMS)
        if (lowered.includes(term))
            hits.push(term);
    return hits;
}
function confidenceGate(tier, options) {
    const { confidence, config, validTiers, tiers } = options;
    const threshold = config.confidenceThreshold ?? 0.5;
    const highTierMargin = config.confidenceHighTierMargin ?? 0.05;
    const rawDefault = config.defaultTier;
    if (rawDefault === undefined || rawDefault === null) {
        return { tier, applied: false, threshold, defaultTier: undefined };
    }
    const defaultTier = normalizeTextTier(rawDefault) ?? rawDefault;
    const selected = tiers[tier];
    if (selected?.imageOnly)
        return { tier, applied: false, threshold, defaultTier };
    const tierRank = tierIndexOf(tier, validTiers);
    const defaultRank = tierIndexOf(defaultTier, validTiers);
    const cutoff = tierRank > defaultRank ? threshold - highTierMargin : threshold;
    if (confidence < cutoff && tierRank >= 0 && defaultRank >= 0 && tier !== defaultTier) {
        return { tier: defaultTier, applied: true, threshold, defaultTier };
    }
    return { tier, applied: false, threshold, defaultTier };
}
function complaintUpgrade(tier, options) {
    const { message, config, validTiers, preConfidenceTier, previousTier } = options;
    const steps = config.complaintUpgradeSteps ?? 1;
    const maxChars = config.complaintUpgradeMaxChars ?? 160;
    if (config.complaintUpgradeEnabled === false) {
        return { tier, terms: [], applied: false, steps, maxChars };
    }
    const terms = detectComplaint(message, maxChars);
    if (terms.length === 0)
        return { tier, terms, applied: false, steps, maxChars };
    // A non-text working tier (the image route) must never be restarted into
    // the text ladder by a complaint: the restart source would be the previous
    // TEXT tier, and the turn would end up on a model that cannot serve the
    // image. Detect and record, never upgrade off the vision route.
    if (!validTiers.includes(tier))
        return { tier, terms, applied: false, steps, maxChars };
    let upgradeStartTier = tier;
    if (preConfidenceTier !== ''
        && validTiers.includes(preConfidenceTier)
        && tierIndexOf(preConfidenceTier, validTiers) > tierIndexOf(upgradeStartTier, validTiers)) {
        upgradeStartTier = preConfidenceTier;
    }
    if (previousTier !== undefined
        && validTiers.includes(previousTier)
        && tierIndexOf(previousTier, validTiers) > tierIndexOf(upgradeStartTier, validTiers)) {
        upgradeStartTier = previousTier;
    }
    const upgradedTier = upgradeTier(upgradeStartTier, validTiers, steps);
    return { tier: upgradedTier, terms, applied: upgradedTier !== tier, steps, maxChars };
}
function antiDowngrade(tier, options) {
    const { config, validTiers, previousTier } = options;
    if (config.antiDowngradeEnabled !== false
        && previousTier !== undefined
        && validTiers.includes(previousTier)
        && tierIndexOf(tier, validTiers) >= 0
        && tierIndexOf(previousTier, validTiers) > tierIndexOf(tier, validTiers)) {
        return { tier: previousTier, applied: true };
    }
    return { tier, applied: false };
}
function capabilityGate(tier, options) {
    const { validTiers, tierCapabilities, turnHasImage, materialTokens } = options;
    if (!tierCapabilities || Object.keys(tierCapabilities).length === 0)
        return { tier, actions: [] };
    const ordered = canonicalOrder(validTiers);
    const normalized = normalizeTextTier(tier) ?? tier;
    const startIdx = ordered.indexOf(normalized);
    if (startIdx < 0)
        return { tier, actions: [] };
    let current = ordered[startIdx];
    let idx = startIdx;
    const actions = [];
    const caps = (name) => tierCapabilities[name] ?? {};
    if (turnHasImage && caps(current).supportsVision === false) {
        for (const candidate of ordered.slice(idx + 1)) {
            if (caps(candidate).supportsVision === true) {
                actions.push({ rule: 'vision_walk_up', fromTier: current, toTier: candidate });
                current = candidate;
                idx = ordered.indexOf(current);
                break;
            }
        }
    }
    const window = caps(current).contextWindow;
    if (materialTokens > 0 && window !== undefined && materialTokens > window) {
        let target;
        for (const candidate of ordered.slice(idx + 1)) {
            const candidateWindow = caps(candidate).contextWindow;
            if (candidateWindow !== undefined && materialTokens <= candidateWindow) {
                target = candidate;
                break;
            }
        }
        if (target === undefined && idx < ordered.length - 1)
            target = ordered[ordered.length - 1];
        if (target !== undefined && target !== current) {
            actions.push({ rule: 'context_walk_up', fromTier: current, toTier: target });
            current = target;
        }
    }
    return { tier: current, actions };
}
function recordCapabilityGateTrail(extra, result) {
    if (result.actions.length === 0)
        return;
    const trail = extra.routing_trail ?? [];
    for (const action of result.actions) {
        trail.push({
            stage: 'capability_gate',
            rule: action.rule,
            from_tier: action.fromTier,
            to_tier: action.toTier,
        });
    }
    extra.routing_trail = trail;
    extra.capability_gate_applied = true;
}
function bind(decision, options) {
    const { finalTier, tiers, extra, baseTier, preConfidenceTier, gate, complaint, downgrade, previousTier, previousRouteClass, windowSeconds } = options;
    const finalRouteClass = routeClassForTier(finalTier);
    extra.base_tier = baseTier;
    extra.pre_confidence_tier = normalizeTextTier(preConfidenceTier) ?? preConfidenceTier;
    extra.confidence_threshold = gate.threshold;
    extra.confidence_default_tier = gate.defaultTier;
    extra.confidence_gate_applied = gate.applied;
    extra.final_tier = finalTier;
    extra.final_route_class = finalRouteClass;
    extra.complaint_detected = complaint.terms.length > 0;
    extra.complaint_terms = complaint.terms;
    extra.complaint_upgrade_applied = complaint.applied;
    extra.complaint_upgrade_steps = complaint.steps;
    extra.complaint_upgrade_max_chars = complaint.maxChars;
    extra.anti_downgrade_applied = downgrade.applied;
    extra.previous_tier = previousTier === undefined ? undefined : (normalizeTextTier(previousTier) ?? previousTier);
    extra.previous_route_class = previousRouteClass;
    extra.kv_cache_window_seconds = windowSeconds;
    return {
        tier: finalTier,
        model: tiers[finalTier]?.model ?? decision.model,
        confidence: decision.confidence,
        source: decision.source,
    };
}
function reconcileControllerWithFinalTier(thinkingMode, promptPolicy, extra) {
    const finalTierRaw = extra.final_tier;
    const finalTier = typeof finalTierRaw === 'string' ? (normalizeTextTier(finalTierRaw) ?? finalTierRaw) : undefined;
    const baseTierRaw = extra.base_tier;
    const baseTier = typeof baseTierRaw === 'string' ? (normalizeTextTier(baseTierRaw) ?? baseTierRaw) : undefined;
    if (!finalTier || finalTier === baseTier)
        return [thinkingMode, promptPolicy];
    const originalThinking = thinkingMode;
    const originalPrompt = promptPolicy;
    let nextThinking = promoteThinkingMode(thinkingMode ?? undefined, minThinkingModeForTier(finalTier));
    let nextPrompt = promptPolicy ?? undefined;
    if (nextPrompt === 'P0' && (finalTier === 'c2' || finalTier === HIGHEST_TEXT_TIER || extra.complaint_detected === true)) {
        nextPrompt = 'P1';
    }
    if (nextThinking !== undefined && nextPrompt !== undefined) {
        const [t, p] = normalizeDecisions(nextThinking, nextPrompt);
        nextThinking = t;
        nextPrompt = p;
    }
    if (nextThinking !== originalThinking || nextPrompt !== originalPrompt) {
        if (extra.base_thinking_mode === undefined)
            extra.base_thinking_mode = originalThinking;
        if (extra.base_prompt_policy === undefined)
            extra.base_prompt_policy = originalPrompt;
        extra.thinking_mode = nextThinking;
        extra.prompt_policy = nextPrompt;
        extra.controller_reconciled = true;
    }
    else if (extra.controller_reconciled === undefined) {
        extra.controller_reconciled = false;
    }
    return [nextThinking, nextPrompt];
}
export function largeContextMinTier(materialTokens, contextWindowTokens) {
    if (materialTokens >= LARGE_CONTEXT_T3_FLOOR_TOKENS
        || materialTokens >= Math.trunc(contextWindowTokens * LARGE_CONTEXT_T3_CONTEXT_RATIO)) {
        return HIGHEST_TEXT_TIER;
    }
    if (materialTokens >= LARGE_CONTEXT_T2_FLOOR_TOKENS)
        return 'c2';
    return undefined;
}
export function resolveLargeContextFloorTier(minimumTier, validTiers) {
    const minimumIndex = tierIndex(minimumTier);
    if (minimumIndex < 0)
        return undefined;
    return canonicalOrder(validTiers).find(tier => tierIndex(tier) >= minimumIndex);
}
function largeContextFloor(decision, options) {
    const { tiers, validTiers, materialTokens, contextWindowTokens, extra, metadataUpdates } = options;
    if (!validTiers.includes(decision.tier))
        return decision;
    const requiredTier = largeContextMinTier(materialTokens, contextWindowTokens);
    if (requiredTier === undefined)
        return decision;
    const minTier = resolveLargeContextFloorTier(requiredTier, validTiers);
    if (minTier === undefined)
        return decision;
    if (tierIndexOf(decision.tier, validTiers) >= tierIndexOf(minTier, validTiers))
        return decision;
    const floored = {
        tier: minTier,
        model: tiers[minTier]?.model ?? decision.model,
        confidence: decision.confidence,
        source: 'large_context_floor',
    };
    metadataUpdates.large_context_floor_from_tier = decision.tier;
    metadataUpdates.large_context_material_tokens = materialTokens;
    if (extra !== undefined) {
        if (extra.base_tier === undefined)
            extra.base_tier = decision.tier;
        extra.large_context_floor_applied = true;
        extra.large_context_floor_from_tier = decision.tier;
        extra.large_context_floor_min_tier = minTier;
        extra.large_context_material_tokens = materialTokens;
        extra.large_context_pre_floor_source = decision.source;
        extra.final_tier = minTier;
        extra.final_route_class = routeClassForTier(minTier);
    }
    return floored;
}
function budgetGate(tier, options) {
    const { validTiers, budget, minimumTier } = options;
    if (budget.spendUsd === null || budget.spendUsd === undefined) {
        return { tier, outcome: 'suspended', limitUsd: budget.limitUsd, action: budget.action, fromTier: '', spendSource: budget.spendSource ?? 'unknown' };
    }
    const projected = budget.spendUsd + (budget.estimateUsd ?? 0);
    if (projected <= budget.limitUsd) {
        return { tier, outcome: 'under_limit', spendUsd: budget.spendUsd, projectedUsd: projected, limitUsd: budget.limitUsd, action: budget.action, fromTier: '', spendSource: budget.spendSource ?? 'unknown' };
    }
    if (budget.action === 'cap') {
        let target = budget.capTier === undefined ? undefined : (normalizeTextTier(budget.capTier) ?? undefined);
        const minimum = minimumTier === undefined ? undefined : (normalizeTextTier(minimumTier) ?? undefined);
        if (target !== undefined && minimum !== undefined && validTiers.includes(minimum)
            && tierIndexOf(target, validTiers) < tierIndexOf(minimum, validTiers)) {
            target = minimum;
        }
        if (target !== undefined && validTiers.includes(target) && tierIndexOf(target, validTiers) < tierIndexOf(tier, validTiers)) {
            return { tier: target, outcome: 'cap', spendUsd: budget.spendUsd, projectedUsd: projected, limitUsd: budget.limitUsd, action: 'cap', fromTier: tier, spendSource: budget.spendSource ?? 'unknown' };
        }
        return { tier, outcome: 'warn', spendUsd: budget.spendUsd, projectedUsd: projected, limitUsd: budget.limitUsd, action: 'warn', fromTier: tier, spendSource: budget.spendSource ?? 'unknown' };
    }
    return { tier, outcome: 'warn', spendUsd: budget.spendUsd, projectedUsd: projected, limitUsd: budget.limitUsd, action: 'warn', fromTier: tier, spendSource: budget.spendSource ?? 'unknown' };
}
function recordBudgetGateTrail(extra, result) {
    if (result.outcome !== 'warn' && result.outcome !== 'cap')
        return;
    const trail = extra.routing_trail ?? [];
    const entry = {
        stage: 'budget_gate',
        rule: result.outcome,
        spend_usd: result.spendUsd,
        limit_usd: result.limitUsd,
        spend_source: result.spendSource,
    };
    if (result.outcome === 'cap') {
        entry.from_tier = result.fromTier;
        entry.to_tier = result.tier;
    }
    trail.push(entry);
    extra.routing_trail = trail;
    extra.budget_gate_applied = true;
    extra.budget_gate_outcome = result.outcome;
}
function applyBudgetGate(decision, result, options) {
    const { tiers, extra, metadataUpdates } = options;
    if (result.outcome !== 'warn' && result.outcome !== 'cap')
        return decision;
    metadataUpdates.router_budget_applied = true;
    metadataUpdates.router_budget_outcome = result.outcome;
    metadataUpdates.router_budget_action = result.action;
    metadataUpdates.router_budget_limit_usd = result.limitUsd;
    metadataUpdates.router_budget_spend_source = result.spendSource;
    if (result.spendUsd !== undefined)
        metadataUpdates.router_budget_spend_usd = result.spendUsd;
    if (result.projectedUsd !== undefined && result.projectedUsd !== result.spendUsd) {
        metadataUpdates.router_budget_projected_usd = result.projectedUsd;
    }
    if (extra !== undefined)
        recordBudgetGateTrail(extra, result);
    if (result.outcome === 'cap') {
        metadataUpdates.router_budget_from_tier = result.fromTier;
        metadataUpdates.router_budget_to_tier = result.tier;
        if (extra !== undefined) {
            extra.final_tier = result.tier;
            extra.final_route_class = routeClassForTier(result.tier);
        }
        return {
            tier: result.tier,
            model: tiers[result.tier]?.model ?? decision.model,
            confidence: decision.confidence,
            source: 'budget_cap',
        };
    }
    return decision; // warn: tier unchanged
}
// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
/**
 * Runs the post-classifier stages in the exact upstream order. `inputs.extra`
 * is mutated in place (it is the turn's routing_extra); everything destined
 * for turn metadata is returned in `PolicyResult.metadataUpdates` so the
 * caller stays the only writer of turn metadata.
 */
export function runPolicy(inputs) {
    let decision = inputs.decision;
    let thinkingMode = inputs.thinkingMode;
    let promptPolicy = inputs.promptPolicy;
    const metadataUpdates = {};
    const extra = inputs.extra;
    const contextWindowTokens = inputs.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    if (inputs.historyStrategy && extra !== undefined) {
        decision = finalizeStage(decision, inputs, extra);
        const [t, p] = reconcileControllerWithFinalTier(thinkingMode, promptPolicy, extra);
        thinkingMode = t;
        promptPolicy = p;
    }
    const requiredContextTier = largeContextMinTier(inputs.materialEstimatedTokens, contextWindowTokens);
    const minimumContextTier = resolveLargeContextFloorTier(requiredContextTier, inputs.validTiers);
    if (requiredContextTier !== undefined) {
        metadataUpdates.large_context_floor_min_tier = minimumContextTier ?? requiredContextTier;
        metadataUpdates.large_context_material_tokens = inputs.materialEstimatedTokens;
    }
    decision = largeContextFloor(decision, {
        tiers: inputs.tiers,
        validTiers: inputs.validTiers,
        materialTokens: inputs.materialEstimatedTokens,
        contextWindowTokens,
        extra,
        metadataUpdates,
    });
    if (decision.source === 'large_context_floor' && extra !== undefined) {
        const [t, p] = reconcileControllerWithFinalTier(thinkingMode, promptPolicy, extra);
        thinkingMode = t;
        promptPolicy = p;
    }
    // Budget gate runs last: it can only hold or lower the tier, never raise
    // it. With `budget === undefined` (the default) the whole block is skipped.
    if (inputs.budget !== undefined) {
        let budgetTiers = inputs.validTiers;
        if (requiredContextTier !== undefined) {
            const minimumIndex = tierIndex(requiredContextTier);
            budgetTiers = inputs.validTiers.filter(tier => tierIndex(tier) >= minimumIndex);
        }
        const budgetResult = budgetGate(decision.tier, {
            validTiers: budgetTiers,
            budget: inputs.budget,
            // Artifact floors are not ported; the minimum stays unset.
            minimumTier: undefined,
        });
        decision = applyBudgetGate(decision, budgetResult, {
            tiers: inputs.tiers,
            extra,
            metadataUpdates,
        });
    }
    return { decision, thinkingMode, promptPolicy, metadataUpdates };
}
function finalizeStage(decision, inputs, extra) {
    const baseTier = normalizeTextTier(decision.tier) ?? decision.tier;
    let finalTier = baseTier;
    const baseRouteClass = extra.route_class ?? routeClassForTier(baseTier);
    if (baseRouteClass !== undefined) {
        extra.route_class = baseRouteClass;
        if (extra.top1_label === undefined)
            extra.top1_label = baseRouteClass;
    }
    const preConfidenceTier = finalTier;
    const gate = confidenceGate(finalTier, {
        confidence: decision.confidence,
        config: inputs.config,
        validTiers: inputs.validTiers,
        tiers: inputs.tiers,
    });
    finalTier = gate.tier;
    const now = inputs.now ?? 0;
    const windowSeconds = inputs.config.antiDowngradeWindowSeconds ?? 600;
    const previousEntry = previousFinalEntry(inputs.routingHistory, now, windowSeconds);
    const previousTier = previousFinalTier(previousEntry);
    const previousRouteClass = previousEntry
        ? (previousEntry.finalRouteClass ?? previousEntry.routeClass)
        : undefined;
    const complaint = complaintUpgrade(finalTier, {
        message: inputs.message,
        config: inputs.config,
        validTiers: inputs.validTiers,
        preConfidenceTier,
        previousTier,
    });
    finalTier = complaint.tier;
    const downgrade = antiDowngrade(finalTier, {
        config: inputs.config,
        validTiers: inputs.validTiers,
        previousTier,
    });
    finalTier = downgrade.tier;
    const gateCapabilities = capabilityGate(finalTier, {
        validTiers: inputs.validTiers,
        tierCapabilities: inputs.tierCapabilities,
        turnHasImage: inputs.turnHasImage ?? false,
        materialTokens: inputs.materialEstimatedTokens,
    });
    recordCapabilityGateTrail(extra, gateCapabilities);
    finalTier = gateCapabilities.tier;
    return bind(decision, {
        finalTier,
        tiers: inputs.tiers,
        extra,
        baseTier,
        preConfidenceTier,
        gate,
        complaint,
        downgrade,
        previousTier,
        previousRouteClass,
        windowSeconds,
    });
}
