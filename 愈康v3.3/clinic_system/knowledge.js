// ============================================================
//  愈康云诊所 v3.2 - 药典/方剂知识库模块
//  - 加载 data/ 下的知识库 JSON（本草典 v1 + 公开说明书整理）
//  - 提供药名查找（精确/别名/模糊）与相关性检索（RAG）
//  - 支持用户自定义条目覆盖同名基础条目
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

let pharma = [];
let formulas = [];
let interactions = [];
let support = { conditions: [], patterns: [], symptomSynonyms: [] };
let loaded = false;

function normalize(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function loadKnowledge() {
    if (loaded) return;
    const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    pharma = read('pharmacopoeia.json');
    formulas = read('formulas.json');
    interactions = read('interactions.json');
    try { support = read('kb_support.json'); } catch (e) { support = { conditions: [], patterns: [], symptomSynonyms: [] }; }
    loaded = true;
}

function stats() {
    return { pharma: pharma.length, formulas: formulas.length, interactions: interactions.length };
}

// 合并基础条目与用户自定义条目（同名覆盖）
function mergeEntries(userEntries) {
    const map = new Map();
    for (const e of pharma) map.set(e.name, e);
    for (const u of (userEntries || [])) {
        if (u && u.name) map.set(u.name, u);
    }
    return [...map.values()];
}

function lookupDrug(name, userEntries) {
    const n = normalize(name);
    if (!n) return null;
    const all = mergeEntries(userEntries);
    let hit = all.find(e => normalize(e.name) === n);
    if (!hit) hit = all.find(e => (e.aliases || []).some(a => normalize(a) === n));
    if (!hit) hit = all.find(e => normalize(e.name).includes(n));
    if (!hit) hit = all.find(e => n.includes(normalize(e.name)) && normalize(e.name).length > 1);
    return hit || null;
}

function searchEntries(q, userEntries, limit) {
    const n = normalize(q);
    if (!n) return [];
    const all = mergeEntries(userEntries);
    const hits = all.filter(e =>
        normalize(e.name).includes(n) ||
        (e.aliases || []).some(a => normalize(a).includes(n)) ||
        normalize(e.functions || '').includes(n) ||
        normalize(e.indications || '').includes(n)
    );
    hits.sort((a, b) => {
        const sa = normalize(a.name).indexOf(n);
        const sb = normalize(b.name).indexOf(n);
        if (sa !== sb) return (sa === -1 ? 1 : 0) - (sb === -1 ? 1 : 0);
        return normalize(a.name).length - normalize(b.name).length;
    });
    return hits.slice(0, limit || 30);
}

function listEntries(userEntries, limit) {
    return mergeEntries(userEntries).slice(0, limit || 30);
}

function listFormulas(userFormulas) {
    const map = new Map();
    for (const f of formulas) map.set(f.name, f);
    for (const u of (userFormulas || [])) {
        if (u && u.name) map.set(u.name, u);
    }
    return [...map.values()];
}

function charSet(s) {
    return new Set(normalize(s));
}

function scoreText(text, qchars) {
    const s = normalize(text);
    let c = 0;
    for (const ch of qchars) if (s.includes(ch)) c++;
    return c;
}

// 用症状同义词与病症别名扩展查询词，提升召回
function expandQuery(query) {
    const n = normalize(query);
    if (!n) return query;
    const parts = [];
    for (const g of support.symptomSynonyms || []) {
        const all = [g.canonical, ...(g.synonyms || [])].filter(Boolean);
        if (all.some(t => n.includes(normalize(t)))) parts.push(all[0]);
    }
    for (const c of support.conditions || []) {
        const all = [c.name, ...(c.aliases || [])].filter(Boolean);
        if (all.some(t => n.includes(normalize(t)))) parts.push(c.name);
    }
    if (!parts.length) return query;
    return query + ' ' + parts.join(' ');
}

function retrieveDrugs(query, userEntries, inventoryNames, topK) {
    const qchars = charSet(query);
    if (!qchars.size) return [];
    const invSet = new Set((inventoryNames || []).map(normalize));
    const scored = [];
    for (const e of mergeEntries(userEntries)) {
        let s = scoreText(e.name, qchars) * 8
            + scoreText((e.aliases || []).join(''), qchars) * 5
            + scoreText(e.functions, qchars) * 3
            + scoreText(e.indications, qchars) * 3
            + scoreText(e.notes, qchars);
        if (s > 0 && invSet.has(normalize(e.name))) s += 4;
        if (s > 0) scored.push({ entry: e, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK || 6).map(x => x.entry);
}

function retrieveFormulas(query, topK) {
    const qchars = charSet(query);
    if (!qchars.size) return [];
    const scored = [];
    for (const f of formulas) {
        const compNames = (f.composition || []).map(c => c.name || '').join('，');
        const mods = (f.modifications || []).join('；');
        let s = scoreText(f.name, qchars) * 8
            + scoreText(f.functions, qchars) * 4
            + scoreText(f.indications, qchars) * 3
            + scoreText(compNames, qchars) * 2
            + scoreText(mods, qchars) * 2;
        if (s > 0) scored.push({ entry: f, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK || 4).map(x => x.entry);
}

function matchInteractions(drugNames) {
    if (!drugNames || !drugNames.length) return [];
    const set = new Set(drugNames.map(normalize));
    return interactions.filter(it =>
        (it.herbs || []).some(h => set.has(normalize(h)))
    );
}

module.exports = {
    loadKnowledge, stats, lookupDrug, searchEntries, expandQuery,
    retrieveDrugs, retrieveFormulas, matchInteractions, normalize,
    listEntries, listFormulas
};
