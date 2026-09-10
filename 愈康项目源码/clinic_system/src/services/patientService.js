const repo = require('../repository/sqliteRepository');
const { newId } = require('../utils/helpers');

async function migrateUnsafe(username) {
    const outpatients = await repo.readCollection(username, 'outpatients');
    const patients = await repo.readCollection(username, 'patients');
    const map = new Map((patients || []).map(p => [p.key, p]));
    const groups = {};
    for (const o of outpatients) {
        const name = String(o.name || '').trim();
        if (!name) continue;
        const phone = String(o.phone || '').trim();
        const key = (name + '|' + phone).toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(o);
    }

    let created = 0;
    let updated = 0;
    for (const key of Object.keys(groups)) {
        const list = groups[key].sort((a, b) => String(a.opDate || a.date).localeCompare(String(b.opDate || b.date)));
        const last = list[list.length - 1];
        const profile = {
            key,
            name: last.name,
            phone: last.phone || '',
            gender: last.gender || '',
            age: last.age || '',
            allergy: last.allergy || '',
            past: last.past || '',
            visitCount: list.length,
            lastVisit: last.opDate || last.date || '',
            visits: list.map(o => ({
                id: o.id,
                date: o.opDate || o.date,
                diagnosis: o.diagnosis || '',
                prescriptions: (o.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
            })),
            updatedAt: new Date().toISOString()
        };
        if (map.has(key)) {
            map.set(key, { ...map.get(key), ...profile });
            updated++;
        } else {
            map.set(key, { id: newId(), ...profile });
            created++;
        }
    }
    const out = [...map.values()];
    await repo.writeCollection(username, 'patients', out);
    return { success: true, total: out.length, created, updated };
}

async function upsertPatientUnsafe(username, outpatient) {
    const patients = await repo.readCollection(username, 'patients');
    const name = String(outpatient.name || '').trim();
    if (!name) return;
    const phone = String(outpatient.phone || '').trim();
    const key = (name + '|' + phone).toLowerCase();
    const idx = patients.findIndex(p => p.key === key);
    const visit = {
        id: outpatient.id,
        date: outpatient.opDate || outpatient.date || '',
        diagnosis: outpatient.diagnosis || '',
        prescriptions: (outpatient.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
    };
    const profile = {
        key,
        name,
        phone,
        gender: outpatient.gender || '',
        age: outpatient.age || '',
        allergy: outpatient.allergy || '',
        past: outpatient.past || '',
        visitCount: (idx >= 0 ? patients[idx].visitCount : 0) + 1,
        lastVisit: outpatient.opDate || outpatient.date || '',
        visits: idx >= 0 ? [...(patients[idx].visits || []), visit] : [visit],
        updatedAt: new Date().toISOString()
    };
    if (idx >= 0) patients[idx] = { ...patients[idx], ...profile };
    else patients.push({ id: newId(), ...profile });
    await repo.writeCollection(username, 'patients', patients);
}

async function migrate(username) {
    return repo.transaction(() => migrateUnsafe(username));
}

async function upsertPatient(username, outpatient) {
    return repo.transaction(() => upsertPatientUnsafe(username, outpatient));
}

module.exports = {
    migrate,
    upsertPatient
};
