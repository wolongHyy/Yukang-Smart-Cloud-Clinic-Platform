const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId, toNum, todayKey } = require('../utils/helpers');

const PAY_METHODS = ['现金', '微信', '支付宝', '银行卡', '医保', '其他'];

function makeBillNo() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `SF${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function normalizePayment(body, amount) {
    const payMethod = String((body && body.payMethod) || '').trim();
    if (!PAY_METHODS.includes(payMethod)) throw new HttpError(400, '请选择有效的支付方式', 'INVALID_PAY_METHOD');
    const receivedAmount = toNum(body && body.receivedAmount, NaN);
    if (!Number.isFinite(receivedAmount) || receivedAmount < amount) {
        throw new HttpError(400, '实收金额不能小于应收金额', 'INSUFFICIENT_RECEIVED_AMOUNT');
    }
    return { payMethod, receivedAmount: +receivedAmount.toFixed(2), changeAmount: +(receivedAmount - amount).toFixed(2) };
}

async function createPendingBill(username, details = {}) {
    const bills = await repo.readCollection(username, 'billing');
    const amount = +toNum(details.amount).toFixed(2);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const bill = {
        id: newId(),
        billNo: makeBillNo(),
        outpatientId: String(details.outpatientId || ''),
        patientName: String(details.patientName || '').trim(),
        amount,
        items: Array.isArray(details.items) ? details.items : [],
        status: 'pending',
        printCount: 0,
        createdAt: new Date().toISOString(),
    };
    bills.push(bill);
    await repo.writeCollection(username, 'billing', bills);
    return bill;
}
async function listBills(username, query = {}) {
    const bills = await repo.readCollection(username, 'billing');
    const status = String(query.status || '').trim();
    const keyword = String(query.keyword || '').trim();
    return bills
        .filter(item => !status || item.status === status)
        .filter(item => !keyword || String(item.patientName || '').includes(keyword) || String(item.billNo || '').includes(keyword))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function payBillUnsafe(username, operator, id, body) {
    const bills = await repo.readCollection(username, 'billing');
    const index = bills.findIndex(item => String(item.id) === String(id));
    if (index === -1) throw new HttpError(404, '待收费记录不存在', 'BILL_NOT_FOUND');
    const bill = bills[index];
    if (bill.status === 'paid') throw new HttpError(409, '该收费单已完成收费，请勿重复提交', 'BILL_ALREADY_PAID');
    const amount = +toNum(bill.amount).toFixed(2);
    if (amount <= 0) throw new HttpError(400, '收费金额无效', 'INVALID_BILL_AMOUNT');
    const payment = normalizePayment(body, amount);
    const paidAt = new Date().toISOString();

    bills[index] = {
        ...bill,
        status: 'paid',
        payMethod: payment.payMethod,
        receivedAmount: payment.receivedAmount,
        changeAmount: payment.changeAmount,
        operator,
        paidAt,
        printCount: Number(bill.printCount) || 0,
        paymentIdempotencyKey: bill.id,
    };
    await repo.writeCollection(username, 'billing', bills);

    const revenue = await repo.readCollection(username, 'revenue');
    revenue.push({
        id: newId(),
        date: todayKey(),
        amount,
        desc: '门诊药品费',
        category: '门诊收费',
        payMethod: payment.payMethod,
        patient: bill.patientName || '',
        billId: bill.id,
        billNo: bill.billNo,
        outpatientId: bill.outpatientId || '',
        operator,
        paidAt,
    });
    await repo.writeCollection(username, 'revenue', revenue);
    return bills[index];
}

async function payBill(username, operator, id, body) {
    return repo.transaction(() => payBillUnsafe(username, operator, id, body));
}

async function markPrintedUnsafe(username, id) {
    const bills = await repo.readCollection(username, 'billing');
    const index = bills.findIndex(item => String(item.id) === String(id));
    if (index === -1) throw new HttpError(404, '收费单不存在', 'BILL_NOT_FOUND');
    if (bills[index].status !== 'paid') throw new HttpError(400, '待收费记录不能打印收费单', 'BILL_NOT_PAID');
    const printedAt = new Date().toISOString();
    bills[index].printCount = Number(bills[index].printCount || 0) + 1;
    bills[index].lastPrintedAt = printedAt;
    bills[index].lastPrintedBy = username;
    bills[index].printHistory = Array.isArray(bills[index].printHistory) ? bills[index].printHistory : [];
    bills[index].printHistory.push({ printedAt, operator: username, printCount: bills[index].printCount });
    await repo.writeCollection(username, 'billing', bills);
    return bills[index];
}

async function markPrinted(username, id) {
    return repo.transaction(() => markPrintedUnsafe(username, id));
}

module.exports = { PAY_METHODS, createPendingBill, listBills, payBill, markPrinted };