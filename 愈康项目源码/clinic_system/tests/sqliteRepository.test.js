const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TEST_ROOT = process.env.YUKANG_TEST_ROOT
    || (fs.existsSync('D:\\') ? 'D:\\CodexTemp\\yukang-v4-tests' : path.join(os.tmpdir(), 'yukang-v4-tests'));

function makeCaseDir(name) {
    const dir = path.join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function removeCaseDir(dir) {
    const resolvedRoot = path.resolve(TEST_ROOT);
    const resolvedDir = path.resolve(dir);
    if (!resolvedDir.startsWith(resolvedRoot + path.sep)) throw new Error('拒绝清理测试根目录之外的路径');
    fs.rmSync(resolvedDir, { recursive: true, force: true });
}

test('首次启动导入旧 JSON，且重复初始化不重复写入', async () => {
    const dir = makeCaseDir('migration');
    try {
        fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
            { username: 'legacy', password: 'plain123', createdAt: '2026-01-01T00:00:00.000Z' }
        ]), 'utf8');
        fs.mkdirSync(path.join(dir, 'legacy'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'legacy', 'outpatients.json'), JSON.stringify([
            { id: 7, name: '迁移患者', status: '已就诊' }
        ]), 'utf8');

        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir);

        await repo.initRootStorage();
        const users = await repo.readUsers();
        assert.equal(users.length, 1);
        assert.equal(users[0].username, 'legacy');
        assert.equal(users[0].password, 'plain123');

        const outpatients = await repo.readCollection('legacy', 'outpatients');
        assert.deepEqual(outpatients, [{ id: 7, name: '迁移患者', status: '已就诊' }]);

        await repo.initRootStorage();
        assert.equal((await repo.readUsers()).length, 1);
        assert.equal((await repo.readCollection('legacy', 'outpatients')).length, 1);

        const db = new DatabaseSync(path.join(dir, 'clinic.db'));
        const migration = db.prepare("SELECT value FROM meta WHERE key = 'legacy_json_migrated_at'").get();
        db.close();
        assert.ok(migration && migration.value);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});

test('业务集合可写入、读取，并在重开后保持', async () => {
    const dir = makeCaseDir('roundtrip');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        let repo = createRepository(dir);
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'drugInventory', [{ id: 1, name: '阿莫西林', stock: 10 }]);
        repo.close();

        repo = createRepository(dir);
        await repo.initRootStorage();
        assert.deepEqual(await repo.readCollection('alice', 'drugInventory'), [
            { id: 1, name: '阿莫西林', stock: 10 }
        ]);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});

test('备份是独立 SQLite 快照，并按上限清理旧文件', async () => {
    const dir = makeCaseDir('backup');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir, { backupLimit: 2 });
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'settings', { warningAlert: true, autoPharmacy: false });

        const first = await repo.createBackup('test-1');
        await new Promise(resolve => setTimeout(resolve, 5));
        await repo.createBackup('test-2');
        await new Promise(resolve => setTimeout(resolve, 5));
        await repo.createBackup('test-3');

        const backups = await repo.listBackups();
        assert.equal(backups.length, 2);
        assert.ok(first.path.endsWith('.db'));
        assert.ok(backups.every(item => fs.existsSync(item.path)));

        const db = new DatabaseSync(backups[0].path);
        const row = db.prepare("SELECT data_json FROM collections WHERE username = 'alice' AND collection = 'settings'").get();
        db.close();
        assert.deepEqual(JSON.parse(row.data_json), { warningAlert: true, autoPharmacy: false });
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});

test('旧 JSON 损坏时迁移失败且不标记完成', async () => {
    const dir = makeCaseDir('bad-migration');
    try {
        fs.writeFileSync(path.join(dir, 'users.json'), '{not-json', 'utf8');
        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir);
        await assert.rejects(() => repo.initRootStorage(), /users\.json/);

        const db = new DatabaseSync(path.join(dir, 'clinic.db'));
        const migration = db.prepare("SELECT value FROM meta WHERE key = 'legacy_json_migrated_at'").get();
        db.close();
        assert.equal(migration, undefined);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});
test('跨集合事务失败时全部回滚', async () => {
    const dir = makeCaseDir('transaction');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir);
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'drugInventory', [{ id: 1, name: '原库存', stock: 5 }]);
        await repo.writeCollection('alice', 'pharmacy', [{ id: 1, status: '待发药' }]);

        await assert.rejects(() => repo.transaction(async () => {
            await repo.writeCollection('alice', 'drugInventory', [{ id: 1, name: '新库存', stock: 1 }]);
            await repo.writeCollection('alice', 'pharmacy', [{ id: 1, status: '已发药' }]);
            throw new Error('模拟业务失败');
        }), /模拟业务失败/);

        assert.deepEqual(await repo.readCollection('alice', 'drugInventory'), [{ id: 1, name: '原库存', stock: 5 }]);
        assert.deepEqual(await repo.readCollection('alice', 'pharmacy'), [{ id: 1, status: '待发药' }]);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});
test('审计链记录写入并可检测篡改', async () => {
    const dir = makeCaseDir('audit-chain');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir);
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'settings', { warningAlert: true, autoPharmacy: true });
        await repo.writeCollection('alice', 'settings', { warningAlert: false, autoPharmacy: true });

        const before = await repo.verifyAuditChain();
        assert.equal(before.valid, true);
        assert.ok(before.count >= 2);

        const db = new DatabaseSync(path.join(dir, 'clinic.db'));
        db.prepare("UPDATE audit_events SET details_json = ? WHERE id = (SELECT MIN(id) FROM audit_events)").run('{"tampered":true}');
        db.close();

        const after = await repo.verifyAuditChain();
        assert.equal(after.valid, false);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});

test('可从备份恢复完整 SQLite 数据库', async () => {
    const dir = makeCaseDir('restore');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        const repo = createRepository(dir, { backupLimit: 5 });
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'settings', { warningAlert: true, autoPharmacy: false });
        const backup = await repo.createBackup('restore-test');
        await repo.writeCollection('alice', 'settings', { warningAlert: false, autoPharmacy: true });
        assert.deepEqual(await repo.readCollection('alice', 'settings'), { warningAlert: false, autoPharmacy: true });

        const restored = await repo.restoreBackup(backup.path);
        assert.equal(restored.integrity, 'ok');
        assert.deepEqual(await repo.readCollection('alice', 'settings'), { warningAlert: true, autoPharmacy: false });
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});
test('启用本地加密后业务集合以 AES-GCM 密文保存', async () => {
    const dir = makeCaseDir('encrypted');
    try {
        const { createRepository } = require('../src/repository/sqliteRepository');
        const key = Buffer.alloc(32, 7);
        let repo = createRepository(dir, { encryptionKey: key });
        await repo.initRootStorage();
        await repo.writeUsers([{ username: 'alice', salt: 's', passwordHash: 'h', createdAt: '2026-01-01' }]);
        await repo.initUserStorage('alice');
        await repo.writeCollection('alice', 'patients', [{ id: 1, name: '张三', phone: '13800000000' }]);
        repo.close();

        const db = new DatabaseSync(path.join(dir, 'clinic.db'));
        const row = db.prepare("SELECT data_json FROM collections WHERE username = 'alice' AND collection = 'patients'").get();
        db.close();
        assert.match(row.data_json, /^enc:v1:/);
        assert.ok(!row.data_json.includes('张三'));

        repo = createRepository(dir, { encryptionKey: key });
        await repo.initRootStorage();
        assert.deepEqual(await repo.readCollection('alice', 'patients'), [{ id: 1, name: '张三', phone: '13800000000' }]);
        repo.close();
    } finally {
        removeCaseDir(dir);
    }
});
