const repo = require('../repository/sqliteRepository');
const { toNum, parseDate, toDateKey, todayKey } = require('../utils/helpers');

async function enhanced(username, query) {
    const range = query.range || '1m';
    const now = new Date();
    let startDate;
    let label;
    if (range === '1m') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        label = '近一月';
    } else if (range === '3m') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        label = '近三月';
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        label = '近半年';
    }

    const outpatients = await repo.readCollection(username, 'outpatients');
    const drugInventory = await repo.readCollection(username, 'drugInventory');
    const opIn = outpatients.filter(o => {
        const dt = parseDate(o.opDate || o.date);
        return dt && dt >= startDate && dt <= now;
    });
    const rxByDay = {};
    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) rxByDay[toDateKey(d)] = 0;

    const invMap = new Map(drugInventory.map(d => [d.name, d]));
    let grossProfit = 0;
    let rxTotal = 0;
    for (const o of opIn) {
        const rx = o.prescriptions || [];
        rxTotal += rx.length;
        const k = toDateKey(o.opDate || o.date);
        if (k && rxByDay[k] !== undefined) rxByDay[k] += rx.length;
        for (const d of rx) {
            const inv = invMap.get(d.name);
            const cost = inv ? toNum(inv.costPrice) : 0;
            grossProfit += (toNum(d.price) - cost) * toNum(d.qty);
        }
    }

    const grp = {};
    opIn.forEach(o => {
        const key = (String(o.name || '') + '|' + String(o.phone || '')).toLowerCase();
        grp[key] = (grp[key] || 0) + 1;
    });
    const totalPatients = Object.keys(grp).length;
    const revisitPatients = Object.values(grp).filter(n => n >= 2).length;
    return {
        range,
        label,
        rxTrend: Object.keys(rxByDay).sort().map(date => ({ date, value: rxByDay[date] })),
        rxTotal,
        grossProfit: +grossProfit.toFixed(2),
        totalPatients,
        revisitPatients,
        revisitRate: totalPatients ? +(revisitPatients / totalPatients * 100).toFixed(1) : 0
    };
}

async function dashboard(username, query) {
    const period = query.period || 'today';
    const now = new Date();
    let startDate;
    let endDate;
    if (period === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (period === 'yesterday') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
        const day = now.getDay() || 7;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
        endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
    } else if (period === 'month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    }

    const outpatients = await repo.readCollection(username, 'outpatients');
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const revenue = await repo.readCollection(username, 'revenue');
    const drugInventory = await repo.readCollection(username, 'drugInventory');

    const inRange = d => {
        const dt = parseDate(d);
        return dt && dt >= startDate && dt < endDate;
    };
    const opInPeriod = outpatients.filter(o => inRange(o.opDate || o.date));
    const pharmaInPeriod = pharmacy.filter(p => inRange(p.date));
    const revInPeriod = revenue.filter(r => inRange(r.date));

    const tKey = todayKey();
    const todayOp = outpatients.filter(o => toDateKey(o.opDate || o.date) === tKey);
    const todayPharma = pharmacy.filter(p => toDateKey(p.date) === tKey);

    const totalRev = revInPeriod.reduce((s, r) => s + toNum(r.amount), 0);
    const outpatientRev = revInPeriod.filter(r => (r.desc || '').includes('门诊')).reduce((s, r) => s + toNum(r.amount), 0);
    const retailRev = revInPeriod.filter(r => (r.desc || '').includes('零售')).reduce((s, r) => s + toNum(r.amount), 0);
    const opCount = opInPeriod.length;
    const retailCount = pharmaInPeriod.filter(p => p.source === 'retail' || !p.patient).length;
    const opAvg = opCount > 0 ? outpatientRev / opCount : 0;
    const retailAvg = retailCount > 0 ? retailRev / retailCount : 0;

    const payMap = {};
    revInPeriod.forEach(r => {
        const m = r.payMethod || r.method || '未分类';
        payMap[m] = (payMap[m] || 0) + toNum(r.amount);
    });
    const feeMap = {};
    revInPeriod.forEach(r => {
        const c = r.category || r.desc || '未分类';
        feeMap[c] = (feeMap[c] || 0) + toNum(r.amount);
    });
    const detailMap = {};
    revInPeriod.forEach(r => {
        const d = r.desc || '未分类';
        detailMap[d] = (detailMap[d] || 0) + toNum(r.amount);
    });

    const warningDrugs = drugInventory.filter(d => {
        const exp = parseDate(d.expiry);
        if (!exp) return false;
        const diff = (exp - now) / (1000 * 60 * 60 * 24);
        return diff <= 30;
    });
    const lowStockDrugs = drugInventory.filter(d => {
        const qty = toNum(d.stock || d.quantity);
        const min = toNum(d.minStock, 10);
        return qty <= min;
    });

    return {
        period,
        today: {
            visitCount: todayOp.length,
            pendingDrug: todayPharma.filter(p => p.status === '待发药').length,
            expiryWarning: warningDrugs.length,
            visited: todayOp.length,
            prescriptionCount: todayOp.filter(o => o.prescriptions && o.prescriptions.length > 0).length,
            billed: todayOp.filter(o => o.billed).length,
            dispensed: todayPharma.filter(p => p.status === '已发药').length,
            stockWarning: lowStockDrugs.length
        },
        revenue: {
            total: totalRev,
            outpatient: outpatientRev,
            retail: retailRev,
            opVisits: opCount,
            retailCustomers: retailCount,
            opAvgPrice: opAvg,
            retailAvgPrice: retailAvg
        },
        charts: {
            payMethod: Object.entries(payMap).map(([name, value]) => ({ name, value })),
            feeCategory: Object.entries(feeMap).map(([name, value]) => ({ name, value })),
            detailCategory: Object.entries(detailMap).map(([name, value]) => ({ name, value }))
        },
        warnings: { expiryDrugs: warningDrugs, lowStockDrugs: lowStockDrugs }
    };
}

async function revenueStats(username, query) {
    const period = query.period || 'today';
    const now = new Date();
    let startDate;
    let endDate;
    let label;
    if (period === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        label = '今天';
    } else if (period === 'yesterday') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        label = '昨天';
    } else if (period === 'week') {
        const day = now.getDay() || 7;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
        endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
        label = '本周';
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        label = '本月';
    }

    const revenue = await repo.readCollection(username, 'revenue');
    const outpatients = await repo.readCollection(username, 'outpatients');
    const pharmacy = await repo.readCollection(username, 'pharmacy');

    const inRange = d => {
        const dt = parseDate(d);
        return dt && dt >= startDate && dt < endDate;
    };
    const revInPeriod = revenue.filter(r => inRange(r.date));
    const opInPeriod = outpatients.filter(o => inRange(o.opDate || o.date));
    const pharmaInPeriod = pharmacy.filter(p => inRange(p.date));

    const totalRev = revInPeriod.reduce((s, r) => s + toNum(r.amount), 0);
    const outpatientRev = revInPeriod.filter(r => (r.desc || '').includes('门诊')).reduce((s, r) => s + toNum(r.amount), 0);
    const retailRev = revInPeriod.filter(r => (r.desc || '').includes('零售')).reduce((s, r) => s + toNum(r.amount), 0);
    const payMap = {};
    revInPeriod.forEach(r => {
        const m = r.payMethod || r.method || '未分类';
        payMap[m] = (payMap[m] || 0) + toNum(r.amount);
    });
    const feeMap = {};
    revInPeriod.forEach(r => {
        const c = r.category || '未分类';
        feeMap[c] = (feeMap[c] || 0) + toNum(r.amount);
    });
    const detailMap = {};
    revInPeriod.forEach(r => {
        const d = r.desc || '未分类';
        detailMap[d] = (detailMap[d] || 0) + toNum(r.amount);
    });
    const retailCount = pharmaInPeriod.filter(p => p.source === 'retail' || !p.patient).length;

    return {
        period,
        label,
        dateRange: `${startDate.toLocaleDateString('zh-CN')} ~ ${endDate.toLocaleDateString('zh-CN')}`,
        cards: [
            { name: '营业收费', value: totalRev },
            { name: '门诊收费', value: outpatientRev },
            { name: '零售收费', value: retailRev },
            { name: '门诊诊量', value: opInPeriod.length },
            { name: '零售客量', value: retailCount },
            { name: '门诊客单价', value: opInPeriod.length > 0 ? outpatientRev / opInPeriod.length : 0 },
            { name: '零售客单价', value: retailCount > 0 ? retailRev / retailCount : 0 }
        ],
        charts: {
            payMethod: Object.entries(payMap).map(([name, value]) => ({ name, value })),
            feeCategory: Object.entries(feeMap).map(([name, value]) => ({ name, value })),
            detailCategory: Object.entries(detailMap).map(([name, value]) => ({ name, value }))
        },
        detailList: revInPeriod
    };
}

async function trend(username, query) {
    const range = query.range || '1m';
    const now = new Date();
    let startDate;
    let label;
    if (range === '1m') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
        label = '近一月';
    } else if (range === '3m') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        label = '近三月';
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        label = '近半年';
    }

    const revenue = await repo.readCollection(username, 'revenue');
    const outpatients = await repo.readCollection(username, 'outpatients');
    const dayMap = {};
    const dayVisits = {};
    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
        const ds = toDateKey(d);
        dayMap[ds] = 0;
        dayVisits[ds] = 0;
    }
    revenue.forEach(r => {
        const dt = parseDate(r.date);
        if (dt && dt >= startDate && dt <= now) {
            const ds = toDateKey(dt);
            if (dayMap[ds] !== undefined) dayMap[ds] += toNum(r.amount);
        }
    });
    outpatients.forEach(o => {
        const dt = parseDate(o.opDate || o.date);
        if (dt && dt >= startDate && dt <= now) {
            const ds = toDateKey(dt);
            if (dayVisits[ds] !== undefined) dayVisits[ds]++;
        }
    });

    const dates = Object.keys(dayMap).sort();
    return {
        range,
        label,
        dateRange: `${startDate.toLocaleDateString('zh-CN')} ~ ${now.toLocaleDateString('zh-CN')}`,
        revenue: dates.map(d => ({ date: d, value: dayMap[d] })),
        visits: dates.map(d => ({ date: d, value: dayVisits[d] }))
    };
}

async function operations(username, query) {
    const period = query.period || 'week';
    const now = new Date();
    let startDate;
    let label;
    if (period === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        label = '今天';
    } else if (period === 'week') {
        const day = now.getDay() || 7;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
        label = '近一周';
    } else if (period === 'month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        label = '近一月';
    } else if (period === 'quarter') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        label = '近三月';
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        label = '近半年';
    }

    const outpatients = await repo.readCollection(username, 'outpatients');
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const tKey = todayKey();
    const todayOp = outpatients.filter(o => toDateKey(o.opDate || o.date) === tKey);
    const todayPharma = pharmacy.filter(p => toDateKey(p.date) === tKey);

    const hasEarlierVisit = (name, dateKey) => outpatients.some(o => {
        if (o.name !== name) return false;
        const k = toDateKey(o.opDate || o.date);
        return k !== null && k < dateKey;
    });

    let newPatientsCount = 0;
    todayOp.forEach(o => {
        if (!hasEarlierVisit(o.name, tKey)) newPatientsCount++;
    });

    const dayKeys = [];
    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) dayKeys.push(toDateKey(d));

    const opByDay = {};
    outpatients.forEach(o => {
        const k = toDateKey(o.opDate || o.date);
        if (k && dayKeys.includes(k)) opByDay[k] = (opByDay[k] || 0) + 1;
    });
    const retailByDay = {};
    pharmacy.forEach(p => {
        const k = toDateKey(p.date);
        if (k && dayKeys.includes(k) && (p.source === 'retail' || !p.patient)) retailByDay[k] = (retailByDay[k] || 0) + 1;
    });
    const daily = dayKeys.map(k => {
        let newP = 0;
        outpatients.forEach(o => {
            if (toDateKey(o.opDate || o.date) === k && !hasEarlierVisit(o.name, k)) newP++;
        });
        return {
            date: k,
            visits: opByDay[k] || 0,
            finished: opByDay[k] || 0,
            newPatients: newP,
            retail: retailByDay[k] || 0
        };
    });

    return {
        period: label,
        cards: {
            visitCount: todayOp.length,
            newPatients: newPatientsCount,
            retailCount: todayPharma.filter(p => p.source === 'retail' || !p.patient).length,
            finishedVisits: todayOp.filter(o => o.status === '已就诊').length
        },
        trend: {
            labels: dayKeys,
            visits: dayKeys.map(k => opByDay[k] || 0),
            finished: dayKeys.map(k => opByDay[k] || 0)
        },
        daily
    };
}

async function inventoryOverview(username) {
    const drugInventory = await repo.readCollection(username, 'drugInventory');
    const normal = drugInventory.filter(d => toNum(d.stock || d.quantity) > 10).length;
    const low = drugInventory.filter(d => toNum(d.stock || d.quantity) <= 10 && toNum(d.stock || d.quantity) > 0).length;
    const empty = drugInventory.filter(d => toNum(d.stock || d.quantity) === 0).length;
    const expiryAlert = drugInventory.filter(d => {
        const exp = parseDate(d.expiry);
        if (!exp) return false;
        const diff = (exp - new Date()) / (1000 * 60 * 60 * 24);
        return diff <= 30;
    }).length;

    const pieData = [
        { name: '库存正常', value: normal },
        { name: '库存偏低(≤10)', value: low },
        { name: '库存耗尽(0)', value: empty },
        { name: '效期预警(30天内)', value: expiryAlert }
    ];

    const now = new Date();
    const alerts = [];
    drugInventory.forEach(d => {
        const stock = toNum(d.stock || d.quantity);
        const min = toNum(d.minStock, 10);
        const exp = parseDate(d.expiry);
        const days = exp ? Math.ceil((exp - now) / (1000 * 60 * 60 * 24)) : null;
        if (days !== null && days <= 0) alerts.push({ ...d, type: '已过期', severity: 4, color: '#d32f2f', time: `已过期${Math.abs(days)}天` });
        else if (stock <= 0) alerts.push({ ...d, type: '库存耗尽', severity: 4, color: '#d32f2f', time: '当前库存为 0' });
        else if (days !== null && days <= 30) alerts.push({ ...d, type: '效期预警', severity: 3, color: '#e67e00', time: `距效期 ${days} 天` });
        else if (stock <= min) alerts.push({ ...d, type: '库存不足', severity: 2, color: '#f1c40f', time: `低于安全线 ${min}` });
    });
    alerts.sort((a, b) => b.severity - a.severity || String(a.time).localeCompare(String(b.time)));
    return { pieData, alerts };
}

module.exports = {
    enhanced,
    dashboard,
    revenueStats,
    trend,
    operations,
    inventoryOverview
};
