const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const TEST_ROOT = process.env.YUKANG_TEST_ROOT
    || (fs.existsSync('D:\\') ? 'D:\\CodexTemp\\yukang-v5-tests' : path.join(os.tmpdir(), 'yukang-v5-tests'));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function makeCaseDir(name) {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    const dir = path.join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function removeCaseDir(dir) {
    const resolvedRoot = path.resolve(TEST_ROOT);
    const resolvedDir = path.resolve(dir);
    if (!resolvedDir.startsWith(resolvedRoot + path.sep)) {
        throw new Error('拒绝清理测试根目录之外的路径');
    }
    fs.rmSync(resolvedDir, { recursive: true, force: true });
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(baseUrl, child, getOutput) {
    for (let i = 0; i < 120; i += 1) {
        if (child.exitCode !== null) throw new Error(`服务提前退出：${getOutput()}`);
        try {
            const response = await fetch(`${baseUrl}/api/server-info`);
            if (response.ok) return;
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待服务启动超时：${getOutput()}`);
}

async function startV5Server(name) {
    const dataDir = makeCaseDir(name);
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
        cwd: PROJECT_ROOT,
        env: {
            ...process.env,
            DATA_DIR: dataDir,
            PORT: String(port),
            NO_OPEN_BROWSER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(baseUrl, child, () => output);

    async function request(route, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.token) headers['x-auth-token'] = options.token;
        let body = options.body;
        if (body !== undefined && !(body instanceof Buffer) && typeof body !== 'string') {
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
            body = JSON.stringify(body);
        }
        const response = await fetch(`${baseUrl}${route}`, {
            method: options.method || 'GET',
            headers,
            body,
        });
        const text = await response.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        return { status: response.status, data, text };
    }

    async function stop() {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await Promise.race([
                new Promise(resolve => child.once('exit', resolve)),
                new Promise(resolve => setTimeout(resolve, 3000)),
            ]);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        removeCaseDir(dataDir);
    }

    return { baseUrl, dataDir, port, request, stop, output: () => output };
}

function makeValidIdCard(serial) {
    const body = `11010519900101${String(serial).padStart(3, '0').slice(-3)}`;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    return `${body}${checks[sum % 11]}`;
}

module.exports = { TEST_ROOT, makeCaseDir, removeCaseDir, startV5Server, makeValidIdCard };