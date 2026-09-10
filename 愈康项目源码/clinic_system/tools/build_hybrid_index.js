const fs = require('fs');
const path = require('path');

const { LocalRagClient } = require('../src/services/localRagClient');
const { buildIndex, indexStatus } = require('../src/services/hybridKnowledgeService');

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

function buildChunks(sourcePath, limit = 0) {
    const rows = fs.readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const chunks = [];
    for (const row of rows) {
        for (const text of splitText(row.text)) chunks.push({ book: row.book, page: row.page, text });
        if (limit && chunks.length >= limit) break;
    }
    return { sourceRows: rows.length, chunks: limit ? chunks.slice(0, limit) : chunks };
}

async function buildHybridIndex(options = {}) {
    const sourcePath = path.resolve(options.sourcePath || path.join(__dirname, '..', 'data', 'pharmacopoeia_texts.jsonl'));
    const dbPath = path.resolve(options.dbPath || path.join(__dirname, '..', 'data', 'knowledge_index.db'));
    const limit = Number(options.limit) || 0;
    const { sourceRows, chunks: selected } = buildChunks(sourcePath, limit);
    const tempRoot = process.env.YUKONG_TEMP_DIR || 'D:\\CodexTemp';
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tempPath = path.join(tempRoot, `yukang-hybrid-input-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(tempPath, selected.map(row => JSON.stringify(row)).join('\n'), 'utf8');
    try {
        const result = await buildIndex({
            sourcePath: tempPath,
            dbPath,
            ragClient: new LocalRagClient({ baseUrl: options.url }),
            batchSize: Number(options.batchSize) || 32,
            concurrency: Number(options.concurrency) || 1,
            onProgress: options.onProgress,
        });
        const status = await indexStatus(dbPath);
        return { ...result, sourceRows, chunks: selected.length, status };
    } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const result = await buildHybridIndex({
        sourcePath: args.source,
        dbPath: args.db,
        url: args.url,
        batchSize: args.batch,
        concurrency: args.concurrency,
        limit: args.limit,
        onProgress: (done, total) => console.log(`indexed ${done}/${total}`),
    });
    console.log(JSON.stringify(result, null, 2));
}

module.exports = { parseArgs, splitText, buildChunks, buildHybridIndex };

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
