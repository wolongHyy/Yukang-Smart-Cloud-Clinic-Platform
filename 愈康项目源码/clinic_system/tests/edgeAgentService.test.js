const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
    canonicalManifest,
    verifyRelease,
    loadEdgeAgentConfig,
    EdgeAgent,
} = require('../src/services/edgeAgentService');

test('发布清单签名和 SHA-256 可验证', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const body = Buffer.from('signed release package');
    const manifest = {
        version: '4.1.0',
        artifact_url: 'https://example.com/yukang-4.1.0.zip',
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        min_version: '4.0.0',
    };
    const signature = crypto.sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

    const result = await verifyRelease(manifest, signature, publicPem, {
        fetchImpl: async () => new Response(body, { status: 200 }),
    });
    assert.equal(result.valid, true);
    assert.equal(result.body.toString(), body.toString());
});

test('代理配置缺少凭据时保持禁用', () => {
    const config = loadEdgeAgentConfig({});
    assert.equal(config.enabled, false);
});

test('WebSocket 代理发送 hello 和心跳消息', async () => {
    const sent = [];
    class FakeSocket {
        constructor() { this.listeners = {}; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        send(value) { sent.push(JSON.parse(value)); }
        close() { this.closed = true; }
        emit(name, event) { this.listeners[name]?.(event); }
    }
    const socket = new FakeSocket();
    const agent = new EdgeAgent({
        config: {
            enabled: true,
            controlUrl: 'wss://control.example.com',
            edgeId: 'edge-1',
            edgeToken: 'token-1',
            clinicId: 'clinic-1',
            version: '4.0.0',
            heartbeatSeconds: 300,
        },
        createSocket: () => socket,
        fetchImpl: async () => new Response('ok'),
        dataDir: 'D:\\CodexTemp\\yukong-edge-test',
        aggregateProvider: async () => ({
            periodStart: '2026-09-09T00:00:00Z',
            periodEnd: '2026-09-09T23:59:59Z',
            metrics: { visit_count: 2 },
        }),
    });
    agent.start();
    socket.emit('open', {});
    assert.equal(sent[0].type, 'hello');
    socket.emit('message', { data: JSON.stringify({ type: 'hello_ack', heartbeat_interval_seconds: 60 }) });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(sent.some(message => message.type === 'heartbeat'));
    assert.ok(sent.some(message => message.type === 'aggregate_push'));
    agent.stop();
});
test('Edge 更新任务执行升级并回报终态', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const body = Buffer.from('upgrade-package');
    const manifest = {
        version: '4.2.0',
        artifact_url: 'https://example.com/yukang-4.2.0.zip',
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        min_version: '4.0.0',
    };
    const signature = crypto.sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const sent = [];
    let received = null;
    const agent = new EdgeAgent({
        config: {
            enabled: true,
            controlUrl: 'wss://control.example.com',
            edgeId: 'edge-update',
            edgeToken: 'token-update',
            clinicId: 'clinic-update',
            version: '4.0.0',
            heartbeatSeconds: 300,
            appDir: 'D:\\CodexTemp\\yukong-update-app',
        },
        createSocket: () => new (require('node:events').EventTarget)(),
        fetchImpl: async () => new Response(body, { status: 200 }),
        dataDir: 'D:\\CodexTemp\\yukong-edge-update',
        updateApplier: async options => {
            received = options;
            return { status: 'healthy', backupPath: 'D:\\CodexTemp\\backup' };
        },
    });
    agent.socket = { send: value => sent.push(JSON.parse(value)), close() {} };

    await agent.handleJobOffer({
        job: { id: 'job-update-1', status: 'pending', attempts: 0 },
        release: { ...manifest, signature, signing_public_key: publicPem },
    });

    assert.equal(received.appDir, 'D:\\CodexTemp\\yukong-update-app');
    assert.match(received.zipPath, /yukang-4\.2\.0\.zip$/);
    assert.deepEqual(sent.map(item => item.status), ['verified', 'applying', 'healthy']);
});
