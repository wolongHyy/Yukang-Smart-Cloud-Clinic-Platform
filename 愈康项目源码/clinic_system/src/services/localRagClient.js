class LocalRagClient {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || process.env.YUKONG_RAG_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
        this.fetchImpl = options.fetchImpl || fetch;
        this.timeoutMs = Number(options.timeoutMs) || 120000;
    }

    async request(pathname, body) {
        const response = await this.fetchImpl(this.baseUrl + pathname, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`本地 RAG 服务请求失败: HTTP ${response.status} ${detail}`);
        }
        return response.json();
    }

    async health() {
        const response = await this.fetchImpl(this.baseUrl + '/health', {
            signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
        });
        if (!response.ok) throw new Error(`本地 RAG 服务不可用: HTTP ${response.status}`);
        return response.json();
    }

    async embed(texts) {
        const data = await this.request('/api/v1/embed', { texts });
        return data.vectors;
    }

    async rerank(query, documents) {
        const data = await this.request('/api/v1/rerank', {
            query,
            documents,
            top_k: documents.length,
        });
        return data.results;
    }
}

module.exports = { LocalRagClient };
