#!/usr/bin/env node
/**
 * Mock OpenAI-compatible LLM for the st-pm-dev container (PLAN §3).
 *   GET  /v1/models            -> {data:[{id:"mock"}]}
 *   POST /v1/chat/completions  -> stores the body, answers a fixed completion
 *                                 (streaming SSE when stream:true)
 *   GET  /last                 -> the last stored request body
 * Zero deps. Port 8099 on 127.0.0.1.
 */
import http from 'node:http';

/** @type {any|null} */
let last = null;

const COMPLETION = 'Mock reply from st-pm mock-llm.';

/** @param {any} body */
function completionResponse(body) {
    const id = 'chatcmpl-mock';
    const created = Math.floor(Date.now() / 1000);
    if (body?.stream) {
        const chunks = [
            'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }], }),
            'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'mock', choices: [{ index: 0, delta: { content: COMPLETION }, finish_reason: null }], }),
            'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], }),
            'data: [DONE]',
        ];
        return chunks.join('\n\n') + '\n\n';
    }
    return JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: body?.model ?? 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: COMPLETION }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model', owned_by: 'st-pm-mock' }] }));
        return;
    }
    if (req.method === 'GET' && url.pathname === '/last') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(last ?? { error: 'no request captured yet' }));
        return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                last = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                last = { error: 'unparseable body' };
            }
            const streaming = !!last?.stream;
            res.writeHead(200, {
                'Content-Type': streaming ? 'text/event-stream' : 'application/json',
                'Cache-Control': 'no-cache, no-transform',
            });
            res.end(completionResponse(last));
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `no route ${req.method} ${url.pathname}` }));
});

server.listen(8099, '127.0.0.1', () => {
    console.log('[mock-llm] listening on http://127.0.0.1:8099');
});
