const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const patientService = require('./patientService');
const { newId, toNum, todayKey } = require('../utils/helpers');

async function completeVisitUnsafe(username, body) {
    const data = body || {};
    const outpatientId = data.outpatientId;
    const patient = data.patient || {};
    const prescriptions = Array.isArray(data.prescriptions) ? data.prescriptions : [];

    const cleanRx = [];
    for (const d of prescriptions) {
        const rxName = String(d.name || '').trim();
        const qty = toNum(d.qty);
        const price = Math.max(0, toNum(d.price));
        if (!rxName || qty <= 0) continue;
        cleanRx.push({
            name: rxName,
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
    const drugTotal = cleanRx.reduce((s, d) => s + d.subtotal, 0);

    const outpatients = await repo.readCollection(username, 'outpatients');
    const inventory = await repo.readCollection(username, 'drugInventory');

    let name = String(patient.name || '').trim();
    if (!name && outpatientId) {
        const op = outpatients.find(x => String(x.id) === String(outpatientId));
        if (op) name = String(op.name || '').trim();
    }
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');

    for (const d of cleanRx) {
        const inv = inventory.find(i => i.name === d.name);
        if (inv && toNum(inv.stock || inv.quantity) < d.qty) {
            throw new HttpError(400, `【库存不足】药品"${d.name}"当前库存仅 ${toNum(inv.stock || inv.quantity)} ${inv.unit || '盒'}，处方需要 ${d.qty}，请先入库或调整处方`, 'INSUFFICIENT_STOCK');
        }
    }

    if (outpatientId) {
        const editingIdx = outpatients.findIndex(o => String(o.id) === String(outpatientId));
        if (editingIdx !== -1 && outpatients[editingIdx].status === '已就诊') {
            throw new HttpError(403, '已保存的接诊记录只能查看，不能修改', 'VISIT_IMMUTABLE');
        }
    }

    const todayStr = todayKey();
    const nowISO = new Date().toISOString();
    const baseFields = {
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
        feeType: '自费',
        clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : {},
        prescriptions: cleanRx
    };

    let savedOutpatient = null;
    if (outpatientId) {
        const idx = outpatients.findIndex(o => String(o.id) === String(outpatientId));
        if (idx === -1) throw new HttpError(404, '门诊记录不存在，请刷新后重试', 'VISIT_NOT_FOUND');
        const op = outpatients[idx];
        savedOutpatient = {
            ...op,
            ...baseFields,
            name: op.name || name,
            gender: patient.gender !== undefined ? patient.gender : (op.gender || ''),
            age: patient.age !== undefined && patient.age !== '' ? patient.age : (op.age || ''),
            phone: patient.phone !== undefined ? patient.phone : (op.phone || ''),
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

    let revenueAmount = 0;
    if (drugTotal > 0) {
        const revenue = await repo.readCollection(username, 'revenue');
        revenue.push({
            id: newId(),
            date: todayStr,
            amount: +drugTotal.toFixed(2),
            desc: '门诊药品费',
            category: '门诊收费',
            payMethod: '自费',
            patient: savedOutpatient.name
        });
        await repo.writeCollection(username, 'revenue', revenue);
        revenueAmount = +drugTotal.toFixed(2);
    }

    let pharmacyPushed = 0;
    if (cleanRx.length > 0) {
        const settings = await repo.readCollection(username, 'settings');
        if (settings.autoPharmacy !== false) {
            const pharmacy = await repo.readCollection(username, 'pharmacy');
            for (const d of cleanRx) {
                pharmacy.push({
                    id: newId(),
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

    return { data: savedOutpatient, pharmacyPushed, revenueAmount };
}

async function completeVisit(username, body) {
    return repo.transaction(() => completeVisitUnsafe(username, body));
}

module.exports = {
    completeVisit
};
