const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId, toNum, todayKey } = require('../utils/helpers');

async function checkInventoryUnsafe(username, operator, body) {
    const items = Array.isArray(body && body.items) ? body.items : [];
    if (!items.length) throw new HttpError(400, '盘点数据不能为空', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const checks = await repo.readCollection(username, 'inventoryChecks');
    const details = [];
    let changed = 0;

    for (const it of items) {
        const actual = Number(it.actual);
        if (!Number.isFinite(actual) || actual < 0) continue;
        const drug = it.id
            ? inventory.find(d => String(d.id) === String(it.id))
            : inventory.find(d => d.name === it.name);
        if (!drug) continue;
        const oldStock = toNum(drug.stock || drug.quantity);
        if (oldStock !== actual) {
            drug.stock = actual;
            drug.updatedAt = new Date().toISOString();
            changed++;
        }
        details.push({ name: drug.name, oldStock, newStock: actual, diff: +(actual - oldStock).toFixed(2) });
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    checks.push({ id: newId(), date: new Date().toLocaleString(), operator, items: details });
    await repo.writeCollection(username, 'inventoryChecks', checks);
    return { success: true, changed, details };
}

async function stockInUnsafe(username, operator, body) {
    const { drugId, drugName, qty, batchNo, expiry, productionDate, supplier, cost, supplierId, unit, minStock, price } = body || {};
    const qtyNum = toNum(qty);
    if (!drugName || qtyNum <= 0) {
        throw new HttpError(400, '药品名称和数量不能为空，且数量必须大于0', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const drug = drugId
        ? inventory.find(d => String(d.id) === String(drugId))
        : inventory.find(d => d.name === drugName);

    let finalSupplierId = supplierId;
    if (supplier && !finalSupplierId) {
        const suppliers = await repo.readCollection(username, 'suppliers');
        let sup = suppliers.find(s => s.name === supplier);
        if (!sup) {
            sup = { id: newId(), name: supplier, contact: '', phone: '', address: '' };
            suppliers.push(sup);
            await repo.writeCollection(username, 'suppliers', suppliers);
        }
        finalSupplierId = sup.id;
    }

    if (drug) {
        drug.stock = toNum(drug.stock) + qtyNum;
        if (batchNo) drug.batchNo = batchNo;
        if (expiry) drug.expiry = expiry;
        if (productionDate) drug.productionDate = productionDate;
        if (supplier) drug.supplier = supplier;
        if (finalSupplierId) drug.supplierId = finalSupplierId;
        if (cost !== undefined && cost !== '') drug.costPrice = toNum(cost);
        if (price !== undefined && price !== '') drug.price = toNum(price);
        if (unit) drug.unit = unit;
        if (minStock !== undefined && minStock !== '') drug.minStock = toNum(minStock, 10);
        drug.purchaseDate = todayKey();
        drug.updatedAt = new Date().toISOString();
    } else {
        inventory.push({
            id: newId(),
            name: drugName,
            stock: qtyNum,
            unit: unit || '盒',
            minStock: minStock || 10,
            batchNo: batchNo || '',
            expiry: expiry || '',
            productionDate: productionDate || '',
            purchaseDate: todayKey(),
            supplier: supplier || '',
            supplierId: finalSupplierId || '',
            costPrice: toNum(cost),
            price: toNum(price),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    await repo.writeCollection(username, 'drugInventory', inventory);

    const inRecords = await repo.readCollection(username, 'drugInRecords');
    inRecords.push({
        id: newId(),
        drugName,
        qty: qtyNum,
        batchNo: batchNo || '',
        expiry: expiry || '',
        productionDate: productionDate || '',
        supplier: supplier || '',
        supplierId: finalSupplierId || '',
        cost: toNum(cost),
        date: new Date().toLocaleString(),
        operator
    });
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return { status: 201, data: { success: true } };
}

async function batchImportUnsafe(username, operator, body) {
    const items = (body && body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(400, '导入数据不能为空', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const suppliers = await repo.readCollection(username, 'suppliers');
    const inRecords = await repo.readCollection(username, 'drugInRecords');
    let added = 0;
    let updated = 0;
    const seenNames = new Set();

    for (const item of items) {
        const name = String(item.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);

        const supName = (item.supplier || '').trim();
        let finalSupplierId = '';
        if (supName) {
            let existingSup = suppliers.find(s => s.name === supName);
            if (!existingSup) {
                existingSup = {
                    id: newId(),
                    name: supName,
                    contact: '',
                    phone: '',
                    address: '',
                    createdAt: new Date().toISOString()
                };
                suppliers.push(existingSup);
            }
            finalSupplierId = existingSup.id;
        }

        const existing = inventory.find(d => d.name === name);
        if (existing) {
            if (item.stock !== undefined && item.stock !== '') existing.stock = toNum(existing.stock) + Math.max(0, toNum(item.stock));
            if (item.price !== undefined && item.price !== '') existing.price = toNum(item.price);
            if (item.costPrice !== undefined && item.costPrice !== '') existing.costPrice = toNum(item.costPrice);
            if (item.batchNo) existing.batchNo = item.batchNo;
            if (item.expiry) existing.expiry = item.expiry;
            if (supName) existing.supplier = supName;
            if (finalSupplierId) existing.supplierId = finalSupplierId;
            if (item.manufacturer) existing.manufacturer = item.manufacturer;
            if (item.spec) existing.spec = item.spec;
            if (item.unit) existing.unit = item.unit;
            if (item.category) existing.category = item.category;
            if (item.code) existing.code = item.code;
            if (item.approvalNo) existing.approvalNo = item.approvalNo;
            if (item.productionDate) existing.productionDate = item.productionDate;
            if (Math.max(0, toNum(item.stock)) > 0) existing.purchaseDate = item.purchaseDate || todayKey();
            existing.updatedAt = new Date().toISOString();
            updated++;
        } else {
            inventory.push({
                id: newId(),
                name,
                code: item.code || '',
                approvalNo: item.approvalNo || '',
                spec: item.spec || '',
                unit: item.unit || '盒',
                category: item.category || '',
                manufacturer: item.manufacturer || '',
                stock: Math.max(0, toNum(item.stock)),
                minStock: item.minStock || 10,
                price: toNum(item.price),
                costPrice: toNum(item.costPrice),
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                purchaseDate: item.purchaseDate || (Math.max(0, toNum(item.stock)) > 0 ? todayKey() : ''),
                supplier: supName || '',
                supplierId: finalSupplierId || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            added++;
        }

        const inQty = Math.max(0, toNum(item.stock));
        if (inQty > 0) {
            inRecords.push({
                id: newId(),
                drugName: name,
                qty: inQty,
                unit: item.unit || '盒',
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                supplier: supName || '',
                cost: toNum(item.costPrice),
                date: new Date().toLocaleString(),
                operator,
                source: 'Excel导入'
            });
        }
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    await repo.writeCollection(username, 'suppliers', suppliers);
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return { success: true, added, updated, total: items.length };
}

async function deleteDrugsUnsafe(username, body) {
    const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new HttpError(400, '请选择要删除的药品', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const kept = inventory.filter(item => !ids.includes(String(item.id)));
    await repo.writeCollection(username, 'drugInventory', kept);
    const removed = inventory.filter(item => ids.includes(String(item.id)));
    const removedNames = new Set(removed.map(item => String(item.name || '').trim()).filter(Boolean));
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const pendingKept = pharmacy.filter(item => !(item.status !== '已发药' && removedNames.has(String(item.drug || '').trim())));
    if (pendingKept.length !== pharmacy.length) await repo.writeCollection(username, 'pharmacy', pendingKept);
    return {
        success: true,
        deleted: inventory.length - kept.length,
        pendingRemoved: pharmacy.length - pendingKept.length
    };
}

async function checkInventory(username, operator, body) {
    return repo.transaction(() => checkInventoryUnsafe(username, operator, body));
}

async function stockIn(username, operator, body) {
    return repo.transaction(() => stockInUnsafe(username, operator, body));
}

async function batchImport(username, operator, body) {
    return repo.transaction(() => batchImportUnsafe(username, operator, body));
}

async function deleteDrugs(username, body) {
    return repo.transaction(() => deleteDrugsUnsafe(username, body));
}

module.exports = {
    checkInventory,
    stockIn,
    batchImport,
    deleteDrugs
};
