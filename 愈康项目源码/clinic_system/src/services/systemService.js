const path = require('path');
const repo = require('../repository/sqliteRepository');
const HttpError = require('../errors/HttpError');
const { indexStatus } = require('./hybridKnowledgeService');
const { LocalRagClient } = require('./localRagClient');

async function health() {
    return repo.getStatus();
}

async function createBackup() {
    return repo.createBackup('manual');
}

async function listBackups() {
    return repo.listBackups();
}

async function exportJson(username) {
    const collections = {};
    for (const name of Object.keys(repo.COLLECTIONS)) {
        collections[name] = await repo.readCollection(username, name);
    }
    return {
        format: 'yukang-clinic-export',
        formatVersion: 1,
        appVersion: '5.0.0',
        exportedAt: new Date().toISOString(),
        username,
        collections,
    };
}

function csvCell(value) {
    const text = value === null || value === undefined
        ? ''
        : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    return '"' + text.replace(/"/g, '""') + '"';
}

async function exportCsv(username, collection) {
    if (!Object.prototype.hasOwnProperty.call(repo.COLLECTIONS, collection)) {
        throw new HttpError(404, '导出集合不存在', 'COLLECTION_NOT_FOUND');
    }
    const data = await repo.readCollection(username, collection);
    const rows = Array.isArray(data) ? data : [data];
    const columns = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows) {
        lines.push(columns.map(column => csvCell(row ? row[column] : '')).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function exportHtml(username) {
    const archive = await exportJson(username);
    const sections = Object.entries(archive.collections).map(([name, value]) => {
        const rows = Array.isArray(value) ? value : [value];
        const columns = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
        const head = columns.map(column => `<th>${escapeHtml(column)}</th>`).join('');
        const body = rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row ? row[column] : '')}</td>`).join('')}</tr>`).join('');
        return `<section><h2>${escapeHtml(name)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
    }).join('\n');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>愈康数据导出</title><style>body{font-family:"Microsoft YaHei",sans-serif;margin:32px;color:#111}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #bbb;padding:6px;text-align:left;vertical-align:top;font-size:12px}th{background:#eef7f4}section{page-break-after:always}</style></head><body><h1>愈康项目数据导出</h1><p>导出时间：${escapeHtml(archive.exportedAt)}</p>${sections}</body></html>`;
}

async function restoreBackup(filename) {
    const safeName = path.basename(String(filename || ''));
    if (!safeName || safeName !== filename) {
        throw new HttpError(400, '备份文件名无效', 'INVALID_BACKUP_FILENAME');
    }
    return repo.restoreBackup(path.join(repo.getActiveBackupDir(), safeName));
}

async function importJson(username, archive) {
    if (!archive || archive.format !== 'yukang-clinic-export') {
        throw new HttpError(400, '导入文件不是愈康项目导出格式', 'INVALID_IMPORT_FORMAT');
    }
    if (Number(archive.formatVersion) !== 1 || !archive.collections || typeof archive.collections !== 'object') {
        throw new HttpError(400, '导入文件版本不受支持', 'UNSUPPORTED_IMPORT_VERSION');
    }
    const unknown = Object.keys(archive.collections).filter(name => !Object.prototype.hasOwnProperty.call(repo.COLLECTIONS, name));
    if (unknown.length) {
        throw new HttpError(400, `导入文件包含未知集合：${unknown.join(', ')}`, 'UNKNOWN_IMPORT_COLLECTION');
    }
    return repo.transaction(async () => {
        for (const name of Object.keys(repo.COLLECTIONS)) {
            if (Object.prototype.hasOwnProperty.call(archive.collections, name)) {
                await repo.writeCollection(username, name, archive.collections[name]);
            }
        }
        return { success: true, importedCollections: Object.keys(archive.collections).length };
    });
}

function parseFlexibleDate(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

async function exportLogs(limit = 200000) {
    const logger = require('../utils/logger');
    const file = logger.logFile();
    const fs = require('fs');
    if (!fs.existsSync(file)) return { filename: 'server.log', content: '' };
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - Math.min(Math.max(Number(limit) || 200000, 1000), 1000000));
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        return { filename: 'server.log', content: buffer.toString('utf8') };
    } finally {
        fs.closeSync(fd);
    }
}

async function clinicAggregate(options = {}) {
    const end = options.periodEnd ? new Date(options.periodEnd) : new Date();
    const start = options.periodStart ? new Date(options.periodStart) : new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);
    const endOfDay = options.periodEnd ? new Date(options.periodEnd) : new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    const requestedClinicId = String(options.clinicId || '').trim();
    const clinicId = requestedClinicId || (repo.listStoreIds().length === 1 ? repo.listStoreIds()[0] : '');

    let aggregate = {
        visitCount: 0,
        revenue: 0,
        patientCount: 0,
        lowStockCount: 0,
        pendingBillingCount: 0,
        pendingPharmacyCount: 0,
    };
    if (clinicId) {
        aggregate = await repo.getStoreAggregate(clinicId, { start, end: endOfDay });
    }

    return {
        periodStart: start.toISOString(),
        periodEnd: endOfDay.toISOString(),
        clinicId,
        metrics: {
            visit_count: aggregate.visitCount,
            revenue: +Number(aggregate.revenue || 0).toFixed(2),
            profile_count: aggregate.patientCount,
            low_stock_count: aggregate.lowStockCount,
            pending_billing_count: aggregate.pendingBillingCount,
            pending_pharmacy_count: aggregate.pendingPharmacyCount,
        },
    };
}

async function ragStatus() {
    const indexPath = path.join(__dirname, '..', '..', 'data', 'knowledge_index.db');
    const index = await indexStatus(indexPath);
    try {
        const worker = await new LocalRagClient().health();
        return { index, worker: { available: true, ...worker } };
    } catch (err) {
        return { index, worker: { available: false, error: err.message } };
    }
}

async function audit(username, limit = 200) {
    return {
        verification: await repo.verifyAuditChain(),
        events: await repo.listAuditEvents(username, limit),
    };
}

module.exports = {
    health,
    createBackup,
    listBackups,
    exportJson,
    exportCsv,
    exportHtml,
    restoreBackup,
    importJson,
    audit,
    ragStatus,
    clinicAggregate,
    exportLogs,
};
