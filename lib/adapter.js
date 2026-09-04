// TokenRhythmAdapter: fetch + SSE against the TokenRhythm (OpenAI-compatible)
// chat-completions endpoint, emitting harness StreamChunks. Transport-only:
// connection facts arrive through a thunk resolved once per operation and the
// bearer token through a per-request resolver, so the registering plugin owns
// validation, layering, and credential policy.
//
// One stable signal reaches both initial fetch and body reads. Caller aborts
// map to `ABORTED`; the per-read idle watchdog maps to `TIMEOUT`.
// @module dsh-opensquilla/adapter
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { serializeRequest, serializeRequestWithImages, messagesWithoutHistoryImages } from "./serialize.js";
import { parseSse } from "./sse.js";
import { translate } from "./translate.js";
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_EFFORT = ReasoningEffortId('off');
const LOW_EFFORT = ReasoningEffortId('low');
const HIGH_EFFORT = ReasoningEffortId('high');
const MAX_EFFORT = ReasoningEffortId('max');
const REASONING_EFFORTS = [
    { id: OFF_EFFORT, name: 'Off' },
    { id: LOW_EFFORT, name: 'Low' },
    { id: HIGH_EFFORT, name: 'High' },
    { id: MAX_EFFORT, name: 'Max' },
];
const OFF_ONLY_EFFORTS = [{ id: OFF_EFFORT, name: 'Off' }];
export function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: model.inputModalities ?? ['text'],
    };
}
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
    if (/^\d+$/.test(value)) {
        const delay = Number(value) * 1_000;
        return Number.isFinite(delay) && delay > 0 ? delay : undefined;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
function requestId(headers) {
    const value = headers.get('x-request-id');
    return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}
export function httpErrorCode(status, error) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 413)
        return 'INVALID_REQUEST';
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
export class TokenRhythmAdapter extends LlmAdapter {
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    providerInfo(provider) {
        return { id: provider, name: '智能路由' };
    }
    /** Info for the virtual routing model; image-capable and wide-context so the
     * host lets mixed turns keep the selection until the swap replaces it. */
    routingModelInfo(provider) {
        return {
            provider,
            id: this.config.routingModelId,
            name: '智能路由',
            description: 'OpenSquilla per-turn routing: auto tier pick (c0–c3/image) per step difficulty.',
            inputModalities: ['text', 'image'],
        };
    }
    isRoutingModel(model) {
        return this.config.routingModelId !== undefined && model === this.config.routingModelId;
    }
    providerRetryPolicy(_provider) {
        return this.config.options().retryPolicy;
    }
    listModels(provider) {
        // Public model picker: expose only the smart-routing entry. Tier models
        // remain internal configuration targets; selecting them directly would
        // bypass routing and clutter the provider's catalog.
        if (this.config.routingModelId === undefined)
            return Promise.resolve([]);
        if (this.config.isPubliclySelectable?.() === false)
            return Promise.resolve([]);
        return Promise.resolve([this.routingModelInfo(provider)]);
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.options();
        if (this.isRoutingModel(model)) {
            // The virtual model resolves like any catalog entry; the request-side
            // routing listener swaps provider+model before the call leaves the host.
            return Promise.resolve({
                ...this.routingModelInfo(provider),
                context: { contextWindow: connection.defaultContextWindow },
                defaultMaxTokens: connection.maxTokens,
            });
        }
        const configured = connection.models.find(entry => entry.id === model);
        const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
        return Promise.resolve({
            // An uncatalogued endpoint is safely treated as text-only. Declaring an
            // unverified image capability would let the host persist input that the
            // endpoint may reject on every later turn.
            ...configured === undefined
                ? { provider, id: model, name: model, inputModalities: ['text'] }
                : modelInfo(provider, configured),
            context: { contextWindow },
            defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
            ...connection.defaults.thinking === 'disabled'
                ? {
                    reasoning: {
                        efforts: OFF_ONLY_EFFORTS,
                        defaultEffort: OFF_EFFORT,
                    },
                }
                : {
                    reasoning: {
                        efforts: REASONING_EFFORTS,
                        // No configured default → no defaultEffort: the ladder spans
                        // multiple vendors, so thinking stays at each provider's own
                        // default unless the operator explicitly sets an effort.
                        ...connection.defaults.reasoningEffort === undefined
                            ? {}
                            : {
                                defaultEffort: connection.defaults.reasoningEffort === 'off'
                                    ? OFF_EFFORT
                                    : connection.defaults.reasoningEffort === 'low'
                                        ? LOW_EFFORT
                                        : connection.defaults.reasoningEffort === 'max'
                                            ? MAX_EFFORT
                                            : HIGH_EFFORT,
                            },
                    },
                },
        });
    }
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            // One resolution per stream call: connection facts and the credential
            // freeze here, so an in-flight stream never observes a configuration
            // change and the next call re-resolves.
            const connection = this.config.options();
            const latestUser = [...options.messages].reverse().find(message => message.role === 'user');
            const turnHasImage = latestUser !== undefined && contentHasImage(latestUser.content);
            const historyHasImage = !turnHasImage && options.messages.some(message => contentHasImage(message.content));
            let attachments;
            if (historyHasImage) {
                // Resent history images bound for a text-only tier: degrade the earlier
                // image blocks to a pointer at the visual model's own analysis instead
                // of failing the turn. Latest-message images keep the strict gate below.
                const model = connection.models.find(entry => entry.id === options.model);
                if (model?.inputModalities?.includes('image') !== true) {
                    const degraded = messagesWithoutHistoryImages(options.messages);
                    if (degraded !== undefined)
                        options = { ...options, messages: degraded };
                }
            }
            const hasImages = options.messages.some(message => contentHasImage(message.content));
            if (hasImages) {
                const model = connection.models.find(entry => entry.id === options.model);
                if (model?.inputModalities?.includes('image') !== true) {
                    throw new LlmError(`TokenRhythm model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
                }
                attachments = this.config.resolveAttachments?.();
                if (attachments === undefined) {
                    throw new LlmError('TokenRhythm image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT');
                }
            }
            const apiKey = await this.config.resolveApiKey(connection);
            const userId = this.config.resolveUserId();
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey, userId, attachments, () => { watchdog.pulse(); })[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError(`TokenRhythm stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('TokenRhythm request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError(`TokenRhythm API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('TokenRhythm stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch {
                        // The consumer controller already owns termination.
                    }
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async *request(options, signal, connection, apiKey, userId, attachments, onComment) {
        const body = attachments === undefined
            ? serializeRequest(options, connection.defaults)
            : await serializeRequestWithImages(options, {
                attachments,
                maxRequestImageBytes: connection.maxRequestImageBytes,
                signal,
            }, connection.defaults);
        const payload = JSON.stringify(body);
        const headers = {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...attributionHeaders(),
            'x-deepseek-harness-user-id': String(userId),
            ...options.sessionId !== undefined
                ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
                : {},
            ...options.purpose === 'compaction'
                ? { 'x-deepseek-harness-compact': '1' }
                : {},
        };
        let response;
        try {
            response = await fetch(`${connection.baseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: payload,
                signal,
            });
        }
        catch (error) {
            // The outer stream distinguishes caller cancellation and watchdog expiry.
            if (signal.aborted)
                throw error;
            throw new LlmError(`TokenRhythm API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            let message = `TokenRhythm API error (HTTP ${response.status})`;
            let providerError;
            try {
                const parsed = await response.json();
                providerError = parsed.error;
                if (providerError?.message)
                    message = providerError.message;
            }
            catch {
                // Malformed gateway JSON must not mask the HTTP status.
            }
            const delay = providerRetryAfterMs(response.headers.get('retry-after'));
            const id = requestId(response.headers);
            throw new LlmError(message, httpErrorCode(response.status, providerError), {
                status: response.status,
                ...delay === undefined ? {} : { providerRetryAfterMs: delay },
                ...id === undefined ? {} : { requestId: id },
            });
        }
        if (!response.body) {
            throw new LlmError('TokenRhythm API returned no response body', 'EMPTY_RESPONSE');
        }
        yield* translate(parseSse(response.body, onComment));
    }
}
