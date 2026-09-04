// Serialize harness messages into TokenRhythm chat completions.
// @module dsh-opensquilla/serialize
import { contentHasImage, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm';
import { AttachmentError } from '@deepseek-ai/dsh-attachment';
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
/**
 * Model-facing stand-in for a HISTORY image: points the text-only model at
 * the visual model's own earlier reply instead of the pixels. The visual
 * model's answer is already in the assistant history, so a follow-up keeps
 * its context without resending image bytes.
 */
export const HISTORY_IMAGE_TEXT = '[此前对话中发送过的图片已省略:当时负责视觉的模型已基于该图片作答,请结合对话中已有的回答继续;如需重新查看,请让用户再次发送图片。]';
function assertKnownEffort(effort) {
    if (String(effort) === 'off' || String(effort) === 'low' || String(effort) === 'high' || String(effort) === 'max') {
        return String(effort);
    }
    throw new LlmError(`TokenRhythm does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
}
/** Resolve one legal thinking/effort pair; `off` never appears as a wire effort. */
function resolveThinking(options, defaults) {
    if (options.purpose === 'session-title')
        return { thinking: 'disabled' };
    const effort = options.reasoningEffort === undefined
        ? defaults.reasoningEffort
        : assertKnownEffort(options.reasoningEffort);
    if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
        throw new LlmError(`TokenRhythm deployment does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
    }
    if (effort === 'off')
        return { thinking: 'disabled' };
    if (effort === 'low' || effort === 'high' || effort === 'max') {
        return { thinking: 'enabled', reasoningEffort: effort };
    }
    return defaults.thinking === undefined ? {} : { thinking: defaults.thinking };
}
function flattenText(blocks) {
    let text = '';
    for (const block of blocks) {
        if (block.type === 'text')
            text += block.text;
    }
    return text;
}
/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
    if (contentHasImage(blocks)) {
        throw new LlmError('The TokenRhythm text-only request path does not support image content.', 'UNSUPPORTED_CONTENT');
    }
}
function assertSupportedImageRoles(messages) {
    for (const message of messages) {
        if (message.role !== 'user' && contentHasImage(message.content)) {
            throw new LlmError(`The TokenRhythm adapter cannot represent image content in a ${message.role} message.`, 'UNSUPPORTED_CONTENT');
        }
    }
}
async function imagePart(block, attachments, signal) {
    try {
        const stored = await attachments.readImage(block.attachment, signal);
        return {
            type: 'image_url',
            image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
        };
    }
    catch (error) {
        if (error instanceof AttachmentError) {
            throw new LlmError(error.message, error.code, { cause: error });
        }
        throw error;
    }
}
async function contentParts(blocks, attachments, signal) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0)
                    parts.push({ type: 'text', text: block.text });
                break;
            case 'image':
                parts.push(await imagePart(block, attachments, signal));
                break;
            case 'tool-result':
                parts.push(...await contentParts(block.content, attachments, signal));
                break;
            default:
                break;
        }
    }
    return parts;
}
/** Keep text-only user messages on the compact string wire form. */
function compactUserContent(parts) {
    const text = [];
    for (const part of parts) {
        if (part.type === 'image_url')
            return [...parts];
        text.push(part.text);
    }
    return text.join('');
}
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const reasoning = message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('');
    const toolCalls = message.content
        .filter(block => block.type === 'tool-call')
        .map(block => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
    }));
    return {
        role: 'assistant',
        // Text-less turns send "" — NEVER null: some gateways reject null, and the
        // message sits durably in the session log, so a null here would brick
        // every later turn of the session.
        content: text,
        // CoT passback on every reasoning-carrying turn (required on tool-call
        // turns in thinking mode by DeepSeek-family gateways).
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    };
}
export function serializeMessages(messages) {
    const wire = [];
    for (const message of messages) {
        assertTextOnly(message.content);
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            wire.push(serializeAssistant(message));
            continue;
        }
        // Tool results ride in user messages in the harness vocabulary but as
        // role:'tool' messages on the wire.
        const toolResults = message.content.filter(block => block.type === 'tool-result');
        const text = flattenText(message.content);
        if (text.length > 0 || toolResults.length === 0) {
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            wire.push({
                role: 'tool',
                tool_call_id: result.toolCallId,
                // Empty tool output still needs SOME content on the wire.
                content: flattenText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
export async function serializeMessagesWithImages(messages, attachments, signal) {
    assertSupportedImageRoles(messages);
    const wire = [];
    let pendingToolImages = [];
    const flushToolImages = () => {
        if (pendingToolImages.length === 0)
            return;
        wire.push({
            role: 'user',
            content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
        });
        pendingToolImages = [];
    };
    for (const message of messages) {
        if (message.role === 'system') {
            flushToolImages();
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            flushToolImages();
            wire.push(serializeAssistant(message));
            continue;
        }
        const regular = message.content.filter(block => block.type !== 'tool-result');
        const toolResults = message.content.filter((block) => (block.type === 'tool-result'));
        const content = compactUserContent(await contentParts(regular, attachments, signal));
        if (content.length > 0 || toolResults.length === 0) {
            flushToolImages();
            wire.push({ role: 'user', content });
        }
        for (const result of toolResults) {
            const parts = await contentParts(result.content, attachments, signal);
            const images = parts.filter((part) => part.type === 'image_url');
            const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
            wire.push({
                role: 'tool',
                tool_call_id: result.toolCallId,
                content: text || (images.length > 0 ? '(see attached image)' : '(no output)'),
            });
            pendingToolImages.push(...images);
        }
    }
    flushToolImages();
    return wire;
}
function requestWithMessages(options, messages, defaults) {
    const tools = options.tools?.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
    const thinking = resolveThinking(options, defaults);
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...thinking.thinking !== undefined ? { thinking: { type: thinking.thinking } } : {},
        ...thinking.reasoningEffort !== undefined ? { reasoning_effort: thinking.reasoningEffort } : {},
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop !== undefined ? { stop: options.stop } : {},
    };
}
export function serializeRequest(options, defaults = {}) {
    const messages = [];
    if (options.system !== undefined) {
        messages.push({ role: 'system', content: options.system });
    }
    messages.push(...serializeMessages(options.messages));
    return requestWithMessages(options, messages, defaults);
}
export async function serializeRequestWithImages(options, images, defaults = {}) {
    assertSupportedImageRoles(options.messages);
    const requestMessages = offloadRequestImages(options.messages, images.maxRequestImageBytes);
    const messages = [];
    if (options.system !== undefined) {
        messages.push({ role: 'system', content: options.system });
    }
    messages.push(...await serializeMessagesWithImages(requestMessages, images.attachments, images.signal));
    return requestWithMessages(options, messages, defaults);
}
/** Recursively replace image blocks with the history pointer text. */
function replaceHistoryImages(blocks, state) {
    let next;
    for (const [index, block] of blocks.entries()) {
        if (block.type === 'image') {
            state.replaced += 1;
            next ??= blocks.slice(0, index);
            next.push({ type: 'text', text: HISTORY_IMAGE_TEXT });
            continue;
        }
        if (block.type === 'tool-result') {
            const content = replaceHistoryImages(block.content, state);
            if (content !== block.content) {
                next ??= blocks.slice(0, index);
                next.push({ ...block, content });
                continue;
            }
        }
        next?.push(block);
    }
    return next ?? blocks;
}
/**
 * Request-time degradation for text-only models receiving resent history:
 * an image on the LATEST user message means this turn itself carries vision
 * input and stays untouched (the caller gates capability and throws), while
 * images from EARLIER turns become a pointer back at the visual model's own
 * analysis. Returns undefined when nothing needed replacing, so the caller
 * keeps the image serialization path.
 */
export function messagesWithoutHistoryImages(messages) {
    let latestUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            latestUserIndex = i;
            break;
        }
    }
    const state = { replaced: 0 };
    const next = messages.map((message, index) => {
        if (message.role !== 'user' || index >= latestUserIndex)
            return message;
        const content = replaceHistoryImages(message.content, state);
        return content === message.content ? message : { ...message, content };
    });
    return state.replaced > 0 ? next : undefined;
}
