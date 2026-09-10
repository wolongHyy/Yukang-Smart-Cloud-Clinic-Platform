const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { applyRelease, validateArchiveEntries } = require('../src/services/updateService');

const ROOT = 'D:\\CodexTemp\\yukang-update-tests';

function makeCase(name) {
    const dir = path.join(ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeApp(root, version) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'version.txt'), version, 'utf8');
}

function writeManifest(stage, overrides = {}) {
    fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
    writeApp(path.join(stage, 'app'), overrides.version || '2.0.0');
    fs.writeFileSync(path.join(stage, 'update-manifest.json'), JSON.stringify({
        version: '2.0.0',
        app_dir: 'app',
        restart_command: ['restart-app'],
        healthcheck: { url: 'http://127.0.0.1:1/health', timeout_ms: 1000, interval_ms: 50 },
        ...overrides,
    }), 'utf8');
}

test('applyRelease 成功替换应用并保留备份', async () => {
    const root = makeCase('success');
    try {
        const appDir = path.join(root, 'app');
        const stage = path.join(root, 'stage');
        writeApp(appDir, '1.0.0');
        writeManifest(stage);
        const commands = [];
        const result = await applyRelease({ stagingDir: stage, appDir, runCommand: async command => commands.push(command), healthCheck: async () => true });
        assert.equal(result.status, 'healthy');
        assert.equal(fs.readFileSync(path.join(appDir, 'version.txt'), 'utf8'), '2.0.0');
        assert.equal(fs.readFileSync(path.join(result.backupPath, 'version.txt'), 'utf8'), '1.0.0');
        assert.equal(commands.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('健康检查失败时恢复旧版本并再次重启', async () => {
    const root = makeCase('rollback');
    try {
        const appDir = path.join(root, 'app');
        const stage = path.join(root, 'stage');
        writeApp(appDir, '1.0.0');
        writeManifest(stage);
        const commands = [];
        const result = await applyRelease({ stagingDir: stage, appDir, runCommand: async command => commands.push(command), healthCheck: async () => false });
        assert.equal(result.status, 'rolled_back');
        assert.equal(fs.readFileSync(path.join(appDir, 'version.txt'), 'utf8'), '1.0.0');
        assert.equal(commands.length, 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('拒绝压缩包目录越界和应用目录越界', async () => {
    assert.doesNotThrow(() => validateArchiveEntries(['app/server.js', 'update-manifest.json']));
    assert.throws(() => validateArchiveEntries(['app/server.js', '../evil.js']), /越界/);
    const root = makeCase('escape');
    try {
        const appDir = path.join(root, 'app');
        const stage = path.join(root, 'stage');
        writeApp(appDir, '1.0.0');
        writeManifest(stage, { app_dir: '../outside' });
        await assert.rejects(applyRelease({ stagingDir: stage, appDir, runCommand: async () => {}, healthCheck: async () => true }), /app_dir/);
        assert.equal(fs.readFileSync(path.join(appDir, 'version.txt'), 'utf8'), '1.0.0');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('缺少更新清单时拒绝执行', async () => {
    const root = makeCase('manifest');
    try {
        const appDir = path.join(root, 'app');
        const stage = path.join(root, 'stage');
        writeApp(appDir, '1.0.0');
        fs.mkdirSync(stage, { recursive: true });
        await assert.rejects(applyRelease({ stagingDir: stage, appDir, runCommand: async () => {}, healthCheck: async () => true }), /update-manifest/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('extractZipArchive 可安全解压并拒绝越界路径', () => {
    const { spawnSync } = require('node:child_process');
    const { extractZipArchive } = require('../src/services/updateService');
    const root = makeCase('zip');
    try {
        const stage = path.join(root, 'stage');
        writeManifest(stage);
        const zipPath = path.join(root, 'release.zip');
        const packed = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', stage, '.'], { encoding: 'utf8' });
        assert.equal(packed.status, 0, packed.stderr);
        const extracted = path.join(root, 'extracted');
        extractZipArchive(zipPath, extracted);
        assert.equal(fs.existsSync(path.join(extracted, 'update-manifest.json')), true);
        assert.throws(() => validateArchiveEntries(['../escape.txt']), /越界/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
