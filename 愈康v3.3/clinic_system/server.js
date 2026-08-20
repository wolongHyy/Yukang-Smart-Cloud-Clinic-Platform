// ============================================================
//  愈康云诊所 - 服务器端（v3.2）
//  - 修复静态目录泄露：不再暴露 clinic_database / server.js 等文件
//  - 会话令牌认证（x-auth-token），密码哈希存储（兼容旧明文账号自动迁移）
//  - 统一日期解析（兼容 2026/8/3、2026/08/03、带时间戳等格式）
//  - 新增事务化接诊接口 /api/visits/complete，避免多模块写入中途失败丢数据
//  - 发药扣库存增加库存校验，统计口径修正
//  - v3.2 新增：药典/方剂知识库（本草典 v1 + 公开说明书）、AI 辅助开方与审方、
//    患者档案自动归拢、库存盘点、增强统计（处方量/毛利/复诊率）
// ============================================================
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const knowledge = require('./knowledge');
const ai = require('./ai');

const app = express();
const PORT = Number(process.env.PORT) || 3002;

function getLANIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (!iface.internal && (iface.family === 'IPv4' || iface.family === 4)) {
                if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
                    return iface.address;
                }
            }
        }
    }
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (!iface.internal && (iface.family === 'IPv4' || iface.family === 4)) return iface.address;
        }
    }
    return '127.0.0.1';
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'clinic_database');
const BASE_DIR = __dirname;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话 30 天滑动有效
const sessions = new Map(); // token -> { username, createdAt }

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.endsWith('.html') || req.path === '/' || req.path === '') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

const COLLECTIONS = {
    registrations:   { type: 'array',  default: [] },
    outpatients:     { type: 'array',  default: [] },
    pharmacy:        { type: 'array',  default: [] },
    revenue:         { type: 'array',  default: [] },
    settings:        { type: 'object', default: { warningAlert: false, autoPharmacy: true } },
    drugInventory:   { type: 'array',  default: [] },
    drugInRecords:   { type: 'array',  default: [] },
    drugOutRecords:  { type: 'array',  default: [] },
    suppliers:       { type: 'array',  default: [] },
    medicalTemplates:{ type: 'array',  default: [] },
    patients:        { type: 'array',  default: [] },
    drugKnowledge:   { type: 'array',  default: [] },
    userFormulas:    { type: 'array',  default: [] },
    aiLogs:          { type: 'array',  default: [] },
    inventoryChecks: { type: 'array',  default: [] },
    recordTerms:     { type: 'object', default: {} }
};

const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ==================== 存储初始化与读写 ====================
async function initRootStorage() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        try { await fs.access(USERS_FILE); } catch {
            await fs.writeFile(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
        }
    } catch (err) {
        console.error('初始化根存储失败:', err);
        process.exit(1);
    }
}

async function readUsers() {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(raw);
}

async function writeUsers(users) {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function getUserDir(username) {
    return path.join(DATA_DIR, username);
}

async function initUserStorage(username) {
    const userDir = getUserDir(username);
    await fs.mkdir(userDir, { recursive: true });
    for (const [name, meta] of Object.entries(COLLECTIONS)) {
        const filePath = path.join(userDir, `${name}.json`);
        try { await fs.access(filePath); } catch {
            await fs.writeFile(filePath, JSON.stringify(meta.default, null, 2), 'utf8');
        }
    }
}

async function readCollection(username, collection) {
    const filePath = path.join(getUserDir(username), `${collection}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
}

async function writeCollection(username, collection, data) {
    const filePath = path.join(getUserDir(username), `${collection}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newId() {
    return Date.now() + Math.floor(Math.random() * 10000);
}

function toNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// ==================== 日期工具（统一口径） ====================
function parseDate(d) {
    if (d === null || d === undefined || d === '') return null;
    if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
    const s = String(d).trim();
    // 支持 2026/8/3、2026/08/03、2026-08-03、2026/8/7 20:42:49、2026-08-07T20:42:49 等
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) {
        const dt = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        return isNaN(dt.getTime()) ? null : dt;
    }
    const t = new Date(s);
    return isNaN(t.getTime()) ? null : t;
}

// 统一日期键：YYYY/MM/DD（两位补零），所有业务比较都走它
function toDateKey(d) {
    const dt = parseDate(d);
    if (!dt) return null;
    return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
}

function todayKey() {
    return toDateKey(new Date());
}

// ==================== 密码哈希与会话认证 ====================
function makeSalt() {
    return crypto.randomBytes(8).toString('hex');
}

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(String(salt) + ':' + String(password)).digest('hex');
}

function issueToken(username) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, createdAt: Date.now() });
    return token;
}

async function authMiddleware(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ error: '未登录，请先登录' });
    const session = sessions.get(token);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    session.createdAt = Date.now(); // 滑动续期
    try {
        const users = await readUsers();
        const user = users.find(u => u.username === session.username);
        if (!user) return res.status(401).json({ error: '用户不存在，请重新登录' });
        await initUserStorage(session.username);
        req.currentUser = session.username;
        next();
    } catch (err) {
        res.status(500).json({ error: '身份验证失败' });
    }
}

// ==================== 认证接口 ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
        if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度需 2-20 个字符' });
        if (password.length < 4) return res.status(400).json({ error: '密码长度至少 4 位' });
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: '用户名仅支持字母、数字、下划线' });

        const users = await readUsers();
        if (users.find(u => u.username === username)) return res.status(409).json({ error: '该用户名已被注册' });

        const salt = makeSalt();
        users.push({
            username,
            salt,
            passwordHash: hashPassword(password, salt),
            createdAt: new Date().toISOString()
        });
        await writeUsers(users);
        await initUserStorage(username);
        const token = issueToken(username);
        res.status(201).json({ success: true, username, token });
    } catch (err) {
        console.error('注册失败:', err);
        res.status(500).json({ error: '注册失败: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
        const users = await readUsers();
        const user = users.find(u => u.username === username);
        if (!user) return res.status(401).json({ error: '用户名或密码错误' });

        const isMatch = user.passwordHash
            ? user.passwordHash === hashPassword(password, user.salt || '')
            : (user.password !== undefined && user.password === password); // 兼容旧版明文
        if (!isMatch) return res.status(401).json({ error: '用户名或密码错误' });

        // 旧版明文账号登录成功后自动迁移为哈希存储
        if (!user.passwordHash) {
            user.salt = makeSalt();
            user.passwordHash = hashPassword(password, user.salt);
            delete user.password;
            await writeUsers(users);
        }

        await initUserStorage(username);
        const token = issueToken(username);
        res.json({ success: true, username, token });
    } catch (err) {
        console.error('登录失败:', err);
        res.status(500).json({ error: '登录失败: ' + err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token) sessions.delete(token);
    res.json({ success: true });
});

app.get('/api/server-info', (req, res) => {
    try {
        const lanIp = getLANIP();
        res.json({ success: true, pcLanUrl: `http://${lanIp}:${PORT}` });
    } catch (err) {
        res.json({ success: false, error: err.message, pcLanUrl: `http://127.0.0.1:${PORT}` });
    }
});

// ==================== 通用 CRUD ====================
app.get('/api/:collection', authMiddleware, async (req, res) => {
    try {
        const { collection } = req.params;
        if (!COLLECTIONS[collection]) return res.status(404).json({ error: '集合不存在' });
        const data = await readCollection(req.currentUser, collection);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: '服务器错误' });
    }
});

app.post('/api/:collection', authMiddleware, async (req, res) => {
    try {
        const { collection } = req.params;
        const meta = COLLECTIONS[collection];
        if (!meta || meta.type !== 'array') return res.status(400).json({ error: '不支持' });
        if (!isPlainObject(req.body)) return res.status(400).json({ error: '请求数据格式错误' });
        const data = await readCollection(req.currentUser, collection);
        const newItem = { ...req.body, id: req.body.id || newId() };
        data.push(newItem);
        await writeCollection(req.currentUser, collection, data);
        res.status(201).json({ success: true, data: newItem });
    } catch (err) {
        res.status(500).json({ error: '保存失败' });
    }
});

app.put('/api/:collection/:id', authMiddleware, async (req, res) => {
    try {
        const { collection, id } = req.params;
        const meta = COLLECTIONS[collection];
        if (!meta) return res.status(404).json({ error: '集合不存在' });
        if (!isPlainObject(req.body)) return res.status(400).json({ error: '请求数据格式错误' });
        const data = await readCollection(req.currentUser, collection);
        if (meta.type === 'array') {
            const idx = data.findIndex(item => String(item.id) === String(id));
            if (idx === -1) return res.status(404).json({ error: '条目不存在' });
            data[idx] = { ...data[idx], ...req.body, id: data[idx].id };
            await writeCollection(req.currentUser, collection, data);
            res.json({ success: true, data: data[idx] });
        } else {
            const updated = { ...data, ...req.body };
            await writeCollection(req.currentUser, collection, updated);
            res.json({ success: true, data: updated });
        }
    } catch (err) {
        res.status(500).json({ error: '更新失败' });
    }
});

app.delete('/api/:collection/:id', authMiddleware, async (req, res) => {
    try {
        const { collection, id } = req.params;
        const meta = COLLECTIONS[collection];
        if (!meta || meta.type !== 'array') return res.status(400).json({ error: '不支持' });
        const data = await readCollection(req.currentUser, collection);
        const filtered = data.filter(item => String(item.id) !== String(id));
        await writeCollection(req.currentUser, collection, filtered);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ==================== 病历词条库（v3.3 门诊智能联想，按账号保存） ====================
app.put('/api/recordTerms', authMiddleware, async (req, res) => {
    try {
        if (!isPlainObject(req.body)) return res.status(400).json({ error: '请求数据格式错误' });
        const data = await readCollection(req.currentUser, 'recordTerms');
        const updated = { ...data, ...req.body };
        await writeCollection(req.currentUser, 'recordTerms', updated);
        res.json({ success: true, data: updated });
    } catch (err) {
        console.error('保存病历词条失败:', err);
        res.status(500).json({ error: '保存失败' });
    }
});

// ==================== 药典知识库接口 ====================
app.get('/api/pharmacopoeia/lookup', authMiddleware, async (req, res) => {
    try {
        const name = String(req.query.name || '').trim();
        if (!name) return res.status(400).json({ error: '缺少药品名称' });
        const userEntries = await readCollection(req.currentUser, 'drugKnowledge');
        const entry = knowledge.lookupDrug(name, userEntries);
        if (!entry) return res.json({ found: false });
        res.json({ found: true, entry });
    } catch (err) {
        res.status(500).json({ error: '知识库查询失败' });
    }
});

app.get('/api/pharmacopoeia/search', authMiddleware, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const limit = Math.min(Number(req.query.limit) || 30, 100);
        const userEntries = await readCollection(req.currentUser, 'drugKnowledge');
        const userNames = new Set((userEntries || []).map(e => e.name));
        const items = q ? knowledge.searchEntries(q, userEntries, limit) : knowledge.listEntries(userEntries, limit);
        res.json({ total: items.length, items: items.map(e => ({ ...e, isUser: userNames.has(e.name) })) });
    } catch (err) {
        res.status(500).json({ error: '知识库搜索失败' });
    }
});

// V3.5 中药饮片名称清单（处方中心饮片选择器使用）
app.get('/api/pharmacopoeia/herbs', authMiddleware, async (req, res) => {
    try {
        const userEntries = await readCollection(req.currentUser, 'drugKnowledge');
        res.json({ items: knowledge.herbNameList(userEntries) });
    } catch (err) {
        res.status(500).json({ error: '中药库加载失败' });
    }
});

app.get('/api/pharmacopoeia/stats', authMiddleware, (req, res) => {
    res.json(knowledge.stats());
});

app.get('/api/formulas/library', authMiddleware, async (req, res) => {
    try {
        const userFormulas = await readCollection(req.currentUser, 'userFormulas');
        res.json(knowledge.listFormulas(userFormulas));
    } catch (err) {
        res.status(500).json({ error: '方剂库加载失败' });
    }
});

// ==================== AI 辅助诊断接口 ====================
app.post('/api/ai/test', authMiddleware, async (req, res) => {
    try {
        const settings = await readCollection(req.currentUser, 'settings');
        const r = await ai.testConnection(settings);
        res.json(r);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/ai/generate-prescription', authMiddleware, async (req, res) => {
    try {
        const settings = await readCollection(req.currentUser, 'settings');
        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const userEntries = await readCollection(req.currentUser, 'drugKnowledge');
        const patient = (req.body && req.body.patient) || {};
        const prescriptions = Array.isArray(req.body && req.body.prescriptions) ? req.body.prescriptions : [];
        const result = await ai.generatePrescription(settings, { patient, prescriptions, inventory, userEntries });
        // 本地 AI 日志（不含姓名，仅记录建议药名与思路，便于追溯）
        try {
            const logs = await readCollection(req.currentUser, 'aiLogs');
            logs.push({
                id: newId(), type: 'generate', createdAt: new Date().toISOString(),
                patientId: patient.id || null, model: result.model,
                items: result.suggestions.map(s => s.name), rationale: result.rationale
            });
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            await writeCollection(req.currentUser, 'aiLogs', logs);
        } catch (e) { console.error('AI 日志写入失败:', e.message); }
        res.json(result);
    } catch (err) {
        console.error('AI 开方失败:', err.message);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/ai/review-prescription', authMiddleware, async (req, res) => {
    try {
        const settings = await readCollection(req.currentUser, 'settings');
        const userEntries = await readCollection(req.currentUser, 'drugKnowledge');
        const patient = (req.body && req.body.patient) || {};
        const prescriptions = Array.isArray(req.body && req.body.prescriptions) ? req.body.prescriptions : [];
        const result = await ai.reviewPrescription(settings, { patient, prescriptions, userEntries });
        try {
            const logs = await readCollection(req.currentUser, 'aiLogs');
            logs.push({
                id: newId(), type: 'review', createdAt: new Date().toISOString(),
                patientId: patient.id || null, items: prescriptions.map(d => d.name),
                risks: result.risks.map(r => r.issue).slice(0, 10)
            });
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            await writeCollection(req.currentUser, 'aiLogs', logs);
        } catch (e) { console.error('AI 日志写入失败:', e.message); }
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ==================== 患者档案迁移 ====================
app.post('/api/patients/migrate', authMiddleware, async (req, res) => {
    try {
        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const patients = await readCollection(req.currentUser, 'patients');
        const map = new Map((patients || []).map(p => [p.key, p]));
        const groups = {};
        for (const o of outpatients) {
            const name = String(o.name || '').trim();
            if (!name) continue;
            const phone = String(o.phone || '').trim();
            const key = (name + '|' + phone).toLowerCase();
            if (!groups[key]) groups[key] = [];
            groups[key].push(o);
        }
        let created = 0, updated = 0;
        for (const key of Object.keys(groups)) {
            const list = groups[key].sort((a, b) => String(a.opDate || a.date).localeCompare(String(b.opDate || b.date)));
            const last = list[list.length - 1];
            const profile = {
                key, name: last.name, phone: last.phone || '',
                gender: last.gender || '', age: last.age || '',
                allergy: last.allergy || '', past: last.past || '',
                visitCount: list.length, lastVisit: last.opDate || last.date || '',
                visits: list.map(o => ({
                    id: o.id, date: o.opDate || o.date, diagnosis: o.diagnosis || '',
                    prescriptions: (o.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
                })),
                updatedAt: new Date().toISOString()
            };
            if (map.has(key)) { map.set(key, { ...map.get(key), ...profile }); updated++; }
            else { map.set(key, { id: newId(), ...profile }); created++; }
        }
        const out = [...map.values()];
        await writeCollection(req.currentUser, 'patients', out);
        res.json({ success: true, total: out.length, created, updated });
    } catch (err) {
        console.error('患者迁移失败:', err);
        res.status(500).json({ error: '患者档案迁移失败: ' + err.message });
    }
});

// ==================== 库存盘点 ====================
app.post('/api/inventory/check', authMiddleware, async (req, res) => {
    try {
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        if (!items.length) return res.status(400).json({ error: '盘点数据不能为空' });
        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const checks = await readCollection(req.currentUser, 'inventoryChecks');
        const details = [];
        let changed = 0;
        for (const it of items) {
            const actual = Number(it.actual);
            if (!Number.isFinite(actual) || actual < 0) continue;
            const drug = it.id
                ? inventory.find(d => String(d.id) === String(it.id))
                : inventory.find(d => d.name === it.name);
            if (!drug) continue;
            const oldStock = toNum(drug.stock || drug.quantity);
            if (oldStock !== actual) { drug.stock = actual; drug.updatedAt = new Date().toISOString(); changed++; }
            details.push({ name: drug.name, oldStock, newStock: actual, diff: +(actual - oldStock).toFixed(2) });
        }
        await writeCollection(req.currentUser, 'drugInventory', inventory);
        checks.push({ id: newId(), date: new Date().toLocaleString(), operator: req.currentUser, items: details });
        await writeCollection(req.currentUser, 'inventoryChecks', checks);
        res.json({ success: true, changed, details });
    } catch (err) {
        console.error('盘点失败:', err);
        res.status(500).json({ error: '盘点失败: ' + err.message });
    }
});

// ==================== 增强统计（处方量/毛利/复诊率） ====================
app.get('/api/statistics/enhanced', authMiddleware, async (req, res) => {
    try {
        const range = req.query.range || '1m';
        const now = new Date();
        let startDate, label;
        if (range === '1m') { startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); label = '近一月'; }
        else if (range === '3m') { startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); label = '近三月'; }
        else { startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); label = '近半年'; }
        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const drugInventory = await readCollection(req.currentUser, 'drugInventory');
        const opIn = outpatients.filter(o => {
            const dt = parseDate(o.opDate || o.date);
            return dt && dt >= startDate && dt <= now;
        });
        const rxByDay = {};
        for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) rxByDay[toDateKey(d)] = 0;
        const invMap = new Map(drugInventory.map(d => [d.name, d]));
        let grossProfit = 0, rxTotal = 0;
        for (const o of opIn) {
            const rx = o.prescriptions || [];
            rxTotal += rx.length;
            const k = toDateKey(o.opDate || o.date);
            if (k && rxByDay[k] !== undefined) rxByDay[k] += rx.length;
            for (const d of rx) {
                const inv = invMap.get(d.name);
                const cost = inv ? toNum(inv.costPrice) : 0;
                grossProfit += (toNum(d.price) - cost) * toNum(d.qty);
            }
        }
        const grp = {};
        opIn.forEach(o => {
            const key = (String(o.name || '') + '|' + String(o.phone || '')).toLowerCase();
            grp[key] = (grp[key] || 0) + 1;
        });
        const totalPatients = Object.keys(grp).length;
        const revisitPatients = Object.values(grp).filter(n => n >= 2).length;
        res.json({
            range, label,
            rxTrend: Object.keys(rxByDay).sort().map(date => ({ date, value: rxByDay[date] })),
            rxTotal, grossProfit: +grossProfit.toFixed(2),
            totalPatients, revisitPatients,
            revisitRate: totalPatients ? +(revisitPatients / totalPatients * 100).toFixed(1) : 0
        });
    } catch (err) {
        console.error('增强统计失败:', err);
        res.status(500).json({ error: '增强统计失败' });
    }
});

// ==================== 首页大盘统计 ====================
app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
    try {
        const period = req.query.period || 'today';
        const now = new Date();
        let startDate, endDate;
        if (period === 'today') {
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        } else if (period === 'yesterday') {
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else if (period === 'week') {
            const day = now.getDay() || 7;
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
        } else if (period === 'month') {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        } else {
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        }

        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const pharmacy = await readCollection(req.currentUser, 'pharmacy');
        const revenue = await readCollection(req.currentUser, 'revenue');
        const drugInventory = await readCollection(req.currentUser, 'drugInventory');

        function inRange(d) {
            const dt = parseDate(d);
            return dt && dt >= startDate && dt < endDate;
        }

        const opInPeriod = outpatients.filter(o => inRange(o.opDate || o.date));
        const pharmaInPeriod = pharmacy.filter(p => inRange(p.date));
        const revInPeriod = revenue.filter(r => inRange(r.date));

        const tKey = todayKey();
        const todayOp = outpatients.filter(o => toDateKey(o.opDate || o.date) === tKey);
        const todayPharma = pharmacy.filter(p => toDateKey(p.date) === tKey);

        const totalRev = revInPeriod.reduce((s, r) => s + toNum(r.amount), 0);
        const outpatientRev = revInPeriod.filter(r => (r.desc || '').includes('门诊')).reduce((s, r) => s + toNum(r.amount), 0);
        const retailRev = revInPeriod.filter(r => (r.desc || '').includes('零售')).reduce((s, r) => s + toNum(r.amount), 0);
        const opCount = opInPeriod.length;
        const retailCount = pharmaInPeriod.filter(p => p.source === 'retail' || !p.patient).length;
        const opAvg = opCount > 0 ? outpatientRev / opCount : 0; // 门诊客单价 = 门诊收费 / 门诊诊量
        const retailAvg = retailCount > 0 ? retailRev / retailCount : 0;

        const payMap = {};
        revInPeriod.forEach(r => { const m = r.payMethod || r.method || '未分类'; payMap[m] = (payMap[m] || 0) + toNum(r.amount); });
        const feeMap = {};
        revInPeriod.forEach(r => { const c = r.category || r.desc || '未分类'; feeMap[c] = (feeMap[c] || 0) + toNum(r.amount); });
        const detailMap = {};
        revInPeriod.forEach(r => { const d = r.desc || '未分类'; detailMap[d] = (detailMap[d] || 0) + toNum(r.amount); });

        const warningDrugs = drugInventory.filter(d => {
            const exp = parseDate(d.expiry);
            if (!exp) return false;
            const diff = (exp - now) / (1000 * 60 * 60 * 24);
            return diff <= 30; // 含已过期
        });
        const lowStockDrugs = drugInventory.filter(d => {
            const qty = toNum(d.stock || d.quantity);
            const min = toNum(d.minStock, 10);
            return qty <= min;
        });

        res.json({
            period,
            today: {
                visitCount: todayOp.length,
                pendingDrug: todayPharma.filter(p => p.status === '待发药').length,
                expiryWarning: warningDrugs.length,
                visited: todayOp.length, prescriptionCount: todayOp.filter(o => o.prescriptions && o.prescriptions.length > 0).length,
                billed: todayOp.filter(o => o.billed).length, dispensed: todayPharma.filter(p => p.status === '已发药').length,
                stockWarning: lowStockDrugs.length
            },
            revenue: { total: totalRev, outpatient: outpatientRev, retail: retailRev, opVisits: opCount, retailCustomers: retailCount, opAvgPrice: opAvg, retailAvgPrice: retailAvg },
            charts: {
                payMethod: Object.entries(payMap).map(([name, value]) => ({ name, value })),
                feeCategory: Object.entries(feeMap).map(([name, value]) => ({ name, value })),
                detailCategory: Object.entries(detailMap).map(([name, value]) => ({ name, value }))
            },
            warnings: { expiryDrugs: warningDrugs, lowStockDrugs: lowStockDrugs }
        });
    } catch (err) {
        console.error('统计聚合失败:', err);
        res.status(500).json({ error: '统计聚合失败' });
    }
});

// ==================== 发药（联动库存 + 出库记录） ====================
app.post('/api/pharmacy/dispense/:id', authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const pharmacy = await readCollection(req.currentUser, 'pharmacy');
        const item = pharmacy.find(p => String(p.id) === String(id));
        if (!item) return res.status(404).json({ error: '药房记录不存在' });
        if (item.status === '已发药') return res.status(400).json({ error: '该处方已发药，请勿重复操作' });

        const qty = toNum(item.qty);
        if (qty <= 0) return res.status(400).json({ error: '发药数量无效' });

        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const drug = inventory.find(d => d.name === item.drug);
        if (drug) {
            const stock = toNum(drug.stock || drug.quantity);
            if (stock < qty) {
                return res.status(400).json({ error: `库存不足："${item.drug}" 当前库存 ${stock} ${drug.unit || '盒'}，需发 ${qty}` });
            }
            drug.stock = Math.max(0, stock - qty);
            drug.updatedAt = new Date().toISOString();
            await writeCollection(req.currentUser, 'drugInventory', inventory);
        }

        item.status = '已发药';
        item.dispensedAt = new Date().toISOString();
        await writeCollection(req.currentUser, 'pharmacy', pharmacy);

        const outRecords = await readCollection(req.currentUser, 'drugOutRecords');
        outRecords.push({
            id: newId(),
            drugName: item.drug, qty, patient: item.patient,
            type: '发药', date: new Date().toLocaleString(), operator: req.currentUser
        });
        await writeCollection(req.currentUser, 'drugOutRecords', outRecords);
        res.json({ success: true });
    } catch (err) {
        console.error('发药失败:', err);
        res.status(500).json({ error: '发药失败' });
    }
});

// ==================== 药品入库 ====================
app.post('/api/drug-inventory/stock-in', authMiddleware, async (req, res) => {
    try {
        const { drugId, drugName, qty, batchNo, expiry, productionDate, supplier, cost, supplierId, unit, minStock, price } = req.body || {};
        const qtyNum = toNum(qty);
        if (!drugName || qtyNum <= 0) return res.status(400).json({ error: '药品名称和数量不能为空，且数量必须大于0' });

        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const drug = drugId
            ? inventory.find(d => String(d.id) === String(drugId))
            : inventory.find(d => d.name === drugName);

        // 处理供应商ID关联
        let finalSupplierId = supplierId;
        if (supplier && !finalSupplierId) {
            const suppliers = await readCollection(req.currentUser, 'suppliers');
            let sup = suppliers.find(s => s.name === supplier);
            if (!sup) {
                sup = { id: newId(), name: supplier, contact: '', phone: '', address: '' };
                suppliers.push(sup);
                await writeCollection(req.currentUser, 'suppliers', suppliers);
            }
            finalSupplierId = sup.id;
        }

        if (drug) {
            drug.stock = toNum(drug.stock) + qtyNum;
            if (batchNo) drug.batchNo = batchNo;
            if (expiry) drug.expiry = expiry;
            if (productionDate) drug.productionDate = productionDate;
            if (supplier) drug.supplier = supplier;
            if (finalSupplierId) drug.supplierId = finalSupplierId;
            if (cost !== undefined && cost !== '') drug.costPrice = toNum(cost);
            if (price !== undefined && price !== '') drug.price = toNum(price);
            if (unit) drug.unit = unit;
            if (minStock !== undefined && minStock !== '') drug.minStock = toNum(minStock, 10);
            drug.purchaseDate = todayKey();
            drug.updatedAt = new Date().toISOString();
        } else {
            inventory.push({
                id: newId(),
                name: drugName, stock: qtyNum, unit: unit || '盒',
                minStock: minStock || 10, batchNo: batchNo || '',
                expiry: expiry || '', productionDate: productionDate || '', purchaseDate: todayKey(),
                supplier: supplier || '', supplierId: finalSupplierId || '',
                costPrice: toNum(cost), price: toNum(price),
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
        }
        await writeCollection(req.currentUser, 'drugInventory', inventory);

        const inRecords = await readCollection(req.currentUser, 'drugInRecords');
        inRecords.push({
            id: newId(),
            drugName, qty: qtyNum, batchNo: batchNo || '',
            expiry: expiry || '', productionDate: productionDate || '', supplier: supplier || '', supplierId: finalSupplierId || '',
            cost: toNum(cost), date: new Date().toLocaleString(), operator: req.currentUser
        });
        await writeCollection(req.currentUser, 'drugInRecords', inRecords);
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('入库失败:', err);
        res.status(500).json({ error: '入库失败' });
    }
});

// 药品库存批量导入（Excel 联动多表、自动识别供应商）
app.post('/api/drug-inventory/batch-import', authMiddleware, async (req, res) => {
    try {
        const items = req.body.items || [];
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: '导入数据不能为空' });
        }

        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const suppliers = await readCollection(req.currentUser, 'suppliers');
        const inRecords = await readCollection(req.currentUser, 'drugInRecords');
        let added = 0, updated = 0;
        const seenNames = new Set();

        for (const item of items) {
            const name = String(item.name || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seenNames.has(key)) continue; // 去重
            seenNames.add(key);

            // 自动识别供应商并绑定ID
            const supName = (item.supplier || '').trim();
            let finalSupplierId = '';
            if (supName) {
                let existingSup = suppliers.find(s => s.name === supName);
                if (!existingSup) {
                    existingSup = {
                        id: newId(),
                        name: supName, contact: '', phone: '', address: '',
                        createdAt: new Date().toISOString()
                    };
                    suppliers.push(existingSup);
                }
                finalSupplierId = existingSup.id;
            }

            const existing = inventory.find(d => d.name === name);
            if (existing) {
                if (item.stock !== undefined && item.stock !== '') existing.stock = toNum(existing.stock) + Math.max(0, toNum(item.stock));
                if (item.price !== undefined && item.price !== '') existing.price = toNum(item.price);
                if (item.costPrice !== undefined && item.costPrice !== '') existing.costPrice = toNum(item.costPrice);
                if (item.batchNo) existing.batchNo = item.batchNo;
                if (item.expiry) existing.expiry = item.expiry;
                if (supName) existing.supplier = supName;
                if (finalSupplierId) existing.supplierId = finalSupplierId;
                if (item.manufacturer) existing.manufacturer = item.manufacturer;
                if (item.spec) existing.spec = item.spec;
                if (item.unit) existing.unit = item.unit;
                if (item.category) existing.category = item.category;
                if (item.code) existing.code = item.code;
                if (item.approvalNo) existing.approvalNo = item.approvalNo;
                if (item.productionDate) existing.productionDate = item.productionDate;
                if (Math.max(0, toNum(item.stock)) > 0) existing.purchaseDate = item.purchaseDate || todayKey();
                existing.updatedAt = new Date().toISOString();
                updated++;
            } else {
                inventory.push({
                    id: newId(),
                    name, code: item.code || '',
                    approvalNo: item.approvalNo || '', spec: item.spec || '',
                    unit: item.unit || '盒', category: item.category || '',
                    manufacturer: item.manufacturer || '', stock: Math.max(0, toNum(item.stock)),
                    minStock: item.minStock || 10, price: toNum(item.price),
                    costPrice: toNum(item.costPrice), batchNo: item.batchNo || '',
                    expiry: item.expiry || '', productionDate: item.productionDate || '',
                    purchaseDate: item.purchaseDate || (Math.max(0, toNum(item.stock)) > 0 ? todayKey() : ''),
                    supplier: supName || '', supplierId: finalSupplierId || '',
                    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
                });
                added++;
            }

            const inQty = Math.max(0, toNum(item.stock));
            if (inQty > 0) {
                inRecords.push({
                    id: newId(),
                    drugName: name, qty: inQty,
                    unit: item.unit || '盒', batchNo: item.batchNo || '',
                    expiry: item.expiry || '', productionDate: item.productionDate || '', supplier: supName || '',
                    cost: toNum(item.costPrice), date: new Date().toLocaleString(),
                    operator: req.currentUser, source: 'Excel导入'
                });
            }
        }
        await writeCollection(req.currentUser, 'drugInventory', inventory);
        await writeCollection(req.currentUser, 'suppliers', suppliers);
        await writeCollection(req.currentUser, 'drugInRecords', inRecords);

        res.json({ success: true, added, updated, total: items.length });
    } catch (err) {
        console.error('批量导入失败:', err);
        res.status(500).json({ error: '批量导入失败' });
    }
});

// 删除库存药品，供效期/库存预警页批量处理。
app.delete('/api/drug-inventory', authMiddleware, async (req, res) => {
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
        if (!ids.length) return res.status(400).json({ error: '请选择要删除的药品' });
        const inventory = await readCollection(req.currentUser, 'drugInventory');
        const kept = inventory.filter(item => !ids.includes(String(item.id)));
        await writeCollection(req.currentUser, 'drugInventory', kept);
        res.json({ success: true, deleted: inventory.length - kept.length });
    } catch (err) {
        console.error('删除库存药品失败:', err);
        res.status(500).json({ error: '删除库存药品失败' });
    }
});

// ==================== 患者档案同步（接诊后自动归拢） ====================
async function upsertPatient(username, o) {
    try {
        const patients = await readCollection(username, 'patients');
        const name = String(o.name || '').trim();
        if (!name) return;
        const phone = String(o.phone || '').trim();
        const key = (name + '|' + phone).toLowerCase();
        const idx = patients.findIndex(p => p.key === key);
        const visit = {
            id: o.id, date: o.opDate || o.date || '',
            diagnosis: o.diagnosis || '',
            prescriptions: (o.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
        };
        const profile = {
            key, name, phone, gender: o.gender || '', age: o.age || '',
            allergy: o.allergy || '', past: o.past || '',
            visitCount: (idx >= 0 ? patients[idx].visitCount : 0) + 1,
            lastVisit: o.opDate || o.date || '',
            visits: idx >= 0 ? [...(patients[idx].visits || []), visit] : [visit],
            updatedAt: new Date().toISOString()
        };
        if (idx >= 0) patients[idx] = { ...patients[idx], ...profile };
        else patients.push({ id: newId(), ...profile });
        await writeCollection(username, 'patients', patients);
    } catch (e) {
        console.error('患者档案同步失败:', e.message);
    }
}

// ==================== 事务化接诊（多模块联动核心） ====================
// 一次请求内完成：更新/新建门诊 + 收费写入 + 处方推送药房，
// 避免分步保存中途失败导致的数据丢失。
app.post('/api/visits/complete', authMiddleware, async (req, res) => {
    try {
        const body = req.body || {};
        const outpatientId = body.outpatientId;
        const patient = body.patient || {};
        const prescriptions = Array.isArray(body.prescriptions) ? body.prescriptions : [];

        // 处方清洗：数量必须大于0，金额由服务端重算
        const cleanRx = [];
        for (const d of prescriptions) {
            const rxName = String(d.name || '').trim();
            const qty = toNum(d.qty);
            const price = Math.max(0, toNum(d.price));
            if (!rxName || qty <= 0) continue;
            cleanRx.push({ name: rxName, qty, price, subtotal: +(qty * price).toFixed(2) });
        }
        const drugTotal = cleanRx.reduce((s, d) => s + d.subtotal, 0);

        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const inventory = await readCollection(req.currentUser, 'drugInventory');

        // 患者姓名：门诊场景可从原记录继承，无需前端重复传
        let name = String(patient.name || '').trim();
        if (!name && outpatientId) {
            const op = outpatients.find(x => String(x.id) === String(outpatientId));
            if (op) name = String(op.name || '').trim();
        }
        if (!name) return res.status(400).json({ error: '患者姓名不能为空' });

        // 库存校验（仅校验库存中存在的药品；诊疗项目不在此列）
        for (const d of cleanRx) {
            const inv = inventory.find(i => i.name === d.name);
            if (inv && toNum(inv.stock || inv.quantity) < d.qty) {
                return res.status(400).json({ error: `【库存不足】药品"${d.name}"当前库存仅 ${toNum(inv.stock || inv.quantity)} ${inv.unit || '盒'}，处方需要 ${d.qty}，请先入库或调整处方` });
            }
        }

        const todayStr = todayKey();
        const nowISO = new Date().toISOString();
        const baseFields = {
            chief: String(patient.chief || '').trim(),
            history: String(patient.history || '').trim(),
            past: String(patient.past || '').trim(),
            allergy: String(patient.allergy || '').trim(),
            exam: String(patient.exam || '').trim(),
            tcm: String(patient.tcm || '').trim(),
            diagnosis: String(patient.diagnosis || '').trim(),
            syndrome: String(patient.syndrome || '').trim(),
            advice: String(patient.advice || '').trim(),
            visitType: patient.visitType || '初诊',
            // 系统统一自费结算，忽略旧客户端可能传来的医保值。
            feeType: '自费',
            clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : {},
            prescriptions: cleanRx
        };

        let savedOutpatient = null;

        if (outpatientId) {
            // 更新已有门诊记录
            const idx = outpatients.findIndex(o => String(o.id) === String(outpatientId));
            if (idx === -1) return res.status(404).json({ error: '门诊记录不存在，请刷新后重试' });
            const op = outpatients[idx];
            savedOutpatient = {
                ...op,
                ...baseFields,
                name: op.name || name,
                gender: patient.gender !== undefined ? patient.gender : (op.gender || ''),
                age: patient.age !== undefined && patient.age !== '' ? patient.age : (op.age || ''),
                phone: patient.phone !== undefined ? patient.phone : (op.phone || ''),
                status: '已就诊',
                updatedAt: nowISO
            };
            outpatients[idx] = savedOutpatient;
        } else {
            // 直接新建门诊记录（快速接诊场景的补充）
            savedOutpatient = {
                id: newId(),
                name,
                gender: patient.gender || '',
                age: patient.age || '',
                phone: patient.phone || '',
                ...baseFields,
                status: '已就诊',
                date: todayStr,
                opDate: todayStr,
                source: 'direct',
                createdAt: nowISO,
                updatedAt: nowISO
            };
            outpatients.push(savedOutpatient);
        }
        await writeCollection(req.currentUser, 'outpatients', outpatients);
        await upsertPatient(req.currentUser, savedOutpatient);

        // 收费写入
        let revenueAmount = 0;
        if (drugTotal > 0) {
            const revenue = await readCollection(req.currentUser, 'revenue');
            revenue.push({
                id: newId(),
                date: todayStr,
                amount: +drugTotal.toFixed(2),
                desc: '门诊药品费',
                category: '门诊收费',
                payMethod: '自费',
                patient: savedOutpatient.name
            });
            await writeCollection(req.currentUser, 'revenue', revenue);
            revenueAmount = +drugTotal.toFixed(2);
        }

        // 处方推送药房（受“门诊处方自动入库”设置控制）
        let pharmacyPushed = 0;
        if (cleanRx.length > 0) {
            const settings = await readCollection(req.currentUser, 'settings');
            if (settings.autoPharmacy !== false) {
                const pharmacy = await readCollection(req.currentUser, 'pharmacy');
                for (const d of cleanRx) {
                    pharmacy.push({
                        id: newId(),
                        patient: savedOutpatient.name,
                        drug: d.name,
                        qty: d.qty,
                        price: d.price,
                        status: '待发药',
                        date: new Date().toLocaleString(),
                        source: '门诊处方'
                    });
                }
                await writeCollection(req.currentUser, 'pharmacy', pharmacy);
                pharmacyPushed = cleanRx.length;
            }
        }

        res.json({ success: true, data: savedOutpatient, pharmacyPushed, revenueAmount });
    } catch (err) {
        console.error('保存接诊失败:', err);
        res.status(500).json({ error: '保存接诊失败: ' + err.message });
    }
});

// ==================== 统计 API ====================
app.get('/api/statistics/revenue', authMiddleware, async (req, res) => {
    try {
        const period = req.query.period || 'today';
        const now = new Date();
        let startDate, endDate, label;
        if (period === 'today') {
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            label = '今天';
        } else if (period === 'yesterday') {
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            label = '昨天';
        } else if (period === 'week') {
            const day = now.getDay() || 7;
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
            label = '本周';
        } else {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            label = '本月';
        }

        const revenue = await readCollection(req.currentUser, 'revenue');
        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const pharmacy = await readCollection(req.currentUser, 'pharmacy');

        function inRange(d) {
            const dt = parseDate(d);
            return dt && dt >= startDate && dt < endDate;
        }

        const revInPeriod = revenue.filter(r => inRange(r.date));
        const opInPeriod = outpatients.filter(o => inRange(o.opDate || o.date));
        const pharmaInPeriod = pharmacy.filter(p => inRange(p.date));

        const totalRev = revInPeriod.reduce((s, r) => s + toNum(r.amount), 0);
        const outpatientRev = revInPeriod.filter(r => (r.desc || '').includes('门诊')).reduce((s, r) => s + toNum(r.amount), 0);
        const retailRev = revInPeriod.filter(r => (r.desc || '').includes('零售')).reduce((s, r) => s + toNum(r.amount), 0);
        const payMap = {};
        revInPeriod.forEach(r => { const m = r.payMethod || r.method || '未分类'; payMap[m] = (payMap[m] || 0) + toNum(r.amount); });
        const feeMap = {};
        revInPeriod.forEach(r => { const c = r.category || '未分类'; feeMap[c] = (feeMap[c] || 0) + toNum(r.amount); });
        const detailMap = {};
        revInPeriod.forEach(r => { const d = r.desc || '未分类'; detailMap[d] = (detailMap[d] || 0) + toNum(r.amount); });

        const retailCount = pharmaInPeriod.filter(p => p.source === 'retail' || !p.patient).length;
        res.json({
            period, label,
            dateRange: `${startDate.toLocaleDateString('zh-CN')} ~ ${endDate.toLocaleDateString('zh-CN')}`,
            cards: [
                { name: '营业收费', value: totalRev },
                { name: '门诊收费', value: outpatientRev },
                { name: '零售收费', value: retailRev },
                { name: '门诊诊量', value: opInPeriod.length },
                { name: '零售客量', value: retailCount },
                { name: '门诊客单价', value: opInPeriod.length > 0 ? outpatientRev / opInPeriod.length : 0 },
                { name: '零售客单价', value: retailCount > 0 ? retailRev / retailCount : 0 }
            ],
            charts: {
                payMethod: Object.entries(payMap).map(([name, value]) => ({ name, value })),
                feeCategory: Object.entries(feeMap).map(([name, value]) => ({ name, value })),
                detailCategory: Object.entries(detailMap).map(([name, value]) => ({ name, value }))
            },
            detailList: revInPeriod
        });
    } catch (err) {
        console.error('营收统计失败:', err);
        res.status(500).json({ error: '营收统计失败' });
    }
});

app.get('/api/statistics/trend', authMiddleware, async (req, res) => {
    try {
        const range = req.query.range || '1m';
        const now = new Date();
        let startDate, label;
        if (range === '1m') { startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); label = '近一月'; }
        else if (range === '3m') { startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); label = '近三月'; }
        else { startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); label = '近半年'; }

        const revenue = await readCollection(req.currentUser, 'revenue');
        const outpatients = await readCollection(req.currentUser, 'outpatients');

        const dayMap = {};
        const dayVisits = {};
        for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
            const ds = toDateKey(d);
            dayMap[ds] = 0;
            dayVisits[ds] = 0;
        }

        revenue.forEach(r => {
            const dt = parseDate(r.date);
            if (dt && dt >= startDate && dt <= now) {
                const ds = toDateKey(dt);
                if (dayMap[ds] !== undefined) dayMap[ds] += toNum(r.amount);
            }
        });
        outpatients.forEach(o => {
            const dt = parseDate(o.opDate || o.date);
            if (dt && dt >= startDate && dt <= now) {
                const ds = toDateKey(dt);
                if (dayVisits[ds] !== undefined) dayVisits[ds]++;
            }
        });

        const dates = Object.keys(dayMap).sort();
        res.json({
            range, label,
            dateRange: `${startDate.toLocaleDateString('zh-CN')} ~ ${now.toLocaleDateString('zh-CN')}`,
            revenue: dates.map(d => ({ date: d, value: dayMap[d] })),
            visits: dates.map(d => ({ date: d, value: dayVisits[d] }))
        });
    } catch (err) {
        console.error('趋势统计失败:', err);
        res.status(500).json({ error: '趋势统计失败' });
    }
});

// 运营分析（含按日明细，供“运营日报”使用）
app.get('/api/statistics/operations', authMiddleware, async (req, res) => {
    try {
        const period = req.query.period || 'week';
        const now = new Date();
        let startDate, label;
        if (period === 'today') { startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); label = '今天'; }
        else if (period === 'week') { const day = now.getDay() || 7; startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1); label = '近一周'; }
        else if (period === 'month') { startDate = new Date(now.getFullYear(), now.getMonth(), 1); label = '近一月'; }
        else if (period === 'quarter') { startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); label = '近三月'; }
        else { startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); label = '近半年'; }

        const outpatients = await readCollection(req.currentUser, 'outpatients');
        const pharmacy = await readCollection(req.currentUser, 'pharmacy');

        const tKey = todayKey();
        const todayOp = outpatients.filter(o => toDateKey(o.opDate || o.date) === tKey);
        const todayPharma = pharmacy.filter(p => toDateKey(p.date) === tKey);

        function hasEarlierVisit(name, dateKey) {
            return outpatients.some(o => {
                if (o.name !== name) return false;
                const k = toDateKey(o.opDate || o.date);
                return k !== null && k < dateKey;
            });
        }

        const newPatientsCount = (() => {
            let n = 0;
            todayOp.forEach(o => { if (!hasEarlierVisit(o.name, tKey)) n++; });
            return n;
        })();

        const dayKeys = [];
        for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) dayKeys.push(toDateKey(d));

        const opByDay = {};
        outpatients.forEach(o => { const k = toDateKey(o.opDate || o.date); if (k && dayKeys.includes(k)) opByDay[k] = (opByDay[k] || 0) + 1; });
        const retailByDay = {};
        pharmacy.forEach(p => {
            const k = toDateKey(p.date);
            if (k && dayKeys.includes(k) && (p.source === 'retail' || !p.patient)) retailByDay[k] = (retailByDay[k] || 0) + 1;
        });

        const daily = dayKeys.map(k => {
            let newP = 0;
            outpatients.forEach(o => { if (toDateKey(o.opDate || o.date) === k && !hasEarlierVisit(o.name, k)) newP++; });
            return {
                date: k,
                visits: opByDay[k] || 0,
                finished: opByDay[k] || 0,
                newPatients: newP,
                retail: retailByDay[k] || 0
            };
        });

        res.json({
            period: label,
            cards: { visitCount: todayOp.length, newPatients: newPatientsCount, retailCount: todayPharma.filter(p => p.source === 'retail' || !p.patient).length, finishedVisits: todayOp.filter(o => o.status === '已就诊').length },
            trend: {
                labels: dayKeys,
                visits: dayKeys.map(k => opByDay[k] || 0),
                finished: dayKeys.map(k => opByDay[k] || 0)
            },
            daily
        });
    } catch (err) { console.error('运营分析失败:', err); res.status(500).json({ error: '运营分析失败' }); }
});

// 库存统计
app.get('/api/statistics/inventory-overview', authMiddleware, async (req, res) => {
    try {
        const drugInventory = await readCollection(req.currentUser, 'drugInventory');

        const normal = drugInventory.filter(d => toNum(d.stock || d.quantity) > 10).length;
        const low = drugInventory.filter(d => toNum(d.stock || d.quantity) <= 10 && toNum(d.stock || d.quantity) > 0).length;
        const empty = drugInventory.filter(d => toNum(d.stock || d.quantity) === 0).length;
        const expiryAlert = drugInventory.filter(d => {
            const exp = parseDate(d.expiry);
            if (!exp) return false;
            const diff = (exp - new Date()) / (1000 * 60 * 60 * 24);
            return diff <= 30; // 含已过期，与首页预警口径一致
        }).length;

        const pieData = [
            { name: '库存正常', value: normal },
            { name: '库存偏低(≤10)', value: low },
            { name: '库存耗尽(0)', value: empty },
            { name: '效期预警(30天内)', value: expiryAlert }
        ];

        const now = new Date();
        const alerts = [];
        drugInventory.forEach(d => {
            const stock = toNum(d.stock || d.quantity);
            const min = toNum(d.minStock, 10);
            const exp = parseDate(d.expiry);
            const days = exp ? Math.ceil((exp - now) / (1000 * 60 * 60 * 24)) : null;
            if (days !== null && days <= 0) alerts.push({ ...d, type: '已过期', severity: 4, color: '#d32f2f', time: `已过期${Math.abs(days)}天` });
            else if (stock <= 0) alerts.push({ ...d, type: '库存耗尽', severity: 4, color: '#d32f2f', time: '当前库存为 0' });
            else if (days !== null && days <= 30) alerts.push({ ...d, type: '效期预警', severity: 3, color: '#e67e00', time: `距效期 ${days} 天` });
            else if (stock <= min) alerts.push({ ...d, type: '库存不足', severity: 2, color: '#f1c40f', time: `低于安全线 ${min}` });
        });
        alerts.sort((a, b) => b.severity - a.severity || String(a.time).localeCompare(String(b.time)));
        res.json({ pieData, alerts });
    } catch (err) { console.error('库存统计失败:', err); res.status(500).json({ error: '库存统计失败' }); }
});

// ==================== 页面与静态资源 ====================
// 只允许访问登录页与主页，避免 clinic_database / server.js / node_modules 被直接下载
app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'index.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(BASE_DIR, 'login.html'));
});
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
    res.status(404).send('页面不存在');
});

// ==================== 启动服务 ====================
initRootStorage().then(() => {
    try {
        knowledge.loadKnowledge();
        const ks = knowledge.stats();
        console.log(`  知识库已加载：单药 ${ks.pharma} 条 / 方剂 ${ks.formulas} 首 / 相互作用 ${ks.interactions} 条`);
    } catch (err) {
        console.error('知识库加载失败（请确认 data 目录存在）:', err.message);
    }
    app.listen(PORT, '0.0.0.0', () => {
        const lanIP = getLANIP();
        console.log('========================================');
        console.log('  愈康云诊所服务已启动（v3.2）');
        console.log('========================================');
        console.log(`  电脑本机访问: http://localhost:${PORT}`);
        console.log(`  手机端访问:   http://${lanIP}:${PORT}`);
        console.log('========================================');
        if (process.platform === 'win32' && !process.env.NO_OPEN_BROWSER) {
            const url = `http://localhost:${PORT}/login.html`;
            exec(`start ${url}`);
        }
    });
});
