const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

async function registerOwner(server, suffix, serial) {
    const response = await server.request('/api/auth/register', {
        method: 'POST',
        body: {
            fullName: '陈医生',
            phone: '13800000111',
            idCard: makeValidIdCard(serial),
            clinicName: '知微门诊',
            orgMode: 'single',
            storeRole: 'single',
            username: `visit_update_${suffix}`,
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

async function createVisit(server, token, patient = {}) {
    const response = await server.request('/api/visits/complete', {
        method: 'POST',
        token,
        body: {
            patient: { name: '修改患者', gender: '女', age: 36, diagnosis: '风寒感冒', ...patient },
            prescriptions: [
                { name: '当归', qty: 2, price: 25, qtyUnit: '袋' },
            ],
        },
    });
    assert.equal(response.status, 200);
    return response.data;
}

test('v5 修改未收费未发药病历会原位同步且不重复新增', async () => {
    const server = await startV5Server('visit-update-pending');
    try {
        const auth = await registerOwner(server, 'pending', 501);
        const visit = await createVisit(server, auth.token);

        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '修改患者', gender: '女', age: 36, diagnosis: '风热感冒', advice: '清淡饮食' },
                prescriptions: [
                    { name: '当归', qty: 3, price: 20, qtyUnit: '袋' },
                ],
            },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.data.updated, true);
        assert.equal(updated.data.billingAmount, 60);
        assert.equal(updated.data.pharmacyPushed, 1);
        assert.equal(updated.data.billId, visit.billId);

        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data.length, 1);
        assert.equal(outpatients.data[0].diagnosis, '风热感冒');
        assert.equal(outpatients.data[0].prescriptions[0].qty, 3);
        assert.equal(outpatients.data[0].prescriptions[0].price, 20);

        const profiles = await server.request('/api/patients', { token: auth.token });
        assert.equal(profiles.data.length, 1);
        assert.equal(profiles.data[0].visitCount, 1);
        assert.equal(profiles.data[0].visits.length, 1);
        assert.equal(profiles.data[0].visits[0].diagnosis, '风热感冒');
        assert.equal(profiles.data[0].visits[0].prescriptions[0].qty, 3);

        const bills = await server.request('/api/billing', { token: auth.token });
        assert.equal(bills.data.bills.length, 1);
        assert.equal(bills.data.bills[0].id, visit.billId);
        assert.equal(bills.data.bills[0].amount, 60);
        assert.equal(bills.data.bills[0].status, 'pending');
        assert.equal(bills.data.bills[0].items[0].qty, 3);

        const pharmacy = await server.request('/api/pharmacy', { token: auth.token });
        assert.equal(pharmacy.data.length, 1);
        assert.equal(pharmacy.data[0].qty, 3);
        assert.equal(pharmacy.data[0].status, '待发药');
    } finally {
        await server.stop();
    }
});

test('v5 已收费病历可更正处方并保留实收金额与唯一营收流水', async () => {
    const server = await startV5Server('visit-update-paid');
    try {
        const auth = await registerOwner(server, 'paid', 502);
        const visit = await createVisit(server, auth.token, { name: '已收费修改患者' });
        const paid = await server.request(`/api/billing/${visit.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '现金', receivedAmount: 50 },
        });
        assert.equal(paid.status, 200);

        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '已收费修改患者', diagnosis: '修正诊断', advice: '复诊提醒' },
                prescriptions: [{ name: '当归', qty: 3, price: 20, qtyUnit: '袋' }],
            },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.data.updated, true);
        assert.equal(updated.data.billingAmount, 60);
        assert.equal(updated.data.billId, visit.billId);

        const bills = await server.request('/api/billing', { token: auth.token });
        assert.equal(bills.data.bills.length, 1);
        assert.equal(bills.data.bills[0].id, visit.billId);
        assert.equal(bills.data.bills[0].status, 'paid');
        assert.equal(bills.data.bills[0].amount, 60);
        assert.equal(bills.data.bills[0].originalAmount, 60);
        assert.equal(bills.data.bills[0].actualAmount, 50);
        assert.equal(bills.data.bills[0].discountAmount, 10);
        assert.equal(bills.data.bills[0].items[0].qty, 3);

        const revenue = await server.request('/api/revenue', { token: auth.token });
        assert.equal(revenue.data.length, 1);
        assert.equal(revenue.data[0].billId, visit.billId);
        assert.equal(revenue.data[0].amount, 50);
        assert.equal(revenue.data[0].originalAmount, 60);

        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data.length, 1);
        assert.equal(outpatients.data[0].diagnosis, '修正诊断');
        assert.equal(outpatients.data[0].prescriptions[0].qty, 3);
    } finally {
        await server.stop();
    }
});
test('v5 已发药病历更正处方会回冲库存并保留撤销审计记录', async () => {
    const server = await startV5Server('visit-update-dispensed');
    try {
        const auth = await registerOwner(server, 'dispensed', 503);
        const stocked = await server.request('/api/drugInventory', {
            method: 'POST',
            token: auth.token,
            body: { name: '当归', stock: 10, quantity: 10, price: 25, unit: '盒' },
        });
        assert.equal(stocked.status, 201);

        const visit = await createVisit(server, auth.token, { name: '已发药修改患者' });
        const pharmacy = await server.request('/api/pharmacy', { token: auth.token });
        const dispensed = await server.request(`/api/pharmacy/dispense/${pharmacy.data[0].id}`, {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(dispensed.status, 200);

        const stockAfterDispense = await server.request('/api/drugInventory', { token: auth.token });
        assert.equal(stockAfterDispense.data[0].stock, 8);

        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '已发药修改患者', diagnosis: '复核后诊断' },
                prescriptions: [{ name: '当归', qty: 3, price: 20, qtyUnit: '袋' }],
            },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.data.inventoryReversed, 1);
        assert.equal(updated.data.pharmacyPushed, 1);

        const stockAfterCorrection = await server.request('/api/drugInventory', { token: auth.token });
        assert.equal(stockAfterCorrection.data[0].stock, 10);

        const correctedPharmacy = await server.request('/api/pharmacy', { token: auth.token });
        assert.equal(correctedPharmacy.data.length, 2);
        assert.equal(correctedPharmacy.data[0].status, '已撤销');
        assert.equal(correctedPharmacy.data[0].reversalReason, '门诊病历处方修改回冲');
        assert.equal(correctedPharmacy.data[1].status, '待发药');
        assert.equal(correctedPharmacy.data[1].qty, 3);

        const outRecords = await server.request('/api/drugOutRecords', { token: auth.token });
        assert.equal(outRecords.data.length, 2);
        assert.equal(outRecords.data[0].type, '发药');
        assert.equal(outRecords.data[1].type, '发药回冲');

        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data[0].diagnosis, '复核后诊断');
        assert.equal(outpatients.data[0].prescriptions[0].qty, 3);
    } finally {
        await server.stop();
    }
});
test('v5 修改姓名电话不会产生重复患者档案', async () => {
    const server = await startV5Server('visit-update-patient-key');
    try {
        const auth = await registerOwner(server, 'key', 504);
        const visit = await createVisit(server, auth.token, { name: '原名患者', phone: '13800000001' });
        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '改名患者', phone: '13800000002', diagnosis: '风寒感冒' },
                prescriptions: [{ name: '当归', qty: 2, price: 25, qtyUnit: '袋' }],
            },
        });
        assert.equal(updated.status, 200);
        const profiles = await server.request('/api/patients', { token: auth.token });
        assert.equal(profiles.data.length, 1);
        assert.equal(profiles.data[0].name, '改名患者');
        assert.equal(profiles.data[0].phone, '13800000002');
        assert.equal(profiles.data[0].visitCount, 1);
        assert.equal(profiles.data[0].visits.length, 1);
    } finally {
        await server.stop();
    }
});
