import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url) {
        this.model_name = model_name;

        let config = {};
        config.baseURL = url || 'https://openrouter.ai/api/v1';

        const apiKey = getKey('OPENROUTER_API_KEY');
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
        }

        // Pass the API key to OpenAI compatible Api
        config.apiKey = apiKey; 

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='*') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        // Choose a valid model from openrouter.ai (for example, "openai/gpt-4o")
        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq
        };

        let res = null;
        try {
            console.log('Awaiting openrouter api response...');
            let completion = await this.openai.chat.completions.create(pack);
            if (!completion?.choices?.[0]) {
                console.error('No completion or choices returned:', completion);
                return 'No response received.';
            }
            if (completion.choices[0].finish_reason === 'length') {
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
        } catch (err) {
            console.error('Error while awaiting response:', err);
            // If the error indicates a context-length problem, we can slice the turns array, etc.
            res = 'My brain disconnected, try again.';
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageBuffers = (Array.isArray(imageBuffer) ? imageBuffer : [imageBuffer])
            .filter(buffer => Buffer.isBuffer(buffer) && buffer.length > 0);
        if (imageBuffers.length === 0)
            throw new Error('At least one non-empty image buffer is required.');

        const history = strictFormat(messages.map(message => ({ ...message })));
        const requestMessages = [
            { role: 'system', content: systemMessage },
            ...history,
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Analyze all Minecraft views together in their supplied direction order.'
                    },
                    ...imageBuffers.map(buffer => ({
                        type: 'image_url',
                        image_url: {
                            url: `data:image/jpeg;base64,${buffer.toString('base64')}`
                        }
                    }))
                ]
            }
        ];

        try {
            console.log('Awaiting openrouter vision response...');
            const completion = await this.openai.chat.completions.create({
                model: this.model_name,
                messages: requestMessages
            });
            if (!completion?.choices?.[0])
                return 'No vision response received.';
            console.log('Received.');
            return completion.choices[0].message.content;
        } catch (err) {
            console.error('Error while awaiting vision response:', err);
            return 'Vision request failed, try again.';
        }
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Openrouter.');
    }
}
