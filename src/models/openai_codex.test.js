import test from 'node:test';
import assert from 'node:assert/strict';

import {
    OpenAICodex,
    createCodexVisionBody,
    isExplicitImageModalityRejection,
    readCodexSSE,
} from './openai_codex.js';

function sseResponse(text = 'visible gate') {
    const payload = [
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { content: [{ text }] } })}`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ text }] }] } })}`,
        'data: [DONE]',
        '',
    ].join('\n\n');
    return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

async function withMockedEnvironment(callback) {
    const originalFetch = globalThis.fetch;
    const originalCodexToken = process.env.CODEX_ACCESS_TOKEN;
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.CODEX_ACCESS_TOKEN = 'codex-test-token';
    delete process.env.OPENAI_API_KEY;
    try {
        await callback();
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCodexToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
        else process.env.CODEX_ACCESS_TOKEN = originalCodexToken;
        if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
}

test('vision body uses Responses input_image content with original detail for every image', () => {
    const body = createCodexVisionBody(
        'gpt-5.5',
        [{ role: 'user', content: 'stage context' }],
        'inspect',
        [Buffer.from('front'), Buffer.from('right'), Buffer.from('back'), Buffer.from('left')]
    );

    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.stream, true);
    const imageParts = body.input.at(-1).content.filter(part => part.type === 'input_image');
    assert.equal(imageParts.length, 4);
    assert.ok(imageParts.every(part => part.detail === 'original'));
    assert.ok(imageParts.every(part => part.image_url.startsWith('data:image/jpeg;base64,')));
});

test('SSE reader prefers deltas and does not duplicate terminal fallback text', async () => {
    const response = sseResponse('gate');
    assert.equal(await readCodexSSE(response.body), 'gate');
});

test('image modality rejection detection is explicit', () => {
    assert.equal(isExplicitImageModalityRejection(400, 'input_image is unsupported'), true);
    assert.equal(isExplicitImageModalityRejection(400, 'invalid request body'), false);
    assert.equal(isExplicitImageModalityRejection(500, 'vision unsupported'), false);
});

test('Codex vision request sends the expected private Responses payload', async () => {
    await withMockedEnvironment(async () => {
        const calls = [];
        globalThis.fetch = (url, options) => {
            calls.push({ url, options });
            return Promise.resolve(sseResponse('four views'));
        };
        const model = new OpenAICodex('gpt-5.5', 'https://private.example/codex', {});
        const result = await model.sendVisionRequest([], 'inspect', [Buffer.from('a'), Buffer.from('b')]);

        assert.equal(result, 'four views');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://private.example/codex/responses');
        const body = JSON.parse(calls[0].options.body);
        assert.equal(body.input.at(-1).content.filter(part => part.type === 'input_image').length, 2);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer codex-test-token');
    });
});

test('explicit private image rejection falls back once to standard Responses API', async () => {
    await withMockedEnvironment(async () => {
        process.env.OPENAI_API_KEY = 'standard-test-key';
        const calls = [];
        globalThis.fetch = (url, options) => {
            calls.push({ url, options });
            if (calls.length === 1) {
                return Promise.resolve(new Response('input_image modality is not supported', { status: 400 }));
            }
            return Promise.resolve(sseResponse('fallback view'));
        };
        const model = new OpenAICodex('gpt-5.5', 'https://private.example/codex', {});
        const result = await model.sendVisionRequest([], 'inspect', Buffer.from('image'));

        assert.equal(result, 'fallback view');
        assert.deepEqual(calls.map(call => call.url), [
            'https://private.example/codex/responses',
            'https://api.openai.com/v1/responses',
        ]);
        assert.equal(calls[1].options.headers.Authorization, 'Bearer standard-test-key');
    });
});

test('private non-modality errors never fall back and missing standard key is explicit', async () => {
    await withMockedEnvironment(async () => {
        let calls = 0;
        globalThis.fetch = () => {
            calls++;
            return Promise.resolve(new Response('invalid request body', { status: 400 }));
        };
        const model = new OpenAICodex('gpt-5.5', 'https://private.example/codex', {});
        const result = await model.sendVisionRequest([], 'inspect', Buffer.from('image'));
        assert.equal(calls, 1);
        assert.match(result, /HTTP 400/);

        globalThis.fetch = () => Promise.resolve(new Response('input_image is unsupported', { status: 400 }));
        const noFallback = await model.sendVisionRequest([], 'inspect', Buffer.from('image'));
        assert.match(noFallback, /Set OPENAI_API_KEY/);
    });
});

function eventStream(events, { open = false, cancel = () => {} } = {}) {
    return new ReadableStream({
        start(controller) {
            const text = events.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('');
            controller.enqueue(new TextEncoder().encode(text));
            if (!open) controller.close();
        }, cancel,
    });
}

test('completed SSE returns without waiting for socket close and cancels the reader', async () => {
    let cancelled = false;
    const stream = eventStream([
        { type: 'response.output_text.delta', delta: '!observeFirewater' },
        { type: 'response.completed', response: { status: 'completed' } },
    ], { open: true, cancel() { cancelled = true; } });
    assert.equal(await readCodexSSE(stream), '!observeFirewater');
    assert.equal(cancelled, true);
});

test('partial or failed streams never return an executable partial command', async () => {
    for (const terminal of [null, 'response.failed', 'response.incomplete', 'error']) {
        const events = [{ type: 'response.output_text.delta', delta: '!exploreFirewater(8)' }];
        if (terminal) events.push({ type: terminal });
        await assert.rejects(readCodexSSE(eventStream(events)), /disconnected|did not complete/);
    }
});

test('SSE handles split UTF-8 and final completion without a trailing separator', async () => {
    const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.completed',
        response: { output: [{ content: [{ text: '도착했습니다' }] }] } }));
    const stream = new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
    } });
    assert.equal(await readCodexSSE(stream), '도착했습니다');
});

test('text and vision send low effort and verbosity but keep client timeout off the wire', async t => {
    await withMockedEnvironment(async () => {
        const calls = [];
        const logs = [];
        t.mock.method(console, 'log', (...args) => logs.push(args));
        globalThis.fetch = (url, options) => {
            calls.push(JSON.parse(options.body));
            assert.ok(options.signal instanceof AbortSignal);
            return Promise.resolve(new Response(eventStream([
                { type: 'response.output_text.delta', delta: 'ok' },
                { type: 'response.completed', response: { usage: { input_tokens: 100,
                    input_tokens_details: { cached_tokens: 50 }, output_tokens: 12,
                    output_tokens_details: { reasoning_tokens: 8 } } } },
            ])));
        };
        const model = new OpenAICodex('gpt-6.1-sol', 'https://private.example/codex', {
            reasoning: { effort: 'low' }, text: { verbosity: 'low' }, timeout_ms: 1000,
        });
        assert.equal(await model.sendRequest([], 'choose'), 'ok');
        assert.equal(await model.sendVisionRequest([], 'inspect', Buffer.from('image')), 'ok');
        for (const body of calls) {
            assert.deepEqual(body.reasoning, { effort: 'low' });
            assert.deepEqual(body.text, { verbosity: 'low' });
            assert.equal(body.timeout_ms, undefined);
        }
        const metrics = logs.filter(l => l[0] === '[codex-response]').map(l => JSON.parse(l[1]));
        assert.equal(metrics.length, 2);
        for (const m of metrics) {
            assert.equal(m.reasoning_tokens, 8);
            assert.equal(m.cached_input_tokens, 50);
            assert.ok(m.total_ms >= m.first_text_ms);
            assert.equal(m.outcome, 'completed');
        }
    });
});

test('deadline aborts the transport even while waiting for the first response headers', async () => {
    await withMockedEnvironment(async () => {
        let signal;
        globalThis.fetch = (_url, options) => {
            signal = options.signal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        };
        const model = new OpenAICodex('gpt-6.1-sol', 'https://private.example/codex', { timeout_ms: 10 });
        await assert.rejects(model.sendRequest([], 'choose'), { name: 'TimeoutError' });
        assert.equal(signal.aborted, true);
    });
});

test('caller cancellation stops an open text or vision stream without fallback', async () => {
    await withMockedEnvironment(async () => {
        for (const vision of [false, true]) {
            let cancelled = false;
            let calls = 0;
            const controller = new AbortController();
            globalThis.fetch = () => {
                calls++;
                setTimeout(() => controller.abort(), 5);
                return Promise.resolve(new Response(eventStream([], { open: true, cancel() { cancelled = true; } })));
            };
            const model = new OpenAICodex('gpt-6.1-sol', 'https://private.example/codex', {});
            const options = { signal: controller.signal };
            await assert.rejects(vision ? model.sendVisionRequest([], 'inspect', Buffer.from('image'), options)
                : model.sendRequest([], 'choose', '***', options), { name: 'AbortError' });
            assert.equal(cancelled, true);
            assert.equal(calls, 1);
        }
    });
});
