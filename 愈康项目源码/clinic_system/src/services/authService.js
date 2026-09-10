const crypto = require('crypto');
const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { makeSalt, hashPassword } = require('../utils/helpers');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function issueToken(username) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username, createdAt: Date.now() });
    return token;
}

async function authMiddleware(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ error: '未登录，请先登录', code: 'UNAUTHENTICATED' });
    const session = sessions.get(token);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录', code: 'SESSION_EXPIRED' });
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        return res.status(401).json({ error: '登录已过期，请重新登录', code: 'SESSION_EXPIRED' });
    }
    session.createdAt = Date.now();
    try {
        const users = await repo.readUsers();
        const user = users.find(u => u.username === session.username);
        if (!user) return res.status(401).json({ error: '用户不存在，请重新登录', code: 'USER_NOT_FOUND' });
        await repo.initUserStorage(session.username);
        req.currentUser = session.username;
        next();
    } catch (err) {
        next(err);
    }
}

async function registerUnsafe(body) {
    const { username, password } = body || {};
    if (!username || !password) throw new HttpError(400, '用户名和密码不能为空', 'VALIDATION_ERROR');
    if (username.length < 2 || username.length > 20) throw new HttpError(400, '用户名长度需 2-20 个字符', 'VALIDATION_ERROR');
    if (password.length < 4) throw new HttpError(400, '密码长度至少 4 位', 'VALIDATION_ERROR');
    if (!/^[a-zA-Z0-9_]+$/.test(username)) throw new HttpError(400, '用户名仅支持字母、数字、下划线', 'VALIDATION_ERROR');

    const users = await repo.readUsers();
    if (users.find(u => u.username === username)) {
        throw new HttpError(409, '该用户名已被注册', 'USERNAME_TAKEN');
    }
    const salt = makeSalt();
    users.push({
        username,
        salt,
        passwordHash: hashPassword(password, salt),
        createdAt: new Date().toISOString()
    });
    await repo.writeUsers(users);
    await repo.initUserStorage(username);
    return { status: 201, data: { success: true, username, token: issueToken(username) } };
}

async function loginUnsafe(body) {
    const { username, password } = body || {};
    if (!username || !password) throw new HttpError(400, '用户名和密码不能为空', 'VALIDATION_ERROR');
    const users = await repo.readUsers();
    const user = users.find(u => u.username === username);
    if (!user) throw new HttpError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');

    const isMatch = user.passwordHash
        ? user.passwordHash === hashPassword(password, user.salt || '')
        : (user.password !== undefined && user.password === password);
    if (!isMatch) throw new HttpError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');

    if (!user.passwordHash) {
        user.salt = makeSalt();
        user.passwordHash = hashPassword(password, user.salt);
        delete user.password;
        await repo.writeUsers(users);
    }
    await repo.initUserStorage(username);
    return { data: { success: true, username, token: issueToken(username) } };
}

function logout(token) {
    if (token) sessions.delete(token);
    return { success: true };
}

async function register(body) {
    return repo.transaction(() => registerUnsafe(body));
}

async function login(body) {
    return repo.transaction(() => loginUnsafe(body));
}

module.exports = {
    authMiddleware,
    register,
    login,
    logout
};
