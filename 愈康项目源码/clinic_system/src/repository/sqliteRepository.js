const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
let DatabaseSync;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
    throw new Error('当前 Node.js 不支持内置 SQLite，请升级到 Node.js 22.5 及以上版本');
}

const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'clinic_database');

const COLLECTIONS = {
    registrations:    { type: 'array', default: [] },
    outpatients:      { type: 'array', default: [] },
    pharmacy:         { type: 'array', default: [] },
    revenue:          { type: 'array', default: [] },
    billing:          { type: 'array', default: [] },
    settings:         { type: 'object', default: { warningAlert: false, autoPharmacy: true } },
    drugInventory:    { type: 'array', default: [] },
    drugInRecords:    { type: 'array', default: [] },
    drugOutRecords:   { type: 'array', default: [] },
    suppliers:        { type: 'array', default: [] },
    medicalTemplates: { type: 'array', default: [] },
    patients:         { type: 'array', default: [] },
    drugKnowledge:    { type: 'array', default: [] },
    userFormulas:     { type: 'array', default: [] },
    aiLogs:           { type: 'array', default: [] },
    inventoryChecks:  { type: 'array', default: [] },
    recordTerms:      { type: 'object', default: {} }
};

function nowIso() {
    return new Date().toISOString();
}

function cloneDefault(collection) {
    return JSON.parse(JSON.stringify(COLLECTIONS[collection].default));
}

function sqlString(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function dateStamp(date = new Date()) {
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function dayKey(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function assertCollection(collection) {
    if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, collection)) {
        throw new Error(`未知数据集合: ${collection}`);
    }
}

function normalizeUser(user) {
    return {
        username: String(user && user.username || '').trim(),
        password: user && user.password !== undefined ? String(user.password) : null,
        salt: user && user.salt !== undefined ? String(user.salt) : null,
        passwordHash: user && user.passwordHash !== undefined ? String(user.passwordHash) : null,
        createdAt: user && user.createdAt ? String(user.createdAt) : nowIso()
    };
}

function createRepository(dataDir = DEFAULT_DATA_DIR, options = {}) {
    const rootDir = path.resolve(dataDir);
    const dbPath = path.join(rootDir, 'clinic.db');
    const backupDir = path.join(rootDir, 'backups');
    const migrationDir = path.join(rootDir, 'migrations');
    const backupLimit = Math.max(1, Number(options.backupLimit) || 30);
    const storageUser = options.storageUser ? String(options.storageUser).trim() : null;
    const txContext = new AsyncLocalStorage();
    let encryptionKey = options.encryptionKey ? Buffer.from(options.encryptionKey) : null;

    let db = null;
    let initialized = false;
    let initPromise = null;
    let backupTimer = null;
    let backupSequence = 0;
    let dbQueue = Promise.resolve();
    const initializedUsers = new Set();

    function ensureDb() {
        if (!db) throw new Error('SQLite 仓储尚未初始化，请先调用 initRootStorage()');
        return db;
    }

    function withDbLock(work) {
        const run = dbQueue.then(work);
        dbQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    function transactionSync(fn) {
        const database = ensureDb();
        database.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            database.exec('COMMIT');
            return result;
        } catch (err) {
            try { database.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    }

    async function transaction(fn) {
        if (txContext.getStore() && txContext.getStore().active) return fn();
        return withDbLock(async () => {
            const database = ensureDb();
            database.exec('BEGIN IMMEDIATE');
            try {
                const result = await txContext.run({ active: true }, fn);
                database.exec('COMMIT');
                return result;
            } catch (err) {
                try { database.exec('ROLLBACK'); } catch (_) {}
                throw err;
            }
        });
    }

    function createSchema() {
        const database = ensureDb();
        database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT,
                salt TEXT,
                password_hash TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collections (
                username TEXT NOT NULL,
                collection TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (username, collection),
                FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL DEFAULT '',
                collection TEXT NOT NULL,
                action TEXT NOT NULL,
                resource_id TEXT NOT NULL DEFAULT '',
                details_json TEXT NOT NULL,
                previous_hash TEXT NOT NULL,
                event_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_audit_events_username_id
                ON audit_events(username, id);
        `);
    }

    function normalizeEncryptionKey(key) {
        if (!key) return null;
        const value = Buffer.isBuffer(key) ? key : Buffer.from(key);
        if (value.length !== 32) throw new Error('AES-256-GCM 密钥必须为 32 字节');
        return value;
    }

    function encryptPayload(value) {
        if (!encryptionKey) return value;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
    }

    function decryptPayload(value) {
        if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
        if (!encryptionKey) throw new Error('数据库已加密，但当前未提供本地数据密钥');
        const [, , ivText, tagText, encryptedText] = value.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
    }

    function encryptExistingCollections() {
        if (!encryptionKey) return 0;
        const rows = ensureDb().prepare('SELECT username, collection, data_json FROM collections').all();
        const update = ensureDb().prepare('UPDATE collections SET data_json = ?, updated_at = ? WHERE username = ? AND collection = ?');
        let changed = 0;
        transactionSync(() => {
            for (const row of rows) {
                if (row.data_json.startsWith('enc:v1:')) continue;
                update.run(encryptPayload(row.data_json), nowIso(), row.username, row.collection);
                changed++;
            }
        });
        return changed;
    }
    function canonicalJson(value) {
        if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
        if (value && typeof value === 'object') {
            return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
        }
        return JSON.stringify(value);
    }

    function appendAuditDirect(username, collection, action, resourceId = '', details = {}) {
        const database = ensureDb();
        const previous = database.prepare('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1').get();
        const previousHash = previous ? previous.event_hash : '';
        const createdAt = nowIso();
        const payload = {
            username: username || '',
            collection,
            action,
            resourceId,
            details,
            previousHash,
            createdAt,
        };
        const eventHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
        database.prepare(`
            INSERT INTO audit_events
                (username, collection, action, resource_id, details_json, previous_hash, event_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            username || '',
            collection,
            action,
            resourceId,
            JSON.stringify(details || {}),
            previousHash,
            eventHash,
            createdAt,
        );
        return eventHash;
    }

    function writeMigrationReport(report) {        fs.mkdirSync(migrationDir, { recursive: true });
        const file = path.join(migrationDir, `legacy-import-${dateStamp()}.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
        return file;
    }

    function importLegacyJson() {
        const database = ensureDb();
        const done = database.prepare("SELECT value FROM meta WHERE key = 'legacy_json_migrated_at'").get();
        if (done) return { skipped: true };

        const usersFile = path.join(rootDir, 'users.json');
        let legacyUsers = [];
        if (fs.existsSync(usersFile)) {
            try {
                legacyUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            } catch (err) {
                throw new Error(`读取 users.json 失败，旧数据未迁移：${err.message}`);
            }
            if (!Array.isArray(legacyUsers)) throw new Error('读取 users.json 失败：根节点必须是数组');
        }

        const normalizedUsers = legacyUsers.map(normalizeUser).filter(user => user.username);
        const userSet = new Set(normalizedUsers.map(user => user.username));
        const imported = { users: 0, collections: 0, skippedCollections: 0 };

        transactionSync(() => {
            const insertUser = database.prepare(`
                INSERT INTO users (username, password, salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    password = COALESCE(users.password, excluded.password),
                    salt = COALESCE(users.salt, excluded.salt),
                    password_hash = COALESCE(users.password_hash, excluded.password_hash)
            `);
            for (const user of normalizedUsers) {
                const result = insertUser.run(user.username, user.password, user.salt, user.passwordHash, user.createdAt);
                imported.users += result.changes || 0;
                initializedUsers.add(user.username);
            }

            const insertCollection = database.prepare(`
                INSERT OR IGNORE INTO collections (username, collection, data_json, updated_at)
                VALUES (?, ?, ?, ?)
            `);
            for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
                if (!dirent.isDirectory() || !userSet.has(dirent.name)) continue;
                for (const collection of Object.keys(COLLECTIONS)) {
                    const file = path.join(rootDir, dirent.name, `${collection}.json`);
                    if (!fs.existsSync(file)) continue;
                    let data;
                    try {
                        data = JSON.parse(fs.readFileSync(file, 'utf8'));
                    } catch (err) {
                        throw new Error(`读取旧数据 ${dirent.name}/${collection}.json 失败：${err.message}`);
                    }
                    const result = insertCollection.run(dirent.name, collection, JSON.stringify(data), nowIso());
                    if (result.changes) imported.collections++;
                    else imported.skippedCollections++;
                }
            }

            database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_json_migrated_at', ?)").run(nowIso());
            database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
        });

        const report = {
            migratedAt: nowIso(),
            source: usersFile,
            imported,
            note: '旧 JSON 文件只读导入且未删除，确认 SQLite 稳定后可手动归档。'
        };
        report.reportFile = writeMigrationReport(report);
        return report;
    }

    async function initRootStorage() {
        if (initialized) return;
        if (initPromise) return initPromise;
        initPromise = Promise.resolve().then(() => {
            fs.mkdirSync(rootDir, { recursive: true });
            db = new DatabaseSync(dbPath);
            createSchema();
            importLegacyJson();
            initialized = true;
        }).finally(() => {
            initPromise = null;
        });
        return initPromise;
    }

    function readUsersDirect() {
        const rows = ensureDb().prepare(`
            SELECT username, password, salt, password_hash, created_at
            FROM users ORDER BY created_at ASC, username ASC
        `).all();
        return rows.map(row => {
            const user = { username: row.username };
            if (row.password !== null && row.password !== undefined) user.password = row.password;
            if (row.salt !== null && row.salt !== undefined) user.salt = row.salt;
            if (row.password_hash !== null && row.password_hash !== undefined) user.passwordHash = row.password_hash;
            if (row.created_at) user.createdAt = row.created_at;
            return user;
        });
    }

    async function readUsers() {
        if (!initialized) await initRootStorage();
        const work = () => readUsersDirect();
        if (txContext.getStore() && txContext.getStore().active) return work();
        return withDbLock(work);
    }

    function writeUsersDirect(users) {
        const database = ensureDb();
        const normalized = (users || []).map(normalizeUser).filter(user => user.username);
        const upsert = database.prepare(`
            INSERT INTO users (username, password, salt, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                password = excluded.password,
                salt = excluded.salt,
                password_hash = excluded.password_hash,
                created_at = excluded.created_at
        `);
        for (const user of normalized) {
            upsert.run(user.username, user.password, user.salt, user.passwordHash, user.createdAt);
        }
        const usernames = normalized.map(user => user.username);
        initializedUsers.clear();
        if (!usernames.length) {
            database.prepare('DELETE FROM users').run();
            return;
        }
        const placeholders = usernames.map(() => '?').join(',');
        database.prepare(`DELETE FROM users WHERE username NOT IN (${placeholders})`).run(...usernames);
        appendAuditDirect('', 'users', 'write', '', { count: normalized.length });
    }

    async function writeUsers(users) {
        if (!initialized) await initRootStorage();
        return transaction(() => writeUsersDirect(users));
    }

    function ensureUserStorageDirect(username) {
        const owner = storageUser || username;
        if (initializedUsers.has(owner)) return;
        const database = ensureDb();
        let user = database.prepare('SELECT username FROM users WHERE username = ?').get(owner);
        if (!user && storageUser) {
            database.prepare(`
                INSERT INTO users (username, password, salt, password_hash, created_at)
                VALUES (?, NULL, NULL, NULL, ?)
            `).run(owner, nowIso());
            user = database.prepare('SELECT username FROM users WHERE username = ?').get(owner);
        }
        if (!user) throw new Error(`用户不存在: ${owner}`);
        const insert = database.prepare(`
            INSERT OR IGNORE INTO collections (username, collection, data_json, updated_at)
            VALUES (?, ?, ?, ?)
        `);
        for (const collection of Object.keys(COLLECTIONS)) {
            insert.run(owner, collection, JSON.stringify(cloneDefault(collection)), nowIso());
        }
        initializedUsers.add(owner);
        appendAuditDirect(owner, '__all__', 'initialize', '', { collections: Object.keys(COLLECTIONS).length });
    }

    async function initUserStorage(username) {
        if (!initialized) await initRootStorage();
        return transaction(() => ensureUserStorageDirect(username));
    }

    function readCollectionDirect(username, collection) {
        assertCollection(collection);
        const owner = storageUser || username;
        const row = ensureDb().prepare('SELECT data_json FROM collections WHERE username = ? AND collection = ?').get(owner, collection);
        if (!row) {
            ensureUserStorageDirect(owner);
            writeCollectionDirect(owner, collection, cloneDefault(collection));
            return cloneDefault(collection);
        }
        return JSON.parse(decryptPayload(row.data_json));
    }

    async function readCollection(username, collection) {
        if (!initialized) await initRootStorage();
        const work = () => readCollectionDirect(username, collection);
        if (txContext.getStore() && txContext.getStore().active) return work();
        return withDbLock(work);
    }

    function writeCollectionDirect(username, collection, data) {
        assertCollection(collection);
        const database = ensureDb();
        const owner = storageUser || username;
        const user = database.prepare('SELECT username FROM users WHERE username = ?').get(owner);
        if (!user) throw new Error(`用户不存在: ${owner}`);
        const updatedAt = nowIso();
        database.prepare(`
            INSERT INTO collections (username, collection, data_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username, collection) DO UPDATE SET
                data_json = excluded.data_json,
                updated_at = excluded.updated_at
        `).run(owner, collection, encryptPayload(JSON.stringify(data)), updatedAt);
        appendAuditDirect(owner, collection, 'write', '', {
            type: Array.isArray(data) ? 'array' : typeof data,
            count: Array.isArray(data) ? data.length : Object.keys(data || {}).length,
        });
    }

    async function writeCollection(username, collection, data) {
        if (!initialized) await initRootStorage();
        const work = () => writeCollectionDirect(username, collection, data);
        if (txContext.getStore() && txContext.getStore().active) return work();
        return withDbLock(work);
    }

    function createBackupDirect(reason = 'manual') {
        fs.mkdirSync(backupDir, { recursive: true });
        backupSequence = (backupSequence + 1) % 1000;
        const safeReason = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'manual';
        const file = path.join(backupDir, `yukang-${dateStamp()}-${String(backupSequence).padStart(3, '0')}-${safeReason}.db`);
        ensureDb().exec(`VACUUM INTO ${sqlString(file.replace(/\\/g, '/'))}`);
        const stat = fs.statSync(file);
        ensureDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_backup_at', ?)").run(nowIso());
        pruneBackups();
        return { path: file, filename: path.basename(file), size: stat.size, createdAt: stat.mtime.toISOString(), reason: safeReason };
    }

    async function createBackup(reason = 'manual') {
        if (!initialized) await initRootStorage();
        if (txContext.getStore() && txContext.getStore().active) throw new Error('不能在数据库事务中执行 VACUUM 备份');
        return withDbLock(() => createBackupDirect(reason));
    }

    function pruneBackups() {
        const files = fs.readdirSync(backupDir)
            .filter(name => name.endsWith('.db'))
            .map(name => {
                const file = path.join(backupDir, name);
                return { file, time: fs.statSync(file).mtimeMs };
            })
            .sort((a, b) => b.time - a.time);
        for (const item of files.slice(backupLimit)) {
            const resolved = path.resolve(item.file);
            if (!resolved.startsWith(path.resolve(backupDir) + path.sep)) throw new Error(`拒绝删除备份目录之外的文件: ${resolved}`);
            fs.unlinkSync(resolved);
        }
    }

    async function restoreBackup(backupPath) {
        if (!initialized) await initRootStorage();
        const resolvedBackup = path.resolve(backupPath);
        const resolvedBackupRoot = path.resolve(backupDir) + path.sep;
        if (!resolvedBackup.startsWith(resolvedBackupRoot) || !fs.existsSync(resolvedBackup)) {
            throw new Error('备份文件必须位于 backups 目录内且真实存在');
        }
        return withDbLock(() => {
            const preRestore = createBackupDirect('pre-restore');
            const currentDb = ensureDb();
            currentDb.close();
            db = null;
            try {
                fs.copyFileSync(resolvedBackup, dbPath);
                for (const suffix of ['-wal', '-shm']) {
                    const file = dbPath + suffix;
                    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
                }
                db = new DatabaseSync(dbPath);
                createSchema();
                const integrity = ensureDb().prepare('PRAGMA integrity_check').get();
                if (!integrity || integrity.integrity_check !== 'ok') {
                    throw new Error('恢复后的数据库完整性检查失败');
                }
                initializedUsers.clear();
                initialized = true;
                return {
                    restoredFrom: resolvedBackup,
                    preRestoreBackup: preRestore.path,
                    integrity: integrity.integrity_check,
                };
            } catch (err) {
                try {
                    if (db) db.close();
                    fs.copyFileSync(preRestore.path, dbPath);
                    for (const suffix of ['-wal', '-shm']) {
                        const file = dbPath + suffix;
                        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
                    }
                    db = new DatabaseSync(dbPath);
                    createSchema();
                    initialized = true;
                } catch (_) {
                    db = null;
                    initialized = false;
                }
                throw err;
            }
        });
    }

    async function listAuditEvents(username, limit = 200) {
        if (!initialized) await initRootStorage();
        return withDbLock(() => {
            const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
            const rows = username
                ? ensureDb().prepare('SELECT id, username, collection, action, resource_id, details_json, previous_hash, event_hash, created_at FROM audit_events WHERE username = ? ORDER BY id DESC LIMIT ?').all(username, capped)
                : ensureDb().prepare('SELECT id, username, collection, action, resource_id, details_json, previous_hash, event_hash, created_at FROM audit_events ORDER BY id DESC LIMIT ?').all(capped);
            return rows.map(row => ({ ...row, details: JSON.parse(row.details_json) }));
        });
    }

    async function verifyAuditChain() {
        if (!initialized) await initRootStorage();
        return withDbLock(() => {
            const rows = ensureDb().prepare(
                'SELECT id, username, collection, action, resource_id, details_json, previous_hash, event_hash, created_at FROM audit_events ORDER BY id ASC'
            ).all();
            let previousHash = '';
            for (const row of rows) {
                const payload = {
                    username: row.username || '',
                    collection: row.collection,
                    action: row.action,
                    resourceId: row.resource_id,
                    details: JSON.parse(row.details_json),
                    previousHash,
                    createdAt: row.created_at,
                };
                const expected = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
                if (row.previous_hash !== previousHash || row.event_hash !== expected) {
                    return { valid: false, count: rows.length, brokenAt: row.id };
                }
                previousHash = row.event_hash;
            }
            return { valid: true, count: rows.length, head: previousHash };
        });
    }

    async function listBackups() {
        if (!initialized) await initRootStorage();
        if (!fs.existsSync(backupDir)) return [];
        return fs.readdirSync(backupDir)
            .filter(name => name.endsWith('.db'))
            .map(name => {
                const file = path.join(backupDir, name);
                const stat = fs.statSync(file);
                return { path: file, filename: name, size: stat.size, createdAt: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async function ensureDailyBackup() {
        const today = dayKey();
        const backups = await listBackups();
        if (backups.some(item => dayKey(new Date(item.createdAt)) === today)) return null;
        return createBackup('daily');
    }

    function startAutoBackup(intervalMs = 6 * 60 * 60 * 1000) {
        if (backupTimer) return backupTimer;
        const run = () => ensureDailyBackup().catch(err => console.error('自动备份失败:', err));
        run();
        backupTimer = setInterval(run, intervalMs);
        backupTimer.unref();
        return backupTimer;
    }

    function getStatusDirect() {
        const database = ensureDb();
        const integrity = database.prepare('PRAGMA integrity_check').get();
        const counts = {
            users: database.prepare('SELECT COUNT(*) AS n FROM users').get().n,
            collections: database.prepare('SELECT COUNT(*) AS n FROM collections').get().n
        };
        const lastBackup = database.prepare("SELECT value FROM meta WHERE key = 'last_backup_at'").get();
        return {
            engine: 'sqlite',
            encryption: encryptionKey ? 'aes-256-gcm' : 'off',
            database: dbPath,
            dataDir: rootDir,
            backupDir,
            integrity: integrity && integrity.integrity_check,
            counts,
            lastBackupAt: lastBackup ? lastBackup.value : null,
            backupLimit
        };
    }

    async function getStatus() {
        if (!initialized) await initRootStorage();
        return withDbLock(() => getStatusDirect());
    }

    function setEncryptionKey(key) {
        encryptionKey = normalizeEncryptionKey(key);
    }

    function close() {
        if (backupTimer) {
            clearInterval(backupTimer);
            backupTimer = null;
        }
        if (db) {
            try { db.close(); } catch (_) {}
            db = null;
        }
        initializedUsers.clear();
        initialized = false;
    }

    return {
        DATA_DIR: rootDir,
        DB_FILE: dbPath,
        BACKUP_DIR: backupDir,
        COLLECTIONS,
        initRootStorage,
        readUsers,
        writeUsers,
        initUserStorage,
        readCollection,
        writeCollection,
        createBackup,
        setEncryptionKey,
        restoreBackup,
        listAuditEvents,
        verifyAuditChain,
        listBackups,
        ensureDailyBackup,
        startAutoBackup,
        getStatus,
        transaction,
        close
    };
}

const defaultRepository = createRepository(DEFAULT_DATA_DIR);
const repositoryContext = new AsyncLocalStorage();
const storeRepositories = new Map();
let activeEncryptionKey = null;

function assertStoreId(clinicId) {
    const value = String(clinicId || '').trim();
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(value)) throw new Error('门店 ID 无效');
    return value;
}

function getStoreDirectory(clinicId) {
    return path.join(DEFAULT_DATA_DIR, 'stores', assertStoreId(clinicId));
}

function getStoreRepository(clinicId) {
    const id = assertStoreId(clinicId);
    if (storeRepositories.has(id)) return storeRepositories.get(id);
    const repository = createRepository(getStoreDirectory(id), {
        encryptionKey: activeEncryptionKey,
        storageUser: '__clinic__',
        backupLimit: 60,
    });
    storeRepositories.set(id, repository);
    return repository;
}

async function initStore(clinicId) {
    const repository = getStoreRepository(clinicId);
    await repository.initRootStorage();
    await repository.initUserStorage('__clinic__');
    return repository;
}

function runWithStore(clinicId, fn) {
    const repository = getStoreRepository(clinicId);
    return repositoryContext.run({ clinicId: assertStoreId(clinicId), repository }, fn);
}

function activeRepository() {
    return repositoryContext.getStore()?.repository || defaultRepository;
}

async function readStoreCollection(clinicId, collection) {
    const repository = await initStore(clinicId);
    return repository.readCollection('__clinic__', collection);
}

async function getStoreStatus(clinicId) {
    const repository = await initStore(clinicId);
    return repository.getStatus();
}

async function getStoreAggregate(clinicId, options = {}) {
    const repository = await initStore(clinicId);
    const [outpatients, revenue, inventory, patients, pharmacy] = await Promise.all([
        repository.readCollection('__clinic__', 'outpatients'),
        repository.readCollection('__clinic__', 'revenue'),
        repository.readCollection('__clinic__', 'drugInventory'),
        repository.readCollection('__clinic__', 'patients'),
        repository.readCollection('__clinic__', 'pharmacy'),
    ]);
    const start = options.start ? new Date(options.start).getTime() : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
    const end = options.end ? new Date(options.end).getTime() : Date.now() + 86400000;
    const inRange = value => {
        const time = new Date(value).getTime();
        return Number.isFinite(time) && time >= start && time <= end;
    };
    const revenueInRange = revenue.filter(item => inRange(item.date));
    return {
        clinicId: assertStoreId(clinicId),
        database: repository.DB_FILE,
        visitCount: outpatients.filter(item => inRange(item.opDate || item.date)).length,
        patientCount: patients.length,
        revenue: +revenueInRange.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2),
        pendingBillingCount: (await repository.readCollection('__clinic__', 'billing')).filter(item => item.status === 'pending').length,
        pendingPharmacyCount: pharmacy.filter(item => item.status === '待发药').length,
        lowStockCount: inventory.filter(item => Number(item.stock || item.quantity || 0) <= Number(item.minStock || 0)).length,
        integrity: (await repository.getStatus()).integrity,
    };
}

function listStoreIds() {
    const storesDir = path.join(DEFAULT_DATA_DIR, 'stores');
    if (!fs.existsSync(storesDir)) return [];
    return fs.readdirSync(storesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{3,80}$/.test(entry.name))
        .map(entry => entry.name);
}

function setEncryptionKey(key) {
    activeEncryptionKey = normalizeModuleKey(key);
    defaultRepository.setEncryptionKey(activeEncryptionKey);
    for (const repository of storeRepositories.values()) repository.setEncryptionKey(activeEncryptionKey);
}

function normalizeModuleKey(key) {
    if (!key) return null;
    const value = Buffer.isBuffer(key) ? key : Buffer.from(key);
    if (value.length !== 32) throw new Error('AES-256-GCM 密钥必须为 32 字节');
    return value;
}

function delegate(name) {
    return (...args) => activeRepository()[name](...args);
}

function getActiveBackupDir() {
    return activeRepository().BACKUP_DIR;
}

function startAutoBackup(intervalMs) {
    defaultRepository.startAutoBackup(intervalMs);
    for (const clinicId of listStoreIds()) {
        getStoreRepository(clinicId).startAutoBackup(intervalMs);
    }
}

module.exports = {
    DATA_DIR: defaultRepository.DATA_DIR,
    DB_FILE: defaultRepository.DB_FILE,
    BACKUP_DIR: defaultRepository.BACKUP_DIR,
    COLLECTIONS: defaultRepository.COLLECTIONS,
    createRepository,
    initRootStorage: (...args) => defaultRepository.initRootStorage(...args),
    readUsers: (...args) => defaultRepository.readUsers(...args),
    writeUsers: (...args) => defaultRepository.writeUsers(...args),
    initUserStorage: (...args) => defaultRepository.initUserStorage(...args),
    readCollection: delegate('readCollection'),
    writeCollection: delegate('writeCollection'),
    createBackup: delegate('createBackup'),
    restoreBackup: delegate('restoreBackup'),
    listAuditEvents: delegate('listAuditEvents'),
    verifyAuditChain: delegate('verifyAuditChain'),
    listBackups: delegate('listBackups'),
    ensureDailyBackup: delegate('ensureDailyBackup'),
    getStatus: delegate('getStatus'),
    transaction: delegate('transaction'),
    close: () => defaultRepository.close(),
    activeRepository,
    getActiveBackupDir,
    initStore,
    runWithStore,
    readStoreCollection,
    getStoreStatus,
    getStoreAggregate,
    listStoreIds,
    setEncryptionKey,
    startAutoBackup,
};
