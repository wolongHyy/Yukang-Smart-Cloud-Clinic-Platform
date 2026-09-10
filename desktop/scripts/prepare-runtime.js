'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const defaultSource = path.resolve(desktopRoot, '..', '愈康项目源码', 'clinic_system');
const sourceDir = path.resolve(process.env.YUKANG_SOURCE_DIR || defaultSource);
const runtimeDir = path.resolve(process.env.YUKANG_RUNTIME_DIR || path.join(desktopRoot, 'runtime'));
const targetDir = path.join(runtimeDir, 'clinic_system');
const knowledgeDb = process.env.YUKANG_KNOWLEDGE_DB ? path.resolve(process.env.YUKANG_KNOWLEDGE_DB) : '';
const version = require('../package.json').version;

function assertInside(parent, child, label) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${label} 不在允许的构建目录内: ${child}`);
    }
}

function shouldCopy(src) {
    if (src === sourceDir) return true;
    const relative = path.relative(sourceDir, src);
    const parts = relative.split(path.sep);
    const name = path.basename(src);

    if (parts.includes('node') || parts.includes('node_modules') || parts.includes('clinic_database')) return false;
    if (parts.includes('tests') || parts.includes('.pytest_cache') || parts.includes('__pycache__')) return false;
    if (name.startsWith('_backup_')) return false;
    if (name === '_hybrid_input_' || name.startsWith('_hybrid_input_')) return false;
    if (name === 'pharmacopoeia_texts.jsonl') return false;
    if (name === 'pharmacopoeia_backup_20260816.json') return false;
    if (name === 'knowledge_index.db' || name.startsWith('knowledge_index.db-')) return false;
    if (/\.(log|tmp)$/i.test(name)) return false;
    return true;
}

function sha256(file) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function main() {
    if (!fs.existsSync(path.join(sourceDir, 'server.js'))) {
        throw new Error(`未找到愈康运行源码: ${sourceDir}`);
    }
    if (!knowledgeDb || !fs.existsSync(knowledgeDb)) {
        throw new Error(`缺少完整知识库索引。请设置 YUKANG_KNOWLEDGE_DB，当前值: ${knowledgeDb || '(empty)'}`);
    }

    assertInside(desktopRoot, runtimeDir, 'runtime');
    assertInside(desktopRoot, targetDir, 'target');

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, filter: shouldCopy });

    const targetIndex = path.join(targetDir, 'data', 'knowledge_index.db');
    fs.mkdirSync(path.dirname(targetIndex), { recursive: true });
    fs.copyFileSync(knowledgeDb, targetIndex);

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const install = spawnSync(npmCommand, [
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock'
    ], {
        cwd: targetDir,
        env: { ...process.env },
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`运行依赖安装失败，退出码 ${install.status}`);

    for (const dependency of ['express', 'cors']) {
        if (!fs.existsSync(path.join(targetDir, 'node_modules', dependency))) {
            throw new Error(`运行依赖缺失: ${dependency}`);
        }
    }

    fs.renameSync(path.join(targetDir, 'node_modules'), path.join(targetDir, 'vendor'));

    const info = {
        version,
        sourceDir,
        knowledgeDb,
        knowledgeSha256: await sha256(targetIndex),
        knowledgeBytes: fs.statSync(targetIndex).size,
        builtAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(targetDir, 'RELEASE_VERSION.txt'), `${version}\n`, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    console.log(`Runtime prepared: ${targetDir}`);
    console.log(`Knowledge SHA-256: ${info.knowledgeSha256}`);
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});


