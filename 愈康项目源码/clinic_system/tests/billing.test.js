const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

async function registerOwner(server) {
    const response = await server.request('/api/auth/register', {
        method: 'POST',
        body: {
            fullName: '陈医生',
            phone: '13800000111',
            idCard: makeValidIdCard(301),
            clinicName: '知微门诊',
            orgMode: 'single',
            storeRole: 'single',
            username: 'billing_owner',
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

test('v5 接诊只生成待收费，支付后仅写一次营收并记录补打', async () => {
    const server = await startV5Server('billing');
    try {
        const auth = await registerOwner(server);
        const initialBilling = await server.request('/api/billing', { token: auth.token });
        assert.equal(initialBilling.status, 200);
        assert.deepEqual(initialBilling.data.bills, []);
        assert.ok(initialBilling.data.methods.includes('微信'));

        const visit = await server.request('/api/visits/complete', {
            method: 'POST',
            token: auth.token,
            body: {
                patient: { name: '刘女士', gender: '女', age: 35 },
                prescriptions: [
                    { name: '当归', qty: 2, price: 12.5, qtyUnit: '袋' },
                ],
            },
        });
        assert.equal(visit.status, 200);
        assert.equal(visit.data.billingAmount, 25);
        assert.equal(visit.data.billingStatus, 'pending');
        assert.ok(visit.data.billId);
        assert.match(visit.data.billNo, /^SF\d+$/);

        const pending = await server.request('/api/billing?status=pending', { token: auth.token });
        assert.equal(pending.data.bills.length, 1);
        assert.equal(pending.data.bills[0].status, 'pending');

        const revenueBeforePay = await server.request('/api/revenue', { token: auth.token });
        assert.deepEqual(revenueBeforePay.data, []);

        const insufficient = await server.request(`/api/billing/${visit.data.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '现金', receivedAmount: 20 },
        });
        assert.equal(insufficient.status, 400);
        assert.equal(insufficient.data.code, 'INSUFFICIENT_RECEIVED_AMOUNT');

        const paid = await server.request(`/api/billing/${visit.data.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '现金', receivedAmount: 30 },
        });
        assert.equal(paid.status, 200);
        assert.equal(paid.data.status, 'paid');
        assert.equal(paid.data.receivedAmount, 30);
        assert.equal(paid.data.changeAmount, 5);

        const revenueAfterPay = await server.request('/api/revenue', { token: auth.token });
        assert.equal(revenueAfterPay.data.length, 1);
        assert.equal(revenueAfterPay.data[0].amount, 25);
        assert.equal(revenueAfterPay.data[0].billId, visit.data.billId);

        const duplicate = await server.request(`/api/billing/${visit.data.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '微信', receivedAmount: 25 },
        });
        assert.equal(duplicate.status, 409);
        assert.equal(duplicate.data.code, 'BILL_ALREADY_PAID');
        assert.equal((await server.request('/api/revenue', { token: auth.token })).data.length, 1);

        const firstPrint = await server.request(`/api/billing/${visit.data.billId}/print`, {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(firstPrint.status, 200);
        assert.equal(firstPrint.data.printCount, 1);
        assert.equal(firstPrint.data.printHistory.length, 1);

        const reprint = await server.request(`/api/billing/${visit.data.billId}/print`, {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(reprint.status, 200);
        assert.equal(reprint.data.printCount, 2);
        assert.equal(reprint.data.printHistory.length, 2);
        assert.equal(reprint.data.lastPrintedBy, 'billing_owner');
    } finally {
        await server.stop();
    }
});