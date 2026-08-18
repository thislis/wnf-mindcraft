const USAGE = `Usage:
  npm run test:firewater:vision-live:oauth
  npm run test:firewater:vision-live:api

This is an opt-in, billable live vision check. It sends exactly one request to
the selected endpoint and is intentionally excluded from test:firewater.`;

function fail(message) {
    throw new Error(`${message}\n\n${USAGE}`);
}

function assertJpeg(buffer) {
    const isJpeg = Buffer.isBuffer(buffer)
        && buffer.length > 4
        && buffer[0] === 0xff
        && buffer[1] === 0xd8
        && buffer.at(-2) === 0xff
        && buffer.at(-1) === 0xd9;
    if (!isJpeg)
        throw new Error('The generated 64x64 fixture is not a valid JPEG byte stream.');
}

async function createFixture() {
    const { createCanvas } = await import('canvas');
    const canvas = createCanvas(64, 64);
    const context = canvas.getContext('2d');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = '#e53935';
    context.fillRect(4, 4, 24, 56);
    context.fillStyle = '#1e88e5';
    context.beginPath();
    context.arc(46, 32, 14, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#111111';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(4, 60);
    context.lineTo(60, 4);
    context.stroke();

    const jpeg = canvas.toBuffer('image/jpeg', {
        quality: 0.92,
        chromaSubsampling: false,
    });
    assertJpeg(jpeg);
    return jpeg;
}

async function getEndpoint(mode) {
    if (mode === 'oauth') {
        const { getCodexAccessToken, getCodexBaseUrl } = await import('../src/utils/codex_auth.js');
        let credential;
        try {
            credential = getCodexAccessToken();
        } catch (error) {
            fail(`OAuth credential unavailable: ${error.message}`);
        }
        return {
            label: 'Codex OAuth',
            url: `${getCodexBaseUrl().replace(/\/+$/, '')}/responses`,
            headers: { Authorization: `Bearer ${credential.value}` },
        };
    }

    const { getKey, hasKey } = await import('../src/utils/keys.js');
    if (!hasKey('OPENAI_API_KEY'))
        fail('OPENAI_API_KEY is required for api mode.');

    const headers = { Authorization: `Bearer ${getKey('OPENAI_API_KEY')}` };
    if (hasKey('OPENAI_ORG_ID'))
        headers['OpenAI-Organization'] = getKey('OPENAI_ORG_ID');
    return {
        label: 'OpenAI API',
        url: 'https://api.openai.com/v1/responses',
        headers,
    };
}

async function main() {
    const mode = process.argv[2];
    if (!['oauth', 'api'].includes(mode) || process.argv.length !== 3)
        fail('Choose exactly one credential mode: oauth or api.');

    const [{ createCodexVisionBody, readCodexSSE }, jpeg, endpoint] = await Promise.all([
        import('../src/models/openai_codex.js'),
        createFixture(),
        getEndpoint(mode),
    ]);
    const body = createCodexVisionBody(
        'gpt-5.5',
        [],
        'This is a live transport check. Briefly identify the dominant colors and geometric shapes visible in the supplied image.',
        jpeg
    );

    // Deliberately issue one request only: this diagnostic has no retry or fallback.
    const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
            ...endpoint.headers,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorBody = (await response.text()).trim() || '<empty response body>';
        throw new Error(`${endpoint.label} live vision check failed: HTTP ${response.status} ${response.statusText}: ${errorBody}`);
    }
    if (!response.body)
        throw new Error(`${endpoint.label} live vision check failed: HTTP ${response.status} returned no response body.`);

    const text = (await readCodexSSE(response.body)).trim();
    if (!text)
        throw new Error(`${endpoint.label} live vision check failed: HTTP ${response.status} returned no nonempty vision text.`);

    console.log(`PASS: ${endpoint.label} returned nonempty vision text from one request.`);
    console.log(text);
}

try {
    await main();
} catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
}
