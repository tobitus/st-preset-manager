/**
 * SSE hub (PLAN §1.4). ST's compression() middleware buffers streams, so
 * every response sets `Cache-Control: no-cache, no-transform` (compression
 * honours no-transform) and calls flushHeaders(). Verified by Phase 1
 * check 3 before anything else is built on top.
 *
 * Message shape: data: {"rev": N, "kind": "slot|preset|models|shelf|warning", "origin": "<clientId>"}
 * On connect the server first sends `hello {rev, desired}`.
 */

export class EventHub {
    constructor() {
        /** @type {Set<{id: string, res: import('express').Response}>} */
        this.clients = new Set();
        /** @type {(() => void)|null} */
        this.onClientsChanged = null;
    }

    get clientCount() {
        return this.clients.size;
    }

    /**
     * @param {string} clientId
     * @param {any} res
     * @param {{ rev: number, desired: any }} hello
     */
    add(clientId, res, hello) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        this.send(res, { rev: hello.rev, kind: 'hello', desired: hello.desired });
        const client = { id: clientId, res };
        this.clients.add(client);
        this.onClientsChanged?.();
        const ping = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch { /* closed */ }
        }, 15000);
        res.on('close', () => {
            clearInterval(ping);
            this.clients.delete(client);
            this.onClientsChanged?.();
        });
    }
    /**
     * @param {any} res
     * @param {any} payload
     */
    send(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    /**
     * Broadcast to every client except `origin` (echo suppression).
     * @param {any} payload
     * @param {string|null} [origin]
     */
    broadcast(payload, origin = null) {
        for (const client of this.clients) {
            if (origin && client.id === origin) continue;
            this.send(client.res, payload);
        }
    }
}
