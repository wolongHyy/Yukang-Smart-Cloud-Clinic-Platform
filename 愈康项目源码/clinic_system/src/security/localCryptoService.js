const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runDpapi(mode, input) {
    const script = mode === 'protect'
        ? "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:YUKONG_DPAPI_INPUT); $o=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($o)"
        : "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:YUKONG_DPAPI_INPUT); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($o)";
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        env: { ...process.env, YUKONG_DPAPI_INPUT: input.toString('base64') },
    }).trim();
    return Buffer.from(output, 'base64');
}

function loadOrCreateFileKey(file) {
    if (fs.existsSync(file)) {
        const key = fs.readFileSync(file);
        if (key.length !== 32) throw new Error('本地数据密钥文件损坏');
        return key;
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
}

async function getOrCreateDataKey(dataDir) {
    if (process.env.YUKONG_DATA_KEY_B64) {
        const key = Buffer.from(process.env.YUKONG_DATA_KEY_B64, 'base64');
        if (key.length !== 32) throw new Error('YUKONG_DATA_KEY_B64 必须是 32 字节密钥');
        return key;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, 'device-key.dpapi');
    if (process.platform === 'win32') {
        if (fs.existsSync(keyFile)) {
            const wrapped = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
            return runDpapi('unprotect', wrapped);
        }
        const key = crypto.randomBytes(32);
        const wrapped = runDpapi('protect', key);
        fs.writeFileSync(keyFile, wrapped.toString('base64'), 'utf8');
        return key;
    }

    return loadOrCreateFileKey(path.join(dataDir, 'device-key'));
}

module.exports = {
    getOrCreateDataKey,
};
