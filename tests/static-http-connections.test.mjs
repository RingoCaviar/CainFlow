import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { startCainflowServer } from './helpers/browser-theme-fixture.mjs';

function request(baseUrl, path, agent, { method = 'GET', headers = {}, body, onData } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request(new URL(path, baseUrl), { agent, method, headers }, (response) => {
            const socket = response.socket;
            const localPort = socket.localPort;
            const chunks = [];
            response.on('data', (chunk) => {
                chunks.push(chunk);
                onData?.(chunk);
            });
            response.on('error', reject);
            response.on('end', () => resolve({
                status: response.statusCode, headers: response.headers, httpVersion: response.httpVersion,
                body: Buffer.concat(chunks), socket, localPort,
            }));
        });
        outgoing.setTimeout(3000, () => outgoing.destroy(new Error(`HTTP response did not finish: ${method} ${path}`)));
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

test('public static CSS and module requests reuse one HTTP connection without changing their bytes', { timeout: 15000 }, async (context) => {
    const server = await startCainflowServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const responses = [];
    try {
        const paths = ['/css/modules/00-foundation.css', '/js/nodes/node-view-factory.js'];
        for (let index = 0; index < 24; index += 1) {
            const path = paths[index % paths.length];
            const expected = readFileSync(new URL(`..${path}`, import.meta.url));
            const response = await request(server.baseUrl, `${path}?connection-check=${index}`, agent);
            responses.push(response);
            assert.equal(response.status, 200, path);
            assert.equal(Number(response.headers['content-length']), expected.length, path);
            assert.deepEqual(response.body, expected, path);
            assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.body), expected.toString('utf8'), path);
            assert.match(response.headers['content-type'], path.endsWith('.css') ? /text\/css/ : /text\/javascript/);
            assert.equal(response.headers['access-control-allow-origin'], '*');
            assert.equal(response.headers['cache-control'], 'public, max-age=0, must-revalidate');
        }
        const socketCount = new Set(responses.map((response) => response.socket)).size;
        const portCount = new Set(responses.map((response) => response.localPort)).size;
        context.diagnostic(`${responses.length} static requests used ${socketCount} TCP sockets and ${portCount} local ports; HTTP ${[...new Set(responses.map((response) => response.httpVersion))].join(', ')}`);
        assert.equal(socketCount, 1, 'sequential static assets should use the keep-alive agent connection');
        assert.equal(portCount, 1);
        assert.ok(responses.every((response) => response.httpVersion === '1.1'));
    } finally {
        agent.destroy();
        await server.stop();
    }
});

test('public proxy and media streams retain close-delimited incremental responses and upstream errors', { timeout: 15000 }, async () => {
    const server = await startCainflowServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const firstChunk = Buffer.alloc(64 * 1024, 'x');
    Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]).copy(firstChunk);
    const tail = Buffer.from('\n受控流结束\n', 'utf8');
    const upstreamError = Buffer.from('{"error":"controlled upstream failure"}');
    let pendingStream;
    const upstream = http.createServer((incoming, outgoing) => {
        incoming.resume();
        if (incoming.url === '/error') {
            outgoing.writeHead(418, { 'Content-Type': 'application/json', 'Content-Length': upstreamError.length });
            outgoing.end(upstreamError);
            return;
        }
        outgoing.writeHead(200, { 'Content-Type': incoming.url === '/video.mp4' ? 'video/mp4' : 'text/event-stream' });
        pendingStream = outgoing;
        outgoing.write(firstChunk);
        // Finish only after the public client receives bytes through CainFlow.
        // Buffering the entire upstream body would deadlock and hit the timeout.
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const targetBase = `http://127.0.0.1:${upstream.address().port}`;
    try {
        const staticBefore = await request(server.baseUrl, '/css/modules/00-foundation.css', agent);
        for (const kind of ['proxy', 'download']) {
            const target = `${targetBase}/${kind === 'download' ? 'video.mp4' : 'stream'}`;
            let receivedIncrementally = false;
            const response = await request(server.baseUrl, kind === 'proxy' ? '/proxy' : `/api/media/download?url=${encodeURIComponent(target)}`, agent, {
                method: kind === 'proxy' ? 'POST' : 'GET',
                headers: kind === 'proxy' ? { 'x-target-url': target, 'x-target-method': 'GET', 'x-proxy-enabled': 'false', 'Content-Length': '0' } : {},
                onData() {
                    if (!receivedIncrementally) {
                        receivedIncrementally = true;
                        pendingStream.end(tail);
                    }
                },
            });
            assert.equal(receivedIncrementally, true, kind);
            assert.equal(response.status, 200, kind);
            assert.equal(response.headers.connection, 'close', kind);
            assert.equal(response.headers['content-length'], undefined, kind);
            assert.equal(response.headers['transfer-encoding'], undefined, kind);
            assert.deepEqual(response.body, Buffer.concat([firstChunk, tail]), kind);
            const next = await request(server.baseUrl, '/css/modules/00-foundation.css', agent);
            assert.notEqual(next.socket, response.socket, kind);
            assert.deepEqual(next.body, staticBefore.body, kind);
        }
        const error = await request(server.baseUrl, '/proxy', agent, {
            method: 'POST',
            headers: { 'x-target-url': `${targetBase}/error`, 'x-target-method': 'GET', 'x-proxy-enabled': 'false', 'Content-Length': '0' },
        });
        assert.equal(error.status, 418);
        assert.equal(error.headers.connection, 'close');
        assert.deepEqual(error.body, upstreamError);
        const invalid = await request(server.baseUrl, '/proxy', agent, { method: 'POST', headers: { 'Content-Length': '0' } });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.headers.connection, 'close');
        assert.equal(Number(invalid.headers['content-length']), invalid.body.length);
        assert.equal(JSON.parse(invalid.body).error, 'Missing x-target-url header');
    } finally {
        pendingStream?.destroy();
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
        agent.destroy();
        await server.stop();
    }
});

test('public multipart downloads and interrupted proxy streams still close their connections', { timeout: 15000 }, async () => {
    const server = await startCainflowServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const video = Buffer.alloc(2 * 1024 * 1024 + 31, 'v');
    Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]).copy(video);
    const ranges = [];
    const activeStreams = new Set();
    let abortUpstreamClosed;
    const upstreamAborted = new Promise((resolve) => { abortUpstreamClosed = resolve; });
    const upstream = http.createServer((incoming, outgoing) => {
        incoming.resume();
        activeStreams.add(outgoing);
        outgoing.once('close', () => activeStreams.delete(outgoing));
        if (incoming.url === '/abort') {
            outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
            outgoing.write(video.subarray(0, 64 * 1024));
            const interval = setInterval(() => outgoing.write(video.subarray(0, 64 * 1024)), 20);
            outgoing.once('close', () => { clearInterval(interval); abortUpstreamClosed(); });
            return;
        }
        const range = incoming.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
        if (range) {
            const start = Number(range[1]), end = Number(range[2]);
            ranges.push([start, end]);
            outgoing.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${video.length}` });
            outgoing.end(video.subarray(start, end + 1));
            return;
        }
        outgoing.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length, 'Accept-Ranges': 'bytes' });
        outgoing.flushHeaders();
        // A slow first read selects the existing multipart path. CainFlow then
        // closes this initial response and obtains the exact bytes with ranges.
        const timer = setTimeout(() => outgoing.write(video.subarray(0, 64 * 1024)), 150);
        outgoing.once('close', () => clearTimeout(timer));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const targetBase = `http://127.0.0.1:${upstream.address().port}`;
    let abortTimeout;
    try {
        const download = await request(server.baseUrl, `/api/media/download?url=${encodeURIComponent(`${targetBase}/video.mp4`)}`, agent);
        assert.equal(download.status, 200);
        assert.equal(download.headers.connection, 'close');
        assert.equal(Number(download.headers['content-length']), video.length);
        assert.deepEqual(download.body, video);
        assert.deepEqual(ranges.sort((left, right) => left[0] - right[0]), [
            [0, 1024 * 1024 - 1], [1024 * 1024, 2 * 1024 * 1024 - 1], [2 * 1024 * 1024, video.length - 1],
        ]);
        await new Promise((resolve, reject) => {
            let aborted = false;
            const outgoing = http.request(new URL('/proxy', server.baseUrl), {
                agent, method: 'POST', headers: { 'x-target-url': `${targetBase}/abort`, 'x-target-method': 'GET', 'x-proxy-enabled': 'false', 'Content-Length': '0' },
            }, (response) => {
                assert.equal(response.headers.connection, 'close');
                response.once('data', () => { aborted = true; outgoing.destroy(); resolve(); });
                response.on('error', (error) => { if (!aborted) reject(error); });
            });
            outgoing.setTimeout(3000, () => outgoing.destroy(new Error('proxy did not send the first streaming chunk')));
            outgoing.on('error', (error) => { if (!aborted) reject(error); });
            outgoing.end();
        });
        await Promise.race([
            upstreamAborted,
            new Promise((_, reject) => { abortTimeout = setTimeout(() => reject(new Error('client disconnect did not close the proxy upstream')), 3000); }),
        ]);
        const afterAbort = await request(server.baseUrl, '/css/modules/00-foundation.css', agent);
        assert.equal(afterAbort.status, 200);
        assert.notEqual(afterAbort.socket, download.socket);
    } finally {
        clearTimeout(abortTimeout);
        for (const stream of activeStreams) stream.destroy();
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
        agent.destroy();
        await server.stop();
    }
});

test('empty static responses finish before the next request and API errors still close the connection', { timeout: 15000 }, async () => {
    const server = await startCainflowServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
        const staticPath = '/css/modules/00-foundation.css';
        const first = await request(server.baseUrl, staticPath, agent);
        const options = await request(server.baseUrl, '/unregistered-static-path', agent, { method: 'OPTIONS' });
        assert.equal(options.status, 200);
        assert.equal(options.headers['content-length'], '0');
        assert.equal(options.body.length, 0);
        const noise = await request(server.baseUrl, '/favicon.ico', agent);
        assert.equal(noise.status, 404);
        assert.equal(noise.headers['content-length'], '0');
        assert.equal(noise.body.length, 0);
        const redirect = await request(server.baseUrl, '/js', agent);
        assert.equal(redirect.status, 301);
        assert.equal(redirect.headers.location, '/js/');
        assert.equal(redirect.headers['content-length'], '0');
        assert.equal(redirect.body.length, 0);
        const head = await request(server.baseUrl, staticPath, agent, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers['content-length'], first.headers['content-length']);
        assert.equal(head.body.length, 0);
        const unchanged = await request(server.baseUrl, staticPath, agent, { headers: { 'If-Modified-Since': first.headers['last-modified'] } });
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.body.length, 0);
        const last = await request(server.baseUrl, staticPath, agent);
        for (const response of [options, noise, redirect, head, unchanged, last]) {
            assert.equal(response.socket, first.socket, `${response.status} response must leave the next static request readable`);
        }
        const unknownApi = await request(server.baseUrl, '/api/unknown-http-connection-test', agent);
        assert.equal(unknownApi.status, 404);
        assert.equal(unknownApi.headers.connection, 'close');
        assert.equal(Number(unknownApi.headers['content-length']), unknownApi.body.length);
        assert.equal(JSON.parse(unknownApi.body).success, false);
        const afterApi = await request(server.baseUrl, staticPath, agent);
        assert.notEqual(afterApi.socket, unknownApi.socket);
        assert.deepEqual(afterApi.body, first.body);
        for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
            const response = await request(server.baseUrl, '/api/unknown-http-connection-test', agent, { method, headers: { 'Content-Length': '0' } });
            assert.equal(response.status, method === 'OPTIONS' ? 200 : 404, method);
            assert.equal(response.headers.connection, 'close', method);
            assert.equal(Number(response.headers['content-length']), response.body.length, method);
            if (method === 'OPTIONS') assert.equal(response.body.length, 0);
        }
        const missingStatic = await request(server.baseUrl, '/missing-http-connection-test.css', agent);
        assert.equal(missingStatic.status, 404);
        assert.equal(missingStatic.headers.connection, 'close');
        assert.equal(Number(missingStatic.headers['content-length']), missingStatic.body.length);
        const afterMissing = await request(server.baseUrl, staticPath, agent);
        assert.notEqual(afterMissing.socket, missingStatic.socket);
        assert.deepEqual(afterMissing.body, first.body);
    } finally {
        agent.destroy();
        await server.stop();
    }
});
