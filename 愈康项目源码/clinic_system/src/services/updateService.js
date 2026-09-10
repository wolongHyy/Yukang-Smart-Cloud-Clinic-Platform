const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class UpdateError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'UpdateError';
        this.details = details;
    }
}

function resolveInside(root, relative) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relative || '.');
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new UpdateError(`更新路径越界: ${relative}`);
    }
    return resolved;
}

function validateArchiveEntries(entries) {
    for (const entry of entries || []) {
        const value = String(entry || '').replace(/\\/g, '/');
        const normalized = path.posix.normalize(value);
        if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized === '..' || normalized.startsWith('../')) {
            throw new UpdateError(`压缩包目录越界: ${entry}`);
        }
    }
    return true;
}

function runTar(args, options = {}) {
    const result = spawnSync('tar', args, {
        cwd: options.cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new UpdateError(`无法执行 tar: ${result.error.message}`);
    if (result.status !== 0) {
        throw new UpdateError(`tar 执行失败: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return result.stdout || '';
}

function extractZipArchive(zipPath, destination) {
    if (!fs.existsSync(zipPath)) throw new UpdateError(`更新包不存在: ${zipPath}`);
    const entries = runTar(['-tf', zipPath]).split(/\r?\n/).filter(Boolean);
    validateArchiveEntries(entries);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    runTar(['-xf', zipPath, '-C', destination]);
    return destination;
}

function loadManifest(stagingDir) {
    const manifestPath = path.join(stagingDir, 'update-manifest.json');
    if (!fs.existsSync(manifestPath)) throw new UpdateError('更新包缺少 update-manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new UpdateError(`update-manifest.json 不是合法 JSON: ${error.message}`);
    }
    if (!manifest || typeof manifest !== 'object') throw new UpdateError('update-manifest.json 格式无效');
    if (!Array.isArray(manifest.restart_command) || !manifest.restart_command.length) {
        throw new UpdateError('update-manifest.json 缺少 restart_command');
    }
    return manifest;
}

async function defaultRunCommand(command, cwd) {
    if (!Array.isArray(command) || !command.length) throw new UpdateError('更新命令为空');
    const result = spawnSync(command[0], command.slice(1), {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new UpdateError(`更新命令执行失败: ${result.error.message}`);
    if (result.status !== 0) {
        throw new UpdateError(`更新命令返回 ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return result;
}

async function defaultHealthCheck(healthcheck) {
    if (!healthcheck || !healthcheck.url) return true;
    const timeoutMs = Math.max(1000, Number(healthcheck.timeout_ms) || 30000);
    const intervalMs = Math.max(100, Number(healthcheck.interval_ms) || 1000);
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
        try {
            const response = await fetch(healthcheck.url, { signal: AbortSignal.timeout(Math.min(intervalMs, 3000)) });
            if (response.ok) return true;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new UpdateError(`更新健康检查超时: ${lastError ? lastError.message : 'unknown'}`);
}

function copyDirectory(source, target) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
}

async function applyRelease(options) {
    const stagingDir = path.resolve(options.stagingDir);
    const appDir = path.resolve(options.appDir);
    const runCommand = options.runCommand || defaultRunCommand;
    const healthCheck = options.healthCheck || defaultHealthCheck;
    const manifest = loadManifest(stagingDir);
    let sourceApp;
    try {
        sourceApp = resolveInside(stagingDir, manifest.app_dir || 'app');
    } catch (error) {
        throw new UpdateError(`app_dir 越界: ${manifest.app_dir || 'app'}`);
    }
    if (!fs.existsSync(sourceApp) || !fs.statSync(sourceApp).isDirectory()) {
        throw new UpdateError(`更新包 app_dir 不存在: ${manifest.app_dir || 'app'}`);
    }
    if (!fs.existsSync(appDir)) throw new UpdateError(`当前应用目录不存在: ${appDir}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${appDir}.rollback-${stamp}`;
    copyDirectory(appDir, backupPath);

    try {
        copyDirectory(sourceApp, appDir);
        if (manifest.migrate_command) await runCommand(manifest.migrate_command, appDir);
        await runCommand(manifest.restart_command, appDir);
        const healthy = await healthCheck(manifest.healthcheck);
        if (healthy === false) throw new UpdateError('更新健康检查失败');
        return { status: 'healthy', backupPath, manifest };
    } catch (error) {
        try {
            copyDirectory(backupPath, appDir);
            await runCommand(manifest.restart_command, appDir);
            return { status: 'rolled_back', backupPath, manifest, error: error.message };
        } catch (rollbackError) {
            throw new UpdateError(`更新失败且回滚失败: ${error.message}; 回滚错误: ${rollbackError.message}`, {
                backupPath,
                applyError: error.message,
                rollbackError: rollbackError.message,
            });
        }
    }
}

module.exports = {
    UpdateError,
    applyRelease,
    extractZipArchive,
    loadManifest,
    validateArchiveEntries,
};
