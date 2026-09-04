// Decode an SSE byte stream into event `data` payloads.
// @module dsh-opensquilla/sse
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { LlmError } from '@deepseek-ai/dsh-llm';
/** The terminal payload OpenAI-compatible providers send after the last chunk. */
export const DONE = '[DONE]';
/**
 * Parse an SSE byte stream into data payloads, yielding `[DONE]` last.
 * Throws `LlmError('STREAM_CLOSED')` when the stream ends without it
 * (truncated response — the model call cannot be trusted).
 */
export async function* parseSse(stream, onComment) {
    const events = stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream({ onComment }));
    for await (const { data } of events) {
        yield data;
        if (data === DONE)
            return;
    }
    throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}
