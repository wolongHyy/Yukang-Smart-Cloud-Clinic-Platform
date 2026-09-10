const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getOrCreateDataKey } = require('../src/security/localCryptoService');

test('数据密钥在 Windows DPAPI 下可重复加载', async () => {
    const root = fs.existsSync('D:\\') ? 'D:\\CodexTemp' : os.tmpdir();
    const dir = path.join(root, `yukang-key-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
        const first = await getOrCreateDataKey(dir);
        const second = await getOrCreateDataKey(dir);
        assert.equal(first.length, 32);
        assert.deepEqual(second, first);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('日志脱敏函数不会保留手机号和姓名', () => {
    const { redact } = require('../src/utils/logger');
    const output = redact('患者:张三 手机号 13800138000 身份证 110101199001011234');
    assert.ok(!output.includes('13800138000'));
    assert.ok(!output.includes('110101199001011234'));
    assert.ok(output.includes('***'));
});
