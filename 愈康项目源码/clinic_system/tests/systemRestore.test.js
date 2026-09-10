const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

async function registerOwner(server) {
    const response = await server.request('/api/auth/register', {
        method: 'POST',
        body: {
            fullName: '周医生',
            phone: '13800000221',
            idCard: makeValidIdCard(401),
            clinicName: '和安门诊',
            orgMode: 'single',
            storeRole: 'single',
            username: 'restore_owner',
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

test('v5 图形化备份恢复要求确认、限制文件名并恢复门店快照', async () => {
    const server = await startV5Server('system-restore');
    try {
        const auth = await registerOwner(server);
        const created = await server.request('/api/system/backup', {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(created.status, 201);
        assert.match(created.data.filename, /^yukang-.*\.db$/);

        const changed = await server.request('/api/settings/1', {
            method: 'PUT',
            token: auth.token,
            body: { warningAlert: true, autoPharmacy: false },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.data.data.warningAlert, true);

        const list = await server.request('/api/system/backups', { token: auth.token });
        assert.equal(list.status, 200);
        assert.ok(list.data.backups.some(item => item.filename === created.data.filename));

        const noConfirmation = await server.request('/api/system/restore', {
            method: 'POST',
            token: auth.token,
            body: { filename: created.data.filename },
        });
        assert.equal(noConfirmation.status, 400);
        assert.equal(noConfirmation.data.code, 'RESTORE_CONFIRMATION_REQUIRED');

        const traversal = await server.request('/api/system/restore', {
            method: 'POST',
            token: auth.token,
            body: { filename: '../control/control.db', confirmation: 'RESTORE' },
        });
        assert.equal(traversal.status, 400);
        assert.equal(traversal.data.code, 'INVALID_BACKUP_FILENAME');

        const restored = await server.request('/api/system/restore', {
            method: 'POST',
            token: auth.token,
            body: { filename: created.data.filename, confirmation: 'RESTORE' },
        });
        assert.equal(restored.status, 200);
        assert.equal(restored.data.integrity, 'ok');

        const settings = await server.request('/api/settings', { token: auth.token });
        assert.equal(settings.status, 200);
        assert.equal(settings.data.warningAlert, false);
    } finally {
        await server.stop();
    }
});