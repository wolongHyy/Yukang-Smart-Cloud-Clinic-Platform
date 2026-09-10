const crypto = require('crypto');
const os = require('os');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function newId() {
    return Date.now() + Math.floor(Math.random() * 10000);
}

function toNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const s = String(value).trim();
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) {
        const dt = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        return isNaN(dt.getTime()) ? null : dt;
    }
    const t = new Date(s);
    return isNaN(t.getTime()) ? null : t;
}

function toDateKey(value) {
    const dt = parseDate(value);
    if (!dt) return null;
    return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`;
}

function todayKey() {
    return toDateKey(new Date());
}

function makeSalt() {
    return crypto.randomBytes(8).toString('hex');
}

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(String(salt) + ':' + String(password)).digest('hex');
}

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

module.exports = {
    isPlainObject,
    newId,
    toNum,
    parseDate,
    toDateKey,
    todayKey,
    makeSalt,
    hashPassword,
    getLANIP
};
