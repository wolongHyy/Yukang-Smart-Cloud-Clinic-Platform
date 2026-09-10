const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId, toNum } = require('../utils/helpers');

async function dispenseOneUnsafe(username, operator, id) {
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const item = pharmacy.find(p => String(p.id) === String(id));
    if (!item) throw new HttpError(404, '药房记录不存在', 'PHARMACY_ITEM_NOT_FOUND');
    if (item.status === '已发药') throw new HttpError(400, '该处方已发药，请勿重复操作', 'ALREADY_DISPENSED');

    const qty = toNum(item.qty);
    if (qty <= 0) throw new HttpError(400, '发药数量无效', 'INVALID_DISPENSE_QTY');

    const inventory = await repo.readCollection(username, 'drugInventory');
    const drug = inventory.find(d => d.name === item.drug);
    if (drug) {
        const stock = toNum(drug.stock || drug.quantity);
        if (stock < qty) {
            throw new HttpError(400, `库存不足："${item.drug}" 当前库存 ${stock} ${drug.unit || '盒'}，需发 ${qty}`, 'INSUFFICIENT_STOCK');
        }
        drug.stock = Math.max(0, stock - qty);
        drug.updatedAt = new Date().toISOString();
        await repo.writeCollection(username, 'drugInventory', inventory);
    }

    item.status = '已发药';
    item.dispensedAt = new Date().toISOString();
    await repo.writeCollection(username, 'pharmacy', pharmacy);

    const outRecords = await repo.readCollection(username, 'drugOutRecords');
    outRecords.push({
        id: newId(),
        drugName: item.drug,
        qty,
        patient: item.patient,
        type: '发药',
        date: new Date().toLocaleString(),
        operator
    });
    await repo.writeCollection(username, 'drugOutRecords', outRecords);
    return { success: true };
}

async function dispenseAllUnsafe(username, operator) {
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const pending = pharmacy.filter(p => p.status === '待发药');
    if (!pending.length) throw new HttpError(400, '当前没有待发药处方', 'NO_PENDING_PRESCRIPTIONS');

    const inventory = await repo.readCollection(username, 'drugInventory');
    const required = new Map();
    for (const item of pending) {
        const qty = toNum(item.qty);
        if (qty <= 0) {
            throw new HttpError(400, `存在无效发药数量：${item.drug || '未命名药品'}`, 'INVALID_DISPENSE_QTY');
        }
        const key = item.drug || '';
        required.set(key, (required.get(key) || 0) + qty);
    }

    for (const [drugName, qty] of required) {
        const drug = inventory.find(d => d.name === drugName);
        if (!drug) continue;
        const stock = toNum(drug.stock || drug.quantity);
        if (stock < qty) {
            throw new HttpError(400, `库存不足："${drugName}" 当前库存 ${stock} ${drug.unit || '盒'}，待发药合计需要 ${qty}`, 'INSUFFICIENT_STOCK');
        }
    }

    for (const [drugName, qty] of required) {
        const drug = inventory.find(d => d.name === drugName);
        if (!drug) continue;
        const stock = toNum(drug.stock || drug.quantity);
        drug.stock = Math.max(0, stock - qty);
        drug.updatedAt = new Date().toISOString();
    }

    const now = new Date().toISOString();
    pending.forEach(item => {
        item.status = '已发药';
        item.dispensedAt = now;
    });

    await repo.writeCollection(username, 'drugInventory', inventory);
    await repo.writeCollection(username, 'pharmacy', pharmacy);

    const outRecords = await repo.readCollection(username, 'drugOutRecords');
    const time = new Date().toLocaleString();
    pending.forEach(item => {
        outRecords.push({
            id: newId(),
            drugName: item.drug,
            qty: toNum(item.qty),
            patient: item.patient,
            type: '发药',
            date: time,
            operator
        });
    });
    await repo.writeCollection(username, 'drugOutRecords', outRecords);
    return {
        success: true,
        dispensedCount: pending.length,
        deductedCount: required.size
    };
}

async function dispenseOne(username, operator, id) {
    return repo.transaction(() => dispenseOneUnsafe(username, operator, id));
}

async function dispenseAll(username, operator) {
    return repo.transaction(() => dispenseAllUnsafe(username, operator));
}

module.exports = {
    dispenseOne,
    dispenseAll
};
