const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

function canonicalManifest(manifest) {
    return stable({
        version: manifest.version,
        artifact_url: manifest.artifact_url,
        sha256: manifest.sha256,
        min_version: manifest.min_version || '0.0.0',
    });
}

async function verifyRelease(manifest, signature, publicKeyPem, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const signatureValid = crypto.verify(
        null,
        Buffer.from(canonicalManifest(manifest)),
        publicKeyPem,
        Buffer.from(signature, 'base64'),
    );
    if (!signatureValid) throw new Error('发布签名验证失败');
    const response = await fetchImpl(manifest.artifact_url, {
        headers: options.headers || {},
    });
    if (!response.ok) throw new Error(`发布包下载失败: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (sha256 !== String(manifest.sha256).toLowerCase()) throw new Error('发布包 SHA-256 校验失败');
    return { valid: true, body, sha256 };
}

function loadEdgeAgentConfig(env = process.env) {
    const controlUrl = String(env.YUKONG_CONTROL_URL || '').replace(/\/+$/, '');
    const edgeId = String(env.YUKONG_EDGE_ID || '');
    const edgeToken = String(env.YUKONG_EDGE_TOKEN || '');
    const enabled = Boolean(controlUrl && edgeId && edgeToken);
    return {
        enabled,
        controlUrl,
        edgeId,
        edgeToken,
        clinicId: String(env.YUKONG_CLINIC_ID || ''),
        version: String(env.YUKONG_APP_VERSION || '4.0.0'),
        heartbeatSeconds: Math.max(30, Number(env.YUKONG_EDGE_HEARTBEAT_SECONDS) || 300),
        certPath: env.YUKONG_EDGE_CERT_PATH || '',
        keyPath: env.YUKONG_EDGE_KEY_PATH || '',
        caPath: env.YUKONG_EDGE_CA_PATH || '',
    };
}

class EdgeAgent {
    constructor(options = {}) {
        this.config = options.config || loadEdgeAgentConfig();
        this.dataDir = options.dataDir || path.join(process.cwd(), 'clinic_database');
        this.fetchImpl = options.fetchImpl || fetch;
        this.aggregateProvider = options.aggregateProvider || null;
        this.createSocket = options.createSocket || ((url, socketOptions) => new WebSocket(url, socketOptions));
        this.socket = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.reconnectDelayMs = 1000;
        this.stopped = true;
    }

    socketOptions() {
        const options = {};
        if (this.config.caPath) options.ca = fs.readFileSync(this.config.caPath);
        if (this.config.certPath) options.cert = fs.readFileSync(this.config.certPath);
        if (this.config.keyPath) options.key = fs.readFileSync(this.config.keyPath);
        return options;
    }

    start() {
        if (!this.config.enabled || !this.stopped) return false;
        this.stopped = false;
        this.connect();
        return true;
    }

    connect() {
        const url = `${this.config.controlUrl.replace(/^http/, 'ws')}/edge/v1/connect?edge_id=${encodeURIComponent(this.config.edgeId)}&token=${encodeURIComponent(this.config.edgeToken)}`;
        this.socket = this.createSocket(url, this.socketOptions());
        this.socket.addEventListener('open', () => {
            this.reconnectDelayMs = 1000;
            this.send({ type: 'hello', edge_id: this.config.edgeId, version: this.config.version });
        });
        this.socket.addEventListener('message', event => this.handleMessage(event.data).catch(err => {
            console.error('边缘代理消息处理失败:', err.message);
        }));
        this.socket.addEventListener('close', () => this.scheduleReconnect());
        this.socket.addEventListener('error', () => {});
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000);
    }

    send(message) {
        if (this.socket && typeof this.socket.send === 'function') {
            this.socket.send(JSON.stringify(message));
        }
    }

    async handleMessage(raw) {
        const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
        if (message.type === 'hello_ack') {
            const seconds = Number(message.heartbeat_interval_seconds) || this.config.heartbeatSeconds;
            this.startHeartbeat(seconds);
            await this.pushAggregate();
            return;
        }
        if (message.type === 'job_offer') {
            await this.handleJobOffer(message);
        }
    }

    startHeartbeat(seconds) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        const sendHeartbeat = () => this.send({
            type: 'heartbeat',
            edge_id: this.config.edgeId,
            version: this.config.version,
            sent_at: new Date().toISOString(),
        });
        sendHeartbeat();
        this.heartbeatTimer = setInterval(sendHeartbeat, seconds * 1000);
        this.heartbeatTimer.unref();
    }

    async pushAggregate() {
        if (!this.aggregateProvider || !this.config.clinicId) return;
        try {
            const now = new Date();
            const periods = [
                {
                    periodStart: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString(),
                    periodEnd: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString(),
                },
                {
                    periodStart: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0).toISOString(),
                    periodEnd: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999).toISOString(),
                },
            ];
            for (const period of periods) {
                const aggregate = await this.aggregateProvider(period);
                this.send({
                    type: 'aggregate_push',
                    aggregate: {
                        clinic_id: this.config.clinicId,
                        period_start: aggregate.periodStart,
                        period_end: aggregate.periodEnd,
                        metrics: aggregate.metrics,
                        idempotency_key: `clinic-${this.config.clinicId}-${aggregate.periodEnd}`,
                    },
                });
            }
        } catch (err) {
            console.error('生成门店聚合指标失败:', err.message);
        }
    }

    async handleJobOffer(message) {
        const job = message.job || {};
        const release = message.release || {};
        try {
            const verified = await verifyRelease(release, release.signature, release.signing_public_key, {
                fetchImpl: this.fetchImpl,
            });
            const updatesDir = path.join(this.dataDir, 'updates');
            fs.mkdirSync(updatesDir, { recursive: true });
            const packagePath = path.join(updatesDir, `yukang-${release.version}.zip`);
            fs.writeFileSync(packagePath, verified.body);
            this.send({
                type: 'job_result',
                edge_id: this.config.edgeId,
                job_id: job.id,
                status: 'verified',
                package_path: packagePath,
                sha256: verified.sha256,
            });
        } catch (err) {
            this.send({
                type: 'job_result',
                edge_id: this.config.edgeId,
                job_id: job.id,
                status: 'failed',
                failure_reason: err.message,
            });
        }
    }

    stop() {
        this.stopped = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        if (this.socket) this.socket.close();
        this.socket = null;
    }
}

let defaultAgent = null;

function startEdgeAgent(options = {}) {
    if (defaultAgent) return defaultAgent;
    defaultAgent = new EdgeAgent(options);
    defaultAgent.start();
    return defaultAgent;
}

function stopEdgeAgent() {
    if (defaultAgent) defaultAgent.stop();
    defaultAgent = null;
}

module.exports = {
    canonicalManifest,
    verifyRelease,
    loadEdgeAgentConfig,
    EdgeAgent,
    startEdgeAgent,
    stopEdgeAgent,
};
