import { getCodexAccessToken, getCodexBaseUrl } from '../utils/codex_auth.js';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

const STANDARD_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_API_KEY = 'OPENAI_API_KEY';
const OPENAI_ORG_ID = 'OPENAI_ORG_ID';

function extractText(value) {
    if (!value)
        return '';
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map(extractText).join('');
    if (typeof value !== 'object')
        return '';

    if (typeof value.output_text === 'string')
        return value.output_text;
    if (typeof value.text === 'string')
        return value.text;
    if (typeof value.delta === 'string')
        return value.delta;
    if (value.text && typeof value.text.value === 'string')
        return value.text.value;
    if (value.content)
        return extractText(value.content);
    if (value.item)
        return extractText(value.item);
    if (value.response)
        return extractText(value.response);
    if (value.output)
        return extractText(value.output);

    return '';
}

function parseSSEMessage(rawMessage) {
    let event = '';
    const data = [];

    for (const line of rawMessage.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
        }
    }

    return {
        event,
        data: data.join('\n'),
    };
}

export function extractTextFromCodexEvent(eventName, payload) {
    const type = payload?.type || eventName;

    if (type === 'response.output_text.delta')
        return { delta: typeof payload.delta === 'string' ? payload.delta : '' };

    if (type === 'response.output_item.done')
        return { fallback: extractText(payload.item || payload) };

    if (type === 'response.completed')
        return { fallback: extractText(payload.response || payload) };

    return { delta: '', fallback: '' };
}

export async function readCodexSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let fallbackText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split(/\r?\n\r?\n/);
        buffer = messages.pop() || '';

        for (const rawMessage of messages) {
            const { event, data } = parseSSEMessage(rawMessage);
            if (!data || data === '[DONE]')
                continue;

            let payload;
            try {
                payload = JSON.parse(data);
            } catch (err) {
                continue;
            }

            const text = extractTextFromCodexEvent(event, payload);
            outputText += text.delta || '';
            if ((text.fallback || '').length >= fallbackText.length)
                fallbackText = text.fallback || fallbackText;
        }
    }

    const finalBuffer = buffer.trim();
    if (finalBuffer) {
        const { event, data } = parseSSEMessage(finalBuffer);
        if (data && data !== '[DONE]') {
            try {
                const text = extractTextFromCodexEvent(event, JSON.parse(data));
                outputText += text.delta || '';
                if ((text.fallback || '').length >= fallbackText.length)
                    fallbackText = text.fallback || fallbackText;
            } catch (err) {
                // Ignore partial or non-JSON terminal chunks.
            }
        }
    }

    return outputText || fallbackText;
}

function cloneTurns(turns) {
    return (turns || []).map(turn => ({
        ...turn,
        content: Array.isArray(turn.content)
            ? turn.content.map(part => ({ ...part }))
            : turn.content,
    }));
}

function normalizeImages(imageBuffer) {
    const images = Array.isArray(imageBuffer) ? imageBuffer : [imageBuffer];
    return images.filter(image => Buffer.isBuffer(image) && image.length > 0);
}

export function createCodexVisionBody(model, turns, systemMessage, imageBuffer, params = {}) {
    const images = normalizeImages(imageBuffer);
    if (images.length === 0)
        throw new Error('At least one non-empty image buffer is required.');

    const input = strictFormat(cloneTurns(turns));
    input.push({
        role: 'user',
        content: [
            {
                type: 'input_text',
                text: 'Analyze these Minecraft views together. Use the supplied direction order and report only visible evidence.',
            },
            ...images.map(image => ({
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
                detail: 'original',
            })),
        ],
    });

    const body = {
        model: model || 'gpt-5.5',
        instructions: systemMessage,
        input,
        stream: true,
        store: false,
    };
    if (params.reasoning)
        body.reasoning = params.reasoning;
    return body;
}

export function isExplicitImageModalityRejection(status, body = '') {
    if (![400, 404, 415, 422].includes(status)) return false;
    const normalized = String(body).toLowerCase();
    const namesImageInput = /input_image|image_url|vision|image input|image modality/.test(normalized);
    const rejectsIt = /unsupported|not supported|does not support|invalid|unknown|not allowed|cannot accept/.test(normalized);
    return namesImageInput && rejectsIt;
}

async function postStreamingResponse(baseUrl, token, body, extraHeaders = {}) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            errorBody: await response.text(),
        };
    }
    if (!response.body) {
        return {
            ok: false,
            status: response.status,
            errorBody: 'The response body was empty.',
        };
    }
    return {
        ok: true,
        status: response.status,
        text: await readCodexSSE(response.body),
    };
}

function mapCodexError(status, body) {
    if (status === 401) {
        return 'Codex OAuth expired; run `node scripts/codex-login.js` or `codex login --device-auth`.';
    }
    if (status === 429) {
        return 'ChatGPT/Codex usage limit reached.';
    }
    if (status === 400 && body.toLowerCase().includes('unsupported parameter')) {
        return `Codex backend rejected an unsupported parameter. Mindcraft sends sanitized params only; response body: ${body}`;
    }
    return `Codex backend request failed with HTTP ${status}: ${body}`;
}

export class OpenAICodex {
    static prefix = 'openai-codex';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = getCodexBaseUrl(url);
        this.params = params || {};
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        const model = this.model_name || 'gpt-5.5';
        const messages = strictFormat(turns);
        const body = {
            model,
            instructions: systemMessage,
            input: messages,
            stream: true,
            store: false,
        };

        if (this.params.reasoning)
            body.reasoning = this.params.reasoning;

        try {
            const token = getCodexAccessToken().value;
            console.log('Awaiting openai-codex response from model', model);
            const response = await postStreamingResponse(this.url, token, body);
            if (!response.ok)
                return mapCodexError(response.status, response.errorBody);

            let result = response.text;
            const stopSeqIndex = result.indexOf(stop_seq);
            result = stopSeqIndex !== -1 ? result.slice(0, stopSeqIndex) : result;
            return result || 'Codex backend returned no text.';
        } catch (err) {
            if (err?.message?.includes('Codex OAuth token not found'))
                return err.message;
            console.log(err);
            return 'Codex backend disconnected, try again.';
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const model = this.model_name || 'gpt-5.5';
        let body;
        try {
            body = createCodexVisionBody(model, messages, systemMessage, imageBuffer, this.params);
            const token = getCodexAccessToken().value;
            console.log('Awaiting openai-codex vision response from model', model);
            const privateResponse = await postStreamingResponse(this.url, token, body);
            if (privateResponse.ok)
                return privateResponse.text || 'Codex backend returned no vision text.';

            if (!isExplicitImageModalityRejection(privateResponse.status, privateResponse.errorBody)) {
                return mapCodexError(privateResponse.status, privateResponse.errorBody);
            }

            if (!hasKey(OPENAI_API_KEY)) {
                return 'Codex OAuth endpoint explicitly rejected image input, and no standard OpenAI API fallback is configured. Set OPENAI_API_KEY to enable vision fallback.';
            }

            const standardHeaders = {};
            if (hasKey(OPENAI_ORG_ID))
                standardHeaders['OpenAI-Organization'] = getKey(OPENAI_ORG_ID);
            console.warn('Codex OAuth endpoint rejected image input; retrying through the standard OpenAI Responses API.');
            const fallbackResponse = await postStreamingResponse(
                STANDARD_OPENAI_BASE_URL,
                getKey(OPENAI_API_KEY),
                body,
                standardHeaders
            );
            if (!fallbackResponse.ok) {
                return `Standard OpenAI vision fallback failed with HTTP ${fallbackResponse.status}: ${fallbackResponse.errorBody}`;
            }
            return fallbackResponse.text || 'Standard OpenAI vision fallback returned no text.';
        } catch (err) {
            if (err?.message?.includes('Codex OAuth token not found'))
                return err.message;
            console.log(err);
            return `Codex vision request failed: ${err?.message || String(err)}`;
        }
    }

    embed() {
        return Promise.reject(new Error('Embeddings are not supported by the openai-codex provider.'));
    }
}
