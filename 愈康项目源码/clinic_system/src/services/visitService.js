const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const patientService = require('./patientService');
const billingService = require('./billingService');
const { newId, toNum, todayKey } = require('../utils/helpers');

function normalizePrescriptionItems(prescriptions) {
    const cleanRx = [];
    for (const d of prescriptions || []) {
        const name = String(d.name || '').trim();
        const qty = toNum(d.qty);
        const price = Math.max(0, toNum(d.price));
        if (!name || qty <= 0) continue;
        cleanRx.push({
            name,
            spec: String(d.spec || '').trim(),
            dosage: d.dosage === undefined ? '' : String(d.dosage),
            dosageUnit: String(d.dosageUnit || '').trim(),
            usage: String(d.usage || '').trim(),
            frequency: String(d.frequency || '').trim(),
            qty,
            qtyUnit: String(d.qtyUnit || '').trim(),
            prescriptionType: String(d.prescriptionType || '').trim(),
            price,
            subtotal: +(qty * price).toFixed(2)
        });
    }
    return cleanRx;
}

function prescriptionSignature(items) {
    return JSON.stringify((items || []).map(item => ({
        name: String(item.name || '').trim(),
        spec: String(item.spec || '').trim(),
        dosage: String(item.dosage || '').trim(),
        dosageUnit: String(item.dosageUnit || '').trim(),
        usage: String(item.usage || '').trim(),
        frequency: String(item.frequency || '').trim(),
        qty: Number(item.qty || 0),
        qtyUnit: String(item.qtyUnit || '').trim(),
        prescriptionType: String(item.prescriptionType || '').trim(),
        price: Number(item.price || 0),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'zh-CN')));
}

function inventoryStock(item) {
    if (!item) return 0;
    if (item.stock !== undefined && item.stock !== null && item.stock !== '') return toNum(item.stock);
    return toNum(item.quantity);
}

async function assertInventoryAvailable(username, cleanRx) {
    if (!cleanRx.length) return;
    const inventory = await repo.readCollection(username, 'drugInventory');
    for (const d of cleanRx) {
        const inv = inventory.find(i => String(i.name || '').trim() === String(d.name || '').trim());
        if (inv && inventoryStock(inv) < d.qty) {
            throw new HttpError(400, `【库存不足】药品${d.name}当前库存仅 ${inventoryStock(inv)} ${inv.unit || '盒'}，处方需要 ${d.qty}，请先入库或调整处方`, 'INSUFFICIENT_STOCK');
        }
    }
}

async function reverseDispensedInventoryUnsafe(username, dispensedItems) {
    const totals = new Map();
    for (const item of dispensedItems || []) {
        const name = String(item.drug || item.name || '').trim();
        const qty = toNum(item.qty);
        if (!name || qty <= 0) continue;
        const current = totals.get(name) || { qty: 0, unit: item.qtyUnit || '', price: Number(item.price) || 0 };
        current.qty += qty;
        current.unit = current.unit || item.qtyUnit || '';
        current.price = Number(current.price) || Number(item.price) || 0;
        totals.set(name, current);
    }
    if (!totals.size) return 0;

    const inventory = await repo.readCollection(username, 'drugInventory');
    const nowISO = new Date().toISOString();
    for (const [name, info] of totals) {
        const existing = inventory.find(item => String(item.name || '').trim() === name);
        if (existing) {
            const nextStock = +(inventoryStock(existing) + info.qty).toFixed(4);
            if (existing.stock === undefined && existing.quantity !== undefined) existing.quantity = nextStock;
            else existing.stock = nextStock;
            existing.updatedAt = nowISO;
        } else {
            inventory.push({
                id: newId(),
                name,
                stock: +info.qty.toFixed(4),
                unit: info.unit || '盒',
                price: Number(info.price) || 0,
                category: '未归类',
                updatedAt: nowISO,
                categorySource: '发药回冲恢复库存，未据名称猜测分类'
            });
        }
    }
    await repo.writeCollection(username, 'drugInventory', inventory);
    return totals.size;
}

function pharmacyItemBelongsToOutpatient(item, outpatient) {
    if (String(item.outpatientId || '') === String(outpatient.id)) return true;
    if (item.outpatientId) return false;
    if (String(item.patient || '') !== String(outpatient.name || '')) return false;
    return (outpatient.prescriptions || []).some(rx =>
        String(rx.name || '') === String(item.drug || '') &&
        Number(rx.qty || 0) === Number(item.qty || 0)
    );
}

function buildVisitFields(patient, cleanRx) {
    return {
        chief: String(patient.chief || '').trim(),
        history: String(patient.history || '').trim(),
        past: String(patient.past || '').trim(),
        allergy: String(patient.allergy || '').trim(),
        exam: String(patient.exam || '').trim(),
        tcm: String(patient.tcm || '').trim(),
        diagnosis: String(patient.diagnosis || '').trim(),
        syndrome: String(patient.syndrome || '').trim(),
        advice: String(patient.advice || '').trim(),
        visitType: patient.visitType || '初诊',
        doctor: patient.doctor !== undefined ? String(patient.doctor || '').trim() : '',
        feeType: patient.feeType !== undefined ? (String(patient.feeType || '').trim() || '自费') : '自费',
        clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : {},
        prescriptions: cleanRx
    };
}

async function completeVisitUnsafe(username, body) {
    const data = body || {};
    const outpatientId = data.outpatientId;
    const patient = data.patient || {};
    const cleanRx = normalizePrescriptionItems(data.prescriptions);
    const drugTotal = cleanRx.reduce((sum, item) => sum + item.subtotal, 0);
    const outpatients = await repo.readCollection(username, 'outpatients');

    let name = String(patient.name || '').trim();
    if (!name && outpatientId) {
        const existing = outpatients.find(item => String(item.id) === String(outpatientId));
        if (existing) name = String(existing.name || '').trim();
    }
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');
    await assertInventoryAvailable(username, cleanRx);

    if (outpatientId) {
        const existing = outpatients.find(item => String(item.id) === String(outpatientId));
        if (existing && existing.status === '已就诊') {
            throw new HttpError(403, '已保存的接诊记录请使用修改病历功能', 'VISIT_IMMUTABLE');
        }
    }

    const todayStr = todayKey();
    const nowISO = new Date().toISOString();
    const baseFields = buildVisitFields(patient, cleanRx);
    let savedOutpatient = null;

    if (outpatientId) {
        const idx = outpatients.findIndex(item => String(item.id) === String(outpatientId));
        if (idx === -1) throw new HttpError(404, '门诊记录不存在，请刷新后重试', 'VISIT_NOT_FOUND');
        const original = outpatients[idx];
        savedOutpatient = {
            ...original,
            ...baseFields,
            name: original.name || name,
            gender: patient.gender !== undefined ? patient.gender : (original.gender || ''),
            age: patient.age !== undefined && patient.age !== '' ? patient.age : (original.age || ''),
            phone: patient.phone !== undefined ? patient.phone : (original.phone || ''),
            status: '已就诊',
            updatedAt: nowISO
        };
        outpatients[idx] = savedOutpatient;
    } else {
        savedOutpatient = {
            id: newId(),
            name,
            gender: patient.gender || '',
            age: patient.age || '',
            phone: patient.phone || '',
            ...baseFields,
            status: '已就诊',
            date: todayStr,
            opDate: todayStr,
            source: 'direct',
            createdAt: nowISO,
            updatedAt: nowISO
        };
        outpatients.push(savedOutpatient);
    }
    await repo.writeCollection(username, 'outpatients', outpatients);
    await patientService.upsertPatient(username, savedOutpatient);

    let pendingBill = null;
    if (drugTotal > 0) {
        pendingBill = await billingService.createPendingBill(username, {
            outpatientId: savedOutpatient.id,
            patientName: savedOutpatient.name,
            amount: +drugTotal.toFixed(2),
            items: cleanRx,
        });
    }

    let pharmacyPushed = 0;
    if (cleanRx.length > 0) {
        const settings = await repo.readCollection(username, 'settings');
        if (settings.autoPharmacy !== false) {
            const pharmacy = await repo.readCollection(username, 'pharmacy');
            for (const d of cleanRx) {
                pharmacy.push({
                    id: newId(),
                    outpatientId: savedOutpatient.id,
                    patient: savedOutpatient.name,
                    drug: d.name,
                    qty: d.qty,
                    price: d.price,
                    status: '待发药',
                    date: new Date().toLocaleString(),
                    source: '门诊处方'
                });
            }
            await repo.writeCollection(username, 'pharmacy', pharmacy);
            pharmacyPushed = cleanRx.length;
        }
    }

    return {
        data: savedOutpatient,
        pharmacyPushed,
        billingAmount: pendingBill ? pendingBill.amount : 0,
        billId: pendingBill ? pendingBill.id : null,
        billNo: pendingBill ? pendingBill.billNo : null,
        billingStatus: pendingBill ? pendingBill.status : null,
    };
}

async function updateSavedVisitUnsafe(username, id, body) {
    const data = body || {};
    const patient = data.patient || {};
    const cleanRx = normalizePrescriptionItems(data.prescriptions);
    const outpatients = await repo.readCollection(username, 'outpatients');
    const index = outpatients.findIndex(item => String(item.id) === String(id));
    if (index === -1) throw new HttpError(404, '门诊记录不存在，请刷新后重试', 'VISIT_NOT_FOUND');

    const previous = {
        ...outpatients[index],
        prescriptions: (outpatients[index].prescriptions || []).map(item => ({ ...item }))
    };
    if (previous.status !== '已就诊') {
        throw new HttpError(409, '该门诊尚未保存完成，请使用保存接诊', 'VISIT_NOT_SAVED');
    }

    const name = String(patient.name || previous.name || '').trim();
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');
    const previousRx = normalizePrescriptionItems(previous.prescriptions);
    const rxChanged = prescriptionSignature(previousRx) !== prescriptionSignature(cleanRx);
    const drugTotal = +cleanRx.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2);

    const bills = await repo.readCollection(username, 'billing');
    const linkedBillIndexes = bills
        .map((item, idx) => ({ item, idx }))
        .filter(entry => String(entry.item.outpatientId || '') === String(id));
    const pendingEntries = linkedBillIndexes.filter(entry => entry.item.status === 'pending');
    const paidEntries = linkedBillIndexes.filter(entry => entry.item.status === 'paid');

    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const linkedPharmacy = pharmacy.filter(item => pharmacyItemBelongsToOutpatient(item, previous));
    const dispensedItems = linkedPharmacy.filter(item => item.status === '已发药');

    // 已发药病历修改时先回冲旧库存，再按新处方校验。旧发药记录保留为审计记录。
    let inventoryReversed = 0;
    if (rxChanged && dispensedItems.length) {
        inventoryReversed = await reverseDispensedInventoryUnsafe(username, dispensedItems);
        const outRecords = await repo.readCollection(username, 'drugOutRecords');
        const reversedAt = new Date().toISOString();
        for (const item of dispensedItems) {
            const qty = toNum(item.qty);
            if (qty <= 0) continue;
            outRecords.push({
                id: newId(),
                drugName: item.drug,
                qty,
                patient: item.patient || previous.name || '',
                type: '发药回冲',
                reason: '门诊病历处方修改回冲',
                date: new Date().toLocaleString(),
                operator: username,
                reversedAt,
                pharmacyId: item.id || ''
            });
        }
        await repo.writeCollection(username, 'drugOutRecords', outRecords);
    }
    if (rxChanged) await assertInventoryAvailable(username, cleanRx);

    const nowISO = new Date().toISOString();
    const patientFields = {
        ...buildVisitFields(patient, cleanRx),
        name,
        gender: patient.gender !== undefined ? patient.gender : (previous.gender || ''),
        age: patient.age !== undefined && patient.age !== '' ? patient.age : (previous.age || ''),
        phone: patient.phone !== undefined ? patient.phone : (previous.phone || ''),
        doctor: patient.doctor !== undefined ? String(patient.doctor || '').trim() : (previous.doctor || ''),
        feeType: patient.feeType !== undefined ? (String(patient.feeType || '').trim() || '自费') : (previous.feeType || '自费'),
        status: '已就诊',
        updatedAt: nowISO,
        clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : (previous.clinicData || {}),
    };
    const savedOutpatient = { ...previous, ...patientFields };
    outpatients[index] = savedOutpatient;
    await repo.writeCollection(username, 'outpatients', outpatients);
    await patientService.updatePatientVisitUnsafe(username, previous, savedOutpatient);

    let pendingBill = null;
    let paidBill = null;
    const removeBillIndexes = new Set();
    let billsChanged = false;
    for (let i = 1; i < pendingEntries.length; i += 1) removeBillIndexes.add(pendingEntries[i].idx);

    if (pendingEntries.length) {
        const firstIndex = pendingEntries[0].idx;
        if (drugTotal > 0) {
            pendingBill = {
                ...bills[firstIndex],
                patientName: savedOutpatient.name,
                amount: drugTotal,
                items: cleanRx,
                updatedAt: nowISO,
            };
            bills[firstIndex] = pendingBill;
        } else {
            removeBillIndexes.add(firstIndex);
        }
        billsChanged = true;
    }

    // 已收费病历允许更正处方。收费记录保持同一个 billId，并保留原支付方式、实收、收款人和打印历史。
    for (const entry of paidEntries) {
        const current = bills[entry.idx];
        const actualAmount = toNum(current.actualAmount !== undefined ? current.actualAmount : current.amount);
        const originalAmount = drugTotal;
        const updatedPaidBill = {
            ...current,
            patientName: savedOutpatient.name,
            amount: originalAmount,
            items: cleanRx,
            originalAmount,
            discountAmount: +Math.max(0, originalAmount - actualAmount).toFixed(2),
            adjustmentAmount: +(actualAmount - originalAmount).toFixed(2),
            updatedAt: nowISO,
        };
        bills[entry.idx] = updatedPaidBill;
        if (!paidBill) paidBill = updatedPaidBill;
        billsChanged = true;
    }

    for (const entry of linkedBillIndexes) {
        if (entry.item.patientName !== savedOutpatient.name) {
            bills[entry.idx] = { ...bills[entry.idx], patientName: savedOutpatient.name, updatedAt: nowISO };
            billsChanged = true;
        }
    }
    if (removeBillIndexes.size) {
        const keptBills = bills.filter((_, idx) => !removeBillIndexes.has(idx));
        bills.splice(0, bills.length, ...keptBills);
        billsChanged = true;
    }
    if (billsChanged) await repo.writeCollection(username, 'billing', bills);

    // 收入流水按 billId 原位更新，避免修正处方后产生重复收费记录。
    if (paidEntries.length) {
        const revenue = await repo.readCollection(username, 'revenue');
        let revenueChanged = false;
        for (const entry of paidEntries) {
            const bill = bills[entry.idx];
            const amount = toNum(bill.actualAmount !== undefined ? bill.actualAmount : bill.amount);
            const revenueIndex = revenue.findIndex(item => String(item.billId || '') === String(bill.id));
            if (revenueIndex === -1) {
                revenue.push({
                    id: newId(),
                    date: todayKey(),
                    amount,
                    originalAmount: bill.originalAmount,
                    discountAmount: bill.discountAmount,
                    adjustmentAmount: bill.adjustmentAmount,
                    adjustmentReason: bill.adjustmentReason || '',
                    desc: '门诊药品费',
                    category: '门诊收费',
                    payMethod: bill.payMethod || '',
                    patient: savedOutpatient.name,
                    billId: bill.id,
                    billNo: bill.billNo,
                    outpatientId: savedOutpatient.id,
                    operator: bill.operator || username,
                    paidAt: bill.paidAt || nowISO,
                });
            } else {
                revenue[revenueIndex] = {
                    ...revenue[revenueIndex],
                    amount,
                    originalAmount: bill.originalAmount,
                    discountAmount: bill.discountAmount,
                    adjustmentAmount: bill.adjustmentAmount,
                    adjustmentReason: bill.adjustmentReason || '',
                    payMethod: bill.payMethod || revenue[revenueIndex].payMethod || '',
                    patient: savedOutpatient.name,
                    billNo: bill.billNo || revenue[revenueIndex].billNo,
                    outpatientId: savedOutpatient.id,
                };
            }
            revenueChanged = true;
        }
        if (revenueChanged) await repo.writeCollection(username, 'revenue', revenue);
    }

    if (!pendingEntries.length && drugTotal > 0 && !paidEntries.length) {
        pendingBill = await billingService.createPendingBill(username, {
            outpatientId: savedOutpatient.id,
            patientName: savedOutpatient.name,
            amount: drugTotal,
            items: cleanRx,
        });
    }

    let pharmacyPushed = 0;
    if (rxChanged) {
        // 未发药记录可以原位替换；已发药记录已在上方回冲库存并标记为已撤销，不能删除。
        const reusableIds = linkedPharmacy
            .filter(item => item.status === '待发药')
            .map(item => item.id);
        const pendingIds = new Set(linkedPharmacy
            .filter(item => item.status === '待发药')
            .map(item => String(item.id)));
        let keptPharmacy = pharmacy.filter(item => !pendingIds.has(String(item.id)));

        if (dispensedItems.length) {
            const dispensedIds = new Set(dispensedItems.map(item => String(item.id)));
            keptPharmacy = keptPharmacy.map(item => dispensedIds.has(String(item.id))
                ? {
                    ...item,
                    status: '已撤销',
                    reversedAt: nowISO,
                    reversalReason: '门诊病历处方修改回冲'
                }
                : item);
        }

        const settings = await repo.readCollection(username, 'settings');
        if (settings.autoPharmacy !== false && cleanRx.length > 0) {
            cleanRx.forEach((drug, idx) => {
                keptPharmacy.push({
                    id: reusableIds[idx] || newId(),
                    outpatientId: savedOutpatient.id,
                    patient: savedOutpatient.name,
                    drug: drug.name,
                    qty: drug.qty,
                    price: drug.price,
                    status: '待发药',
                    date: new Date().toLocaleString(),
                    source: '门诊处方'
                });
            });
            pharmacyPushed = cleanRx.length;
        }

        if (linkedPharmacy.length || pharmacyPushed || dispensedItems.length) {
            await repo.writeCollection(username, 'pharmacy', keptPharmacy);
        }
    }

    return {
        data: savedOutpatient,
        updated: true,
        pharmacyPushed,
        inventoryReversed,
        billingAmount: drugTotal,
        billId: pendingBill ? pendingBill.id : (paidBill ? paidBill.id : null),
        billNo: pendingBill ? pendingBill.billNo : (paidBill ? paidBill.billNo : null),
        billingStatus: pendingBill ? pendingBill.status : (paidBill ? paidBill.status : null),
    };
}


async function completeVisit(username, body) {
    return repo.transaction(() => completeVisitUnsafe(username, body));
}

async function updateSavedVisit(username, id, body) {
    return repo.transaction(() => updateSavedVisitUnsafe(username, id, body));
}

module.exports = {
    completeVisit,
    updateSavedVisit
};
