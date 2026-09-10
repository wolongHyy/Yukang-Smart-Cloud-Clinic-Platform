const crypto = require('crypto');
const repo = require('../repository/sqliteRepository');
const accountService = require('./accountService');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function issueToken(user) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, {
        username: user.username,
        orgId: user.orgId,
        clinicId: user.clinicId,
        role: user.role,
        createdAt: Date.now(),
    });
    return token;
}

function createAuthPayload(user) {
    const session = {
        username: user.username,
        orgId: user.orgId,
        clinicId: user.clinicId,
        role: user.role,
    };
    const profile = accountService.publicProfile(session);
    return {
        success: true,
        token: issueToken(user),
        username: profile.username,
        user: profile,
        clinic: {
            id: profile.clinicId,
            name: profile.clinicName,
            storeRole: profile.storeRole,
        },
        canManageStores: profile.canManageStores,
    };
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

    try {
        const current = accountService.getCurrent(session);
        session.username = current.user.username;
        session.orgId = current.user.orgId;
        session.clinicId = current.user.clinicId;
        session.role = current.user.role;
        session.createdAt = Date.now();

        req.currentUser = current.user.username;
        req.currentSession = session;
        req.account = current.user;
        req.clinic = current.clinic;

        await repo.initStore(current.user.clinicId);
        return repo.runWithStore(current.user.clinicId, () => next());
    } catch (err) {
        return next(err);
    }
}

async function register(body) {
    const result = await accountService.register(body || {});
    return {
        status: result.status || 201,
        data: createAuthPayload(result.user),
    };
}

async function login(body) {
    const result = await accountService.login(body || {});
    return { data: createAuthPayload(result.data.user) };
}

function logout(token) {
    if (token) sessions.delete(token);
    return { success: true };
}

module.exports = {
    authMiddleware,
    register,
    login,
    logout,
};
