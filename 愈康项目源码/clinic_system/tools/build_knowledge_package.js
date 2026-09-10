const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildHybridIndex } = require('./build_hybrid_index');
const { indexStatus } = require('../src/services/hybridKnowledgeService');

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
    return args;
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let bytes;
        while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function createManifest({ sourceRows, chunks, status, model, device }) {
    return {
        format: 'yukang-knowledge-package',
        formatVersion: 1,
        model,
        device,
        sourceRows,
        chunks,
        dimension: status.dimension,
        builtAt: new Date().toISOString(),
    };
}

function createZip(stagingDir, zipPath) {
    fs.rmSync(zipPath, { force: true });
    const result = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', stagingDir, '.'], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`打包失败: ${(result.stderr || result.stdout || '').trim()}`);
}

async function buildKnowledgePackage(options = {}) {
    const outputDir = path.resolve(options.output || 'D:\\YukangKnowledge\\v5');
    const dbPath = path.join(outputDir, 'knowledge_index.db');
    const manifestPath = path.join(outputDir, 'knowledge_manifest.json');
    const zipPath = path.join(outputDir, 'knowledge-package.zip');
    const model = options.model || 'BAAI/bge-small-zh-v1.5';
    const device = options.device || 'cpu';
    fs.mkdirSync(outputDir, { recursive: true });

    let built = { sourceRows: 0, chunks: 0, status: await indexStatus(dbPath) };
    if (!options.skipBuild) {
        built = await buildHybridIndex({
            sourcePath: options.sourcePath,
            dbPath,
            url: options.url,
            batchSize: options.batchSize,
            concurrency: options.concurrency,
            limit: options.limit,
            onProgress: options.onProgress,
        });
    }
    if (!built.status || !built.status.ready) throw new Error('知识索引尚未就绪');
    const manifest = createManifest({ ...built, model, device });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const stagingDir = path.join(outputDir, 'package');
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.copyFileSync(dbPath, path.join(stagingDir, 'knowledge_index.db'));
    fs.copyFileSync(manifestPath, path.join(stagingDir, 'knowledge_manifest.json'));
    createZip(stagingDir, zipPath);
    const result = {
        ...manifest,
        dbPath,
        manifestPath,
        zipPath,
        zipSha256: sha256File(zipPath),
        zipBytes: fs.statSync(zipPath).size,
    };
    return result;
}

async function main() {
    const args = parseArgs(process.argv);
    const result = await buildKnowledgePackage({
        output: args.output,
        sourcePath: args.source,
        url: args.url,
        batchSize: args.batch,
        concurrency: args.concurrency,
        limit: args.limit,
        skipBuild: args['skip-build'] === 'true',
        model: args.model,
        device: args.device,
        onProgress: (done, total) => console.log(`indexed ${done}/${total}`),
    });
    console.log(JSON.stringify(result, null, 2));
}

module.exports = { parseArgs, sha256File, createManifest, createZip, buildKnowledgePackage };

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
