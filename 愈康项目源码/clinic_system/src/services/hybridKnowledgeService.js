const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function vectorToBuffer(vector) {
    const values = Float32Array.from(vector);
    return Buffer.from(values.buffer);
}

function bufferToVector(buffer) {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function dot(left, right) {
    let score = 0;
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) score += left[i] * right[i];
    return score;
}

function rrf(rank, k = 60) {
    return rank ? 1 / (k + rank) : 0;
}

async function buildIndex({ sourcePath, dbPath, ragClient, batchSize = 32, onProgress = null }) {
    if (!ragClient) throw new Error('缺少本地 RAG 客户端');
    const rows = fs.readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
    for (const suffix of ['-wal', '-shm']) {
        const file = dbPath + suffix;
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book TEXT NOT NULL,
            page INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL
        );
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
            text,
            book,
            page,
            content='chunks',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insertChunk = db.prepare('INSERT INTO chunks (book, page, text, embedding) VALUES (?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, text, book, page) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
        let dimension = 0;
        for (let start = 0; start < rows.length; start += batchSize) {
            const batch = rows.slice(start, start + batchSize);
            const vectors = await ragClient.embed(batch.map(row => String(row.text || '')));
            for (let index = 0; index < batch.length; index++) {
                const row = batch[index];
                dimension = vectors[index].length;
                const result = insertChunk.run(String(row.book || ''), Number(row.page) || 0, String(row.text || ''), vectorToBuffer(vectors[index]));
                insertFts.run(result.lastInsertRowid, String(row.text || ''), String(row.book || ''), Number(row.page) || 0);
            }
            if (onProgress) onProgress(Math.min(start + batch.length, rows.length), rows.length);
        }
        db.prepare("INSERT INTO meta (key, value) VALUES ('dimension', ?)").run(String(dimension));
        db.prepare("INSERT INTO meta (key, value) VALUES ('chunk_count', ?)").run(String(rows.length));
        db.prepare("INSERT INTO meta (key, value) VALUES ('built_at', ?)").run(new Date().toISOString());
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        db.close();
        throw err;
    }
    db.close();
    return { dbPath, chunks: rows.length, sourcePath };
}

async function indexStatus(dbPath) {
    if (!fs.existsSync(dbPath)) return { ready: false, dbPath, chunks: 0 };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const count = db.prepare("SELECT value FROM meta WHERE key = 'chunk_count'").get();
        const dimension = db.prepare("SELECT value FROM meta WHERE key = 'dimension'").get();
        if (!count) return { ready: false, dbPath, chunks: 0, error: 'index metadata is incomplete' };
        return {
            ready: true,
            dbPath,
            chunks: Number(count && count.value) || 0,
            dimension: Number(dimension && dimension.value) || 0,
        };
    } catch (err) {
        return { ready: false, dbPath, chunks: 0, error: err.message };
    } finally {
        db.close();
    }
}

async function searchHybrid(query, options = {}) {
    const dbPath = options.dbPath;
    const ragClient = options.ragClient;
    const topK = Math.max(1, Number(options.topK) || 5);
    const candidateK = Math.max(topK, Number(options.candidateK) || 20);
    if (!dbPath || !fs.existsSync(dbPath) || !ragClient) return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const queryText = String(query || '').trim();
        const lexical = queryText.length >= 3 ? db.prepare(`
            SELECT rowid, bm25(chunks_fts) AS score
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
            ORDER BY score
            LIMIT ?
        `).all('"' + queryText.replace(/"/g, '""') + '"', candidateK) : [];

        const queryVector = Float32Array.from((await ragClient.embed([queryText]))[0]);
        const vectorCandidates = db.prepare('SELECT id, embedding FROM chunks').all()
            .map(row => ({ id: row.id, score: dot(queryVector, bufferToVector(row.embedding)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, candidateK);

        const ranks = new Map();
        lexical.forEach((row, index) => {
            const value = ranks.get(row.rowid) || { id: row.rowid, lexicalRank: 0, vectorRank: 0, lexicalScore: 0, vectorScore: 0 };
            value.lexicalRank = index + 1;
            value.lexicalScore = -Number(row.score);
            ranks.set(row.rowid, value);
        });
        vectorCandidates.forEach((row, index) => {
            const value = ranks.get(row.id) || { id: row.id, lexicalRank: 0, vectorRank: 0, lexicalScore: 0, vectorScore: 0 };
            value.vectorRank = index + 1;
            value.vectorScore = row.score;
            ranks.set(row.id, value);
        });
        const candidates = [...ranks.values()]
            .map(item => ({ ...item, fusionScore: rrf(item.lexicalRank) + rrf(item.vectorRank) }))
            .sort((a, b) => b.fusionScore - a.fusionScore)
            .slice(0, candidateK);
        if (!candidates.length) return [];

        const placeholders = candidates.map(() => '?').join(',');
        const rows = db.prepare(`SELECT id, book, page, text FROM chunks WHERE id IN (${placeholders})`).all(...candidates.map(item => item.id));
        const byId = new Map(rows.map(row => [row.id, row]));
        let ordered = candidates.map(item => ({ ...byId.get(item.id), ...item }));

        try {
            const reranked = await ragClient.rerank(queryText, ordered.map(item => item.text));
            ordered = reranked.map(item => ({ ...ordered[item.index], rerankScore: item.score }));
        } catch (_) {}

        return ordered.slice(0, topK).map(item => ({
            book: item.book,
            page: item.page,
            text: item.text,
            score: item.rerankScore !== undefined ? item.rerankScore : item.fusionScore,
            lexicalRank: item.lexicalRank,
            vectorRank: item.vectorRank,
        }));
    } finally {
        db.close();
    }
}

module.exports = {
    buildIndex,
    indexStatus,
    searchHybrid,
};
