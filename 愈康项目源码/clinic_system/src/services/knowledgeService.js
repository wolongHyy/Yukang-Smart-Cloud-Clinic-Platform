const knowledge = require('../../knowledge');
const repo = require('../repository/sqliteRepository');
const HttpError = require('../errors/HttpError');

async function lookupDrug(username, query) {
    const name = String(query.name || '').trim();
    if (!name) throw new HttpError(400, '缺少药品名称', 'VALIDATION_ERROR');
    const userEntries = await repo.readCollection(username, 'drugKnowledge');
    const entry = knowledge.lookupDrug(name, userEntries);
    const textMatches = knowledge.searchTextChunks(name, 4);
    const normalized = name.toLowerCase().replace(/\s+/g, '');
    const goodTextMatches = entry
        ? textMatches
        : textMatches.filter(m => (m.text || '').toLowerCase().replace(/\s+/g, '').includes(normalized));
    if (!entry && !goodTextMatches.length) return { found: false };
    const officialEntry = entry || {
        name,
        category: '药典原文',
        functions: '详见下方中国药典原文摘录。'
    };
    return { found: true, entry: officialEntry, textMatches: goodTextMatches };
}

async function search(username, query) {
    const q = String(query.q || '').trim();
    const limit = Math.min(Number(query.limit) || 30, 100);
    const userEntries = await repo.readCollection(username, 'drugKnowledge');
    const userNames = new Set((userEntries || []).map(e => e.name));
    const items = q ? knowledge.searchEntries(q, userEntries, limit) : knowledge.listEntries(userEntries, limit);
    return {
        total: items.length,
        items: items.map(e => ({ ...e, isUser: userNames.has(e.name) }))
    };
}

async function herbs(username) {
    const userEntries = await repo.readCollection(username, 'drugKnowledge');
    return { items: knowledge.herbNameList(userEntries) };
}

function stats() {
    return knowledge.stats();
}

async function formulaLibrary(username) {
    const userFormulas = await repo.readCollection(username, 'userFormulas');
    return knowledge.listFormulas(userFormulas);
}

module.exports = {
    lookupDrug,
    search,
    herbs,
    stats,
    formulaLibrary
};
