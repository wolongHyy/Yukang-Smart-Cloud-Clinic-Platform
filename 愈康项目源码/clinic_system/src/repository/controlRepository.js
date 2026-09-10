const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, makeSalt } = require('../utils/helpers');

function nowIso() { return new Date().toISOString(); }
function randomId(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function normalizeText(value) { return String(value === undefined || value === null ? '' : value).trim(); }

function validatePhone(phone) {
    return /^1[3-9]\d{9}$/.test(phone);
}

function validateIdCard(idCard) {
    if (!/^\d{17}[\dXx]$/.test(idCard)) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    const sum = idCard.slice(0, 17).split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    return checks[sum % 11] === idCard[17].toUpperCase();
}

function assertRegistration(body) {
    const username = normalizeText(body && body.username);
    const fullName = normalizeText(body && body.fullName);
    const phone = normalizeText(body && body.phone);
    const idCard = normalizeText(body && body.idCard).toUpperCase();
    const clinicName = normalizeText(body && body.clinicName);
    const orgMode = normalizeText(body && body.orgMode);
    const storeRole = normalizeText(body && body.storeRole) || 'headquarters';
    const password = String((body && body.password) || '');
    const inviteCode = normalizeText(body && body.inviteCode).toUpperCase();

    if (fullName.length < 2 || fullName.length > 30) throw Object.assign(new Error('姓名长度需为 2-30 个字符'), { status: 400, code: 'INVALID_FULL_NAME' });
    if (!validatePhone(phone)) throw Object.assign(new Error('请输入有效的 11 位手机号'), { status: 400, code: 'INVALID_PHONE' });
    if (!validateIdCard(idCard)) throw Object.assign(new Error('请输入有效的 18 位身份证号'), { status: 400, code: 'INVALID_ID_CARD' });
    if (clinicName.length < 2 || clinicName.length > 50) throw Object.assign(new Error('诊所名称长度需为 2-50 个字符'), { status: 400, code: 'INVALID_CLINIC_NAME' });
    if (!['single', 'chain'].includes(orgMode)) throw Object.assign(new Error('请选择机构类型'), { status: 400, code: 'INVALID_ORG_MODE' });
    if (orgMode === 'chain' && !['headquarters', 'branch'].includes(storeRole)) throw Object.assign(new Error('请选择总店或分店'), { status: 400, code: 'INVALID_STORE_ROLE' });
    if (orgMode === 'chain' && storeRole === 'branch' && !inviteCode) throw Object.assign(new Error('分店注册必须填写总部邀请码'), { status: 400, code: 'INVITE_REQUIRED' });
    if (username.length < 2 || username.length > 32 || !/^[a-zA-Z0-9_]+$/.test(username)) throw Object.assign(new Error('用户名仅支持 2-32 位字母、数字和下划线'), { status: 400, code: 'INVALID_USERNAME' });
    if (password.length < 6) throw Object.assign(new Error('密码长度至少 6 位'), { status: 400, code: 'WEAK_PASSWORD' });
    if (body.privacyAccepted !== true) throw Object.assign(new Error('请阅读并同意隐私与数据使用说明'), { status: 400, code: 'PRIVACY_CONSENT_REQUIRED' });

    return { username, fullName, phone, idCard, clinicName, orgMode, storeRole: orgMode === 'single' ? 'single' : storeRole, password, inviteCode };
}

function createControlRepository(dataDir, options = {}) {
    const controlDir = path.join(path.resolve(dataDir), 'control');
    const dbPath = path.join(controlDir, 'control.db');
    let db = null;
    let encryptionKey = options.encryptionKey ? Buffer.from(options.encryptionKey) : null;

    function ensureDb() {
        if (!db) throw new Error('控制库尚未初始化');
        return db;
    }

    function normalizeKey(key) {
        if (!key) return null;
        const value = Buffer.isBuffer(key) ? key : Buffer.from(key);
        if (value.length !== 32) throw new Error('AES-256-GCM 密钥必须为 32 字节');
        return value;
    }

    function encrypt(value) {
        if (!encryptionKey) return String(value || '');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
    }

    function decrypt(value) {
        if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
        if (!encryptionKey) throw new Error('控制库已加密，但当前未提供本地数据密钥');
        const [, , ivText, tagText, encryptedText] = value.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64'));
        decipher.setAuthTag(Buffer.from(tagText, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
    }

    function hashIdCard(idCard) {
        return crypto.createHash('sha256').update(String(idCard).toUpperCase()).digest('hex');
    }

    function createSchema() {
        ensureDb().exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner_username TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS clinics (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                name TEXT NOT NULL,
                store_role TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT,
                salt TEXT,
                password_hash TEXT,
                full_name TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                id_card_enc TEXT NOT NULL DEFAULT '',
                id_card_last4 TEXT NOT NULL DEFAULT '',
                id_card_hash TEXT NOT NULL,
                org_id TEXT NOT NULL,
                clinic_id TEXT NOT NULL,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_login_at TEXT,
                FOREIGN KEY (org_id) REFERENCES organizations(id),
                FOREIGN KEY (clinic_id) REFERENCES clinics(id)
            );
            DROP INDEX IF EXISTS idx_users_phone;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone <> '';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id_card_hash ON users(id_card_hash);
            CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
            CREATE INDEX IF NOT EXISTS idx_users_clinic ON users(clinic_id);
            CREATE TABLE IF NOT EXISTS invites (
                code_hash TEXT PRIMARY KEY,
                code_hint TEXT NOT NULL,
                org_id TEXT NOT NULL,
                clinic_id TEXT NOT NULL,
                created_by TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at TEXT,
                used_by TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
                FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_invites_clinic ON invites(clinic_id, used_at);
        `);
    }

    function transaction(fn) {
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

    async function init(key) {
        if (key) encryptionKey = normalizeKey(key);
        fs.mkdirSync(controlDir, { recursive: true });
        if (!db) db = new DatabaseSync(dbPath);
        createSchema();
        return { database: dbPath, encryption: encryptionKey ? 'aes-256-gcm' : 'off' };
    }

    function publicUser(row) {
        if (!row) return null;
        return {
            username: row.username,
            fullName: row.full_name,
            phone: row.phone,
            idCardLast4: row.id_card_last4,
            orgId: row.org_id,
            clinicId: row.clinic_id,
            role: row.role,
            createdAt: row.created_at,
            lastLoginAt: row.last_login_at || null,
        };
    }

    function getUserDirect(username) {
        return ensureDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    }

    function getUser(username) {
        return publicUser(getUserDirect(username));
    }

    function getAllUsers() {
        return ensureDb()
            .prepare('SELECT * FROM users ORDER BY created_at ASC, username ASC')
            .all()
            .map(publicUser);
    }

    function getRawUser(username) {
        return getUserDirect(username) || null;
    }

    function getClinic(clinicId) {
        const row = ensureDb().prepare('SELECT id, org_id, name, store_role, created_at FROM clinics WHERE id = ?').get(clinicId);
        return row ? { id: row.id, orgId: row.org_id, name: row.name, storeRole: row.store_role, createdAt: row.created_at } : null;
    }

    function listClinics(orgId) {
        return ensureDb().prepare('SELECT id, org_id, name, store_role, created_at FROM clinics WHERE org_id = ? ORDER BY created_at ASC').all(orgId)
            .map(row => ({ id: row.id, orgId: row.org_id, name: row.name, storeRole: row.store_role, createdAt: row.created_at }));
    }

    function registerAccount(body) {
        const input = assertRegistration(body || {});
        const database = ensureDb();
        return transaction(() => {
            if (database.prepare('SELECT username FROM users WHERE username = ?').get(input.username)) {
                throw Object.assign(new Error('该用户名已被注册'), { status: 409, code: 'USERNAME_TAKEN' });
            }
            if (database.prepare('SELECT username FROM users WHERE phone = ?').get(input.phone)) {
                throw Object.assign(new Error('该手机号已被注册'), { status: 409, code: 'PHONE_TAKEN' });
            }
            const idHash = hashIdCard(input.idCard);
            if (database.prepare('SELECT username FROM users WHERE id_card_hash = ?').get(idHash)) {
                throw Object.assign(new Error('该身份证号已被注册'), { status: 409, code: 'ID_CARD_TAKEN' });
            }

            let orgId;
            let clinicId;
            let role;
            let storeName = input.clinicName;

            if (input.orgMode === 'chain' && input.storeRole === 'branch') {
                const invite = database.prepare('SELECT * FROM invites WHERE code_hash = ?').get(crypto.createHash('sha256').update(input.inviteCode).digest('hex'));
                if (!invite) throw Object.assign(new Error('邀请码无效'), { status: 400, code: 'INVALID_INVITE' });
                if (invite.used_at) throw Object.assign(new Error('邀请码已使用'), { status: 409, code: 'INVITE_USED' });
                if (new Date(invite.expires_at).getTime() <= Date.now()) throw Object.assign(new Error('邀请码已过期'), { status: 410, code: 'INVITE_EXPIRED' });
                const headquarters = database.prepare('SELECT id, name FROM clinics WHERE id = ? AND org_id = ? AND store_role = ?').get(invite.clinic_id, invite.org_id, 'headquarters');
                if (!headquarters) throw Object.assign(new Error('邀请码对应的总店无效'), { status: 400, code: 'INVALID_INVITE_CLINIC' });
                orgId = invite.org_id;
                clinicId = randomId('clinic');
                role = 'branch_member';
                storeName = input.clinicName;
                database.prepare('INSERT INTO clinics (id, org_id, name, store_role, created_at) VALUES (?, ?, ?, ?, ?)').run(clinicId, orgId, storeName, 'branch', nowIso());
                database.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ?').run(nowIso(), input.username, invite.code_hash);
            } else {
                orgId = randomId('org');
                clinicId = randomId('clinic');
                role = input.orgMode === 'chain' ? 'org_owner' : 'owner';
                const storeRole = input.orgMode === 'chain' ? 'headquarters' : 'single';
                const timestamp = nowIso();
                database.prepare('INSERT INTO organizations (id, name, owner_username, created_at) VALUES (?, ?, ?, ?)').run(orgId, input.clinicName, input.username, timestamp);
                database.prepare('INSERT INTO clinics (id, org_id, name, store_role, created_at) VALUES (?, ?, ?, ?, ?)').run(clinicId, orgId, storeName, storeRole, timestamp);
            }

            const salt = makeSalt();
            const timestamp = nowIso();
            database.prepare(`
                INSERT INTO users
                    (username, password, salt, password_hash, full_name, phone, id_card_enc, id_card_last4, id_card_hash, org_id, clinic_id, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                input.username,
                null,
                salt,
                hashPassword(input.password, salt),
                input.fullName,
                input.phone,
                encrypt(input.idCard),
                input.idCard.slice(-4),
                idHash,
                orgId,
                clinicId,
                role,
                timestamp,
            );

            return { status: 201, user: publicUser(getUserDirect(input.username)), clinic: getClinic(clinicId) };
        });
    }

    function login(username, password) {
        const row = getUserDirect(username);
        if (!row) throw Object.assign(new Error('用户名或密码错误'), { status: 401, code: 'INVALID_CREDENTIALS' });
        const supplied = String(password || '');
        const matches = row.password_hash
            ? row.password_hash === hashPassword(supplied, row.salt || '')
            : row.password !== null && row.password !== undefined && row.password === supplied;
        if (!matches) throw Object.assign(new Error('用户名或密码错误'), { status: 401, code: 'INVALID_CREDENTIALS' });
        if (!row.password_hash) {
            const salt = makeSalt();
            ensureDb().prepare('UPDATE users SET salt = ?, password_hash = ?, password = NULL WHERE username = ?').run(salt, hashPassword(supplied, salt), row.username);
        }
        ensureDb().prepare('UPDATE users SET last_login_at = ? WHERE username = ?').run(nowIso(), row.username);
        return { data: { success: true, user: publicUser(getUserDirect(row.username)) } };
    }

    function createInvite(input) {
        const orgId = normalizeText(input && input.orgId);
        const clinicId = normalizeText(input && input.clinicId);
        const createdBy = normalizeText(input && input.createdBy);
        const clinic = getClinic(clinicId);
        if (!clinic || clinic.orgId !== orgId || clinic.storeRole !== 'headquarters') {
            throw Object.assign(new Error('只有连锁总店可以生成分店邀请码'), { status: 403, code: 'INVITE_FORBIDDEN' });
        }
        const code = `YK-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        ensureDb().prepare(`
            INSERT INTO invites (code_hash, code_hint, org_id, clinic_id, created_by, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(codeHash, code.slice(-6), orgId, clinicId, createdBy, expiresAt, nowIso());
        return { code, expiresAt, clinicId, orgId };
    }

    function migrateLegacyUsers(users) {
        if (!Array.isArray(users) || users.length === 0) return { migrated: [] };
        const migrated = [];
        transaction(() => {
            for (const user of users) {
                const username = normalizeText(user.username);
                if (!username || getUserDirect(username)) continue;
                const orgId = randomId('legacy_org');
                const clinicId = randomId('legacy_clinic');
                const timestamp = user.createdAt || nowIso();
                const displayName = `${username} 的诊所`;
                ensureDb().prepare('INSERT INTO organizations (id, name, owner_username, created_at) VALUES (?, ?, ?, ?)').run(orgId, displayName, username, timestamp);
                ensureDb().prepare('INSERT INTO clinics (id, org_id, name, store_role, created_at) VALUES (?, ?, ?, ?, ?)').run(clinicId, orgId, displayName, 'single', timestamp);
                ensureDb().prepare(`
                    INSERT INTO users
                        (username, password, salt, password_hash, full_name, phone, id_card_enc, id_card_last4, id_card_hash, org_id, clinic_id, role, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    username,
                    user.password || null,
                    user.salt || null,
                    user.passwordHash || null,
                    username,
                    '',
                    '',
                    '',
                    crypto.createHash('sha256').update(`legacy:${username}`).digest('hex'),
                    orgId,
                    clinicId,
                    'owner',
                    timestamp,
                );
                migrated.push({ username, orgId, clinicId, legacy: true });
            }
        });
        return { migrated };
    }

    async function close() {
        if (db) {
            try { db.close(); } catch (_) {}
            db = null;
        }
    }

    return {
        DB_FILE: dbPath,
        init,
        close,
        registerAccount,
        login,
        getUser,
        getAllUsers,
        getRawUser,
        getClinic,
        listClinics,
        createInvite,
        migrateLegacyUsers,
        validateIdCard,
    };
}

module.exports = { createControlRepository, validateIdCard };