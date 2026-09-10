const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { createControlRepository } = require('../repository/controlRepository');

let control = null;

function requireControl() {
    if (!control) throw new HttpError(503, '账号控制库尚未初始化', 'CONTROL_NOT_READY');
    return control;
}

function wrapControlError(err) {
    if (err && err.status && err.code) return err;
    return new HttpError(400, err.message || '账号操作失败', 'ACCOUNT_OPERATION_FAILED');
}

async function copyLegacyCollections(username, clinicId) {
    const collections = {};
    for (const name of Object.keys(repo.COLLECTIONS)) {
        collections[name] = await repo.readCollection(username, name);
    }
    const hasData = Object.entries(collections).some(([name, value]) => {
        const defaultValue = repo.COLLECTIONS[name].default;
        return JSON.stringify(value) !== JSON.stringify(defaultValue);
    });
    if (!hasData) return false;
    await repo.runWithStore(clinicId, async () => {
        for (const [name, value] of Object.entries(collections)) {
            await repo.writeCollection('__clinic__', name, value);
        }
    });
    return true;
}

async function initialize(dataDir, encryptionKey) {
    control = createControlRepository(dataDir, { encryptionKey });
    await control.init(encryptionKey);
    const legacyUsers = await repo.readUsers();
    const result = control.migrateLegacyUsers(legacyUsers);
    for (const migrated of result.migrated) {
        await repo.initStore(migrated.clinicId);
        await copyLegacyCollections(migrated.username, migrated.clinicId);
    }
    for (const user of control.getAllUsers ? control.getAllUsers() : []) {
        await repo.initStore(user.clinicId);
    }
    return { database: control.DB_FILE, migrated: result.migrated.length };
}

async function register(body) {
    try {
        const result = control.registerAccount(body || {});
        await repo.initStore(result.user.clinicId);
        return result;
    } catch (err) {
        throw wrapControlError(err);
    }
}

async function login(body) {
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!username || !password) throw new HttpError(400, '用户名和密码不能为空', 'VALIDATION_ERROR');
    try {
        const result = control.login(username, password);
        await repo.initStore(result.data.user.clinicId);
        return result;
    } catch (err) {
        throw wrapControlError(err);
    }
}

function getUser(username) {
    return requireControl().getUser(username);
}

function getClinic(clinicId) {
    return requireControl().getClinic(clinicId);
}

function getCurrent(session) {
    const user = getUser(session && session.username);
    if (!user) throw new HttpError(401, '用户不存在，请重新登录', 'USER_NOT_FOUND');
    const clinic = getClinic(user.clinicId);
    if (!clinic || clinic.orgId !== user.orgId) throw new HttpError(403, '账号门店信息无效', 'CLINIC_SCOPE_INVALID');
    return { user, clinic };
}

function publicProfile(session) {
    const { user, clinic } = getCurrent(session);
    return {
        username: user.username,
        fullName: user.fullName,
        phone: user.phone,
        idCardLast4: user.idCardLast4,
        orgId: user.orgId,
        clinicId: user.clinicId,
        clinicName: clinic.name,
        storeRole: clinic.storeRole,
        role: user.role,
        canManageStores: clinic.storeRole === 'headquarters' && user.role === 'org_owner',
    };
}

async function overview(session) {
    const { user, clinic } = getCurrent(session);
    if (clinic.storeRole !== 'headquarters' || user.role !== 'org_owner') {
        throw new HttpError(403, '只有连锁总店可以查看门店控制台', 'STORE_DASHBOARD_FORBIDDEN');
    }
    const clinics = requireControl().listClinics(user.orgId);
    const stores = [];
    for (const item of clinics) {
        const metrics = await repo.getStoreAggregate(item.id);
        stores.push({ ...item, ...metrics });
    }
    const totals = stores.reduce((acc, item) => {
        acc.clinicCount += 1;
        acc.visitCount += item.visitCount;
        acc.patientCount += item.patientCount;
        acc.revenue = +(acc.revenue + item.revenue).toFixed(2);
        acc.pendingBillingCount += item.pendingBillingCount;
        acc.pendingPharmacyCount += item.pendingPharmacyCount;
        acc.lowStockCount += item.lowStockCount;
        return acc;
    }, { clinicCount: 0, visitCount: 0, patientCount: 0, revenue: 0, pendingBillingCount: 0, pendingPharmacyCount: 0, lowStockCount: 0 });
    return { organization: { id: user.orgId, name: clinic.name }, totals, stores };
}

function createInvite(session) {
    const { user, clinic } = getCurrent(session);
    if (clinic.storeRole !== 'headquarters' || user.role !== 'org_owner') {
        throw new HttpError(403, '只有连锁总店可以生成邀请码', 'INVITE_FORBIDDEN');
    }
    try {
        return requireControl().createInvite({
            orgId: user.orgId,
            clinicId: user.clinicId,
            createdBy: user.username,
        });
    } catch (err) {
        throw wrapControlError(err);
    }
}

module.exports = {
    initialize,
    register,
    login,
    getUser,
    getClinic,
    getCurrent,
    publicProfile,
    overview,
    createInvite,
};