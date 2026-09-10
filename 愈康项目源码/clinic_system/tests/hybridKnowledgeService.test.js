const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildIndex, searchHybrid, indexStatus } = require('../src/services/hybridKnowledgeService');

class FakeRagClient {
    async embed(texts) {
        return texts.map(text => text.includes('咳嗽') ? [1, 0] : [0, 1]);
    }
    async rerank(query, documents) {
        return documents.map((document, index) => ({ index, score: document.includes('咳嗽') ? 1 : 0.1 }));
    }
}

test('构建本地混合索引并返回向量相关结果', async () => {
    const root = fs.existsSync('D:\\') ? 'D:\\CodexTemp' : os.tmpdir();
    const dir = path.join(root, `yukang-hybrid-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
        const source = path.join(dir, 'chunks.jsonl');
        const dbPath = path.join(dir, 'knowledge_index.db');
        const rows = [
            { book: '药典', page: 1, text: '咳嗽发热常用解表药物' },
            { book: '药典', page: 2, text: '腹痛腹泻常用调理药物' },
            { book: '药典', page: 3, text: '高血压患者应规律监测血压' },
        ];
        fs.writeFileSync(source, rows.map(row => JSON.stringify(row)).join('\n'), 'utf8');
        const client = new FakeRagClient();

        const built = await buildIndex({ sourcePath: source, dbPath, ragClient: client, batchSize: 2 });
        assert.equal(built.chunks, 3);

        const status = await indexStatus(dbPath);
        assert.equal(status.ready, true);
        assert.equal(status.chunks, 3);

        const results = await searchHybrid('咳嗽怎么办', { dbPath, ragClient: client, topK: 2, candidateK: 3 });
        assert.equal(results.length, 2);
        assert.match(results[0].text, /咳嗽/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});