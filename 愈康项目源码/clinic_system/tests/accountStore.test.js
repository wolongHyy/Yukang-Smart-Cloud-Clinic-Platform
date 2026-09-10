const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

function registration(overrides = {}) {
    return {
        fullName: '张三',
        phone: '13800000001',
        idCard: makeValidIdCard(1),
        clinicName: '青囊中医诊所',
        orgMode: 'single',
        storeRole: 'single',
        username: 'owner_one',
        password: 'secret123',
        privacyAccepted: true,
        ...overrides,
    };
}

test('v5 账号、门店隔离、邀请码与总部控制台权限', async () => {
    const server = await startV5Server('account-store');
    try {
        const single = await server.request('/api/auth/register', { method: 'POST', body: registration() });
        assert.equal(single.status, 201);
        assert.equal(single.data.user.idCardLast4, '0010');
        assert.equal(single.data.canManageStores, false);
        assert.equal(single.data.clinic.storeRole, 'single');
        assert.equal(Object.prototype.hasOwnProperty.call(single.data.user, 'idCard'), false);

        const me = await server.request('/api/account/me', { token: single.data.token });
        assert.equal(me.status, 200);
        assert.equal(me.data.fullName, '张三');
        assert.equal(me.data.canManageStores, false);

        const duplicatePhone = await server.request('/api/auth/register', {
            method: 'POST',
            body: registration({ username: 'owner_two', idCard: makeValidIdCard(2) }),
        });
        assert.equal(duplicatePhone.status, 409);
        assert.equal(duplicatePhone.data.code, 'PHONE_TAKEN');

        const controlDb = new DatabaseSync(path.join(server.dataDir, 'control', 'control.db'));
        const storedIdentity = controlDb.prepare('SELECT id_card_enc, id_card_last4 FROM users WHERE username = ?').get('owner_one');
        controlDb.close();
        assert.match(storedIdentity.id_card_enc, /^enc:v1:/);
        assert.equal(storedIdentity.id_card_last4, '0010');
        assert.equal(storedIdentity.id_card_enc.includes(makeValidIdCard(1)), false);

        const headquarters = await server.request('/api/auth/register', {
            method: 'POST',
            body: registration({
                fullName: '李医生',
                phone: '13900000001',
                idCard: makeValidIdCard(101),
                clinicName: '杏林连锁总院',
                orgMode: 'chain',
                storeRole: 'headquarters',
                username: 'chain_owner',
            }),
        });
        assert.equal(headquarters.status, 201);
        assert.equal(headquarters.data.canManageStores, true);
        assert.equal(headquarters.data.clinic.storeRole, 'headquarters');

        const invite = await server.request('/api/clinics/invites', {
            method: 'POST',
            token: headquarters.data.token,
            body: {},
        });
        assert.equal(invite.status, 201);
        assert.match(invite.data.code, /^YK-[A-F0-9]{6}-[A-F0-9]{6}$/);

        const branch = await server.request('/api/auth/register', {
            method: 'POST',
            body: registration({
                fullName: '王药师',
                phone: '13700000001',
                idCard: makeValidIdCard(201),
                clinicName: '杏林连锁城西分店',
                orgMode: 'chain',
                storeRole: 'branch',
                inviteCode: invite.data.code,
                username: 'branch_one',
            }),
        });
        assert.equal(branch.status, 201);
        assert.equal(branch.data.clinic.storeRole, 'branch');
        assert.equal(branch.data.clinic.name, '杏林连锁城西分店');
        assert.notEqual(branch.data.clinic.id, headquarters.data.clinic.id);
        assert.equal(branch.data.canManageStores, false);

        const hqInventoryCreate = await server.request('/api/drugInventory', {
            method: 'POST',
            token: headquarters.data.token,
            body: { name: '总店专属药', stock: 3 },
        });
        assert.equal(hqInventoryCreate.status, 201);
        const hqInventory = await server.request('/api/drugInventory', { token: headquarters.data.token });
        const branchInventory = await server.request('/api/drugInventory', { token: branch.data.token });
        assert.equal(hqInventory.data.length, 1);
        assert.equal(branchInventory.data.length, 0);

        const overview = await server.request('/api/clinics/overview', { token: headquarters.data.token });
        assert.equal(overview.status, 200);
        assert.equal(overview.data.totals.clinicCount, 2);
        assert.deepEqual(overview.data.stores.map(item => item.name).sort(), ['杏林连锁城西分店', '杏林连锁总院']);
        assert.equal(overview.data.stores.find(item => item.id === headquarters.data.clinic.id).clinicId, headquarters.data.clinic.id);

        const forbiddenOverview = await server.request('/api/clinics/overview', { token: branch.data.token });
        assert.equal(forbiddenOverview.status, 403);
        assert.equal(forbiddenOverview.data.code, 'STORE_DASHBOARD_FORBIDDEN');

        const reusedInvite = await server.request('/api/auth/register', {
            method: 'POST',
            body: registration({
                fullName: '赵医生',
                phone: '13600000001',
                idCard: makeValidIdCard(202),
                clinicName: '杏林连锁城南分店',
                orgMode: 'chain',
                storeRole: 'branch',
                inviteCode: invite.data.code,
                username: 'branch_two',
            }),
        });
        assert.equal(reusedInvite.status, 409);
        assert.equal(reusedInvite.data.code, 'INVITE_USED');
    } finally {
        await server.stop();
    }
});