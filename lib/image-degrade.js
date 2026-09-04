import { contentHasImage } from '@deepseek-ai/dsh-llm';
import { messagesWithoutHistoryImages } from "./serialize.js";
/** Provider routes whose own adapter already performs this degradation. */
const SELF_DEGRADING_PROVIDERS = new Set(['tokenrhythm']);
/**
 * Marks the re-dispatched copy so the second waterfall pass falls straight
 * through to the real adapter. A symbol key stays off the wire: JSON
 * serialization ignores symbols.
 */
const REDISPATCHED = Symbol('dsh-opensquilla/image-degraded');
/**
 * Install the degradation listener for the lifetime of `ctx`.
 *
 * The request object arrives DEEP-FROZEN (agent-loop/src/agent.ts:505) and the
 * waterfall leaf closes over the original options (llm/src/index.ts:921), so
 * neither in-place mutation nor returning a new options record can reach the
 * adapter. The listener therefore SHORT-CIRCUITS: it re-dispatches a degraded
 * copy through the public stream API, the same way the host's own tests let a
 * short-circuiting listener own a route. The outer request keeps its agent-loop
 * mark and passes the reconstruction invariant untouched; the re-dispatched
 * copy is a new object, so the mark (a WeakSet keyed by identity) does not
 * carry over and the invariant correctly skips a request that intentionally
 * diverges from the session log.
 */
export function installHistoryImageDegradation(ctx) {
    return ctx.on('llm/stream', (options, next) => {
        if (SELF_DEGRADING_PROVIDERS.has(options.provider))
            return next();
        if (options[REDISPATCHED] === true)
            return next();
        if (!options.messages.some(message => contentHasImage(message.content)))
            return next();
        const degraded = messagesWithoutHistoryImages(options.messages);
        if (degraded === undefined)
            return next();
        return ctx.llm.stream({ ...options, messages: degraded, [REDISPATCHED]: true });
    });
}
/** Pure decision used by the listener; exported for tests. */
export function degradeHistoryImages(options) {
    if (SELF_DEGRADING_PROVIDERS.has(options.provider))
        return options;
    if (!options.messages.some(message => contentHasImage(message.content)))
        return options;
    const degraded = messagesWithoutHistoryImages(options.messages);
    if (degraded === undefined)
        return options;
    return { ...options, messages: degraded };
}
