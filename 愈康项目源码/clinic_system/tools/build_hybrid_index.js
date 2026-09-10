const fs = require('fs');
const path = require('path');

const { LocalRagClient } = require('../src/services/localRagClient');
const { buildIndex } = require('../src/services/hybridKnowledgeService');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
    return args;
}

function splitText(text, size = 600, overlap = 90) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= size) return value ? [value] : [];
    const parts = [];
    let start = 0;
    while (start < value.length) {
        parts.push(value.slice(start, start + size));
        if (start + size >= value.length) break;
        start += size - overlap;
    }
    return parts;
}

(async () => {
    const args = parseArgs(process.argv);
    const sourcePath = path.resolve(args.source || path.join(__dirname, '..', 'data', 'pharmacopoeia_texts.jsonl'));
    const dbPath = path.resolve(args.db || path.join(__dirname, '..', 'data', 'knowledge_index.db'));
    const limit = Number(args.limit) || 0;
    const rows = fs.readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const chunks = [];
    for (const row of rows) {
        for (const text of splitText(row.text)) chunks.push({ book: row.book, page: row.page, text });
        if (limit && chunks.length >= limit) break;
    }
    const selected = limit ? chunks.slice(0, limit) : chunks;
    const tempRoot = process.env.YUKONG_TEMP_DIR || 'D:\\CodexTemp';
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempPath = path.join(tempRoot, `yukang-hybrid-input-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(tempPath, selected.map(row => JSON.stringify(row)).join('\n'), 'utf8');
    try {
        const result = await buildIndex({
            sourcePath: tempPath,
            dbPath,
            ragClient: new LocalRagClient({ baseUrl: args.url }),
            batchSize: Number(args.batch) || 32,
            onProgress: (done, total) => console.log(`indexed ${done}/${total}`),
        });
        console.log(JSON.stringify({ ...result, chunks: selected.length }, null, 2));
    } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});