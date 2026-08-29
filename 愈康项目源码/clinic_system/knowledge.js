// ============================================================
//  愈康项目 v3.5 - 药典/方剂知识库模块
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
let textChunks = [];
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
    try { textChunks = readJSONL('pharmacopoeia_texts.jsonl'); } catch (e) { textChunks = []; }
    loaded = true;
}

function readJSONL(filename) {
    return fs.readFileSync(path.join(DATA_DIR, filename), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function stats() {
    loadKnowledge();
    const books = [...new Set(textChunks.map(c => c.book).filter(Boolean))];
    return {
        pharma: pharma.length,
        formulas: formulas.length,
        interactions: interactions.length,
        textChunks: textChunks.length,
        pharmacopoeiaBooks: books,
        pharmacopoeiaPages: [...new Set(textChunks.map(c => c.book + ':' + c.page))].length
    };
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

// V3.5 中药饮片名称清单（供处方中心饮片选择器检索）
function herbNameList(userEntries) {
    const out = [];
    const seen = new Set();
    for (const e of mergeEntries(userEntries)) {
        const nm = String(e.name || '').trim();
        if (!nm || seen.has(nm)) continue;
        seen.add(nm);
        out.push({ name: nm, category: e.category || '' });
    }
    return out;
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

function searchTextChunks(query, limit) {
    loadKnowledge();
    const n = normalize(query);
    if (!n) return [];
    const terms = new Set();
    if (n.length >= 2) terms.add(n);
    for (const group of support.symptomSynonyms || []) {
        const all = [group.canonical, ...(group.synonyms || [])].map(normalize).filter(t => t.length > 1);
        if (all.some(t => n.includes(t))) all.forEach(t => terms.add(t));
    }
    for (let size = Math.min(6, n.length); size >= 2; size--) {
        for (let i = 0; i + size <= n.length; i++) terms.add(n.slice(i, i + size));
    }
    const scored = [];
    for (let idx = 0; idx < textChunks.length; idx++) {
        const chunk = textChunks[idx];
        const text = normalize(chunk.text);
        if (!text) continue;
        let score = 0;
        let hitTerms = 0;
        for (const term of terms) {
            if (text.includes(term)) {
                hitTerms++;
                score += term.length * (term.length >= 3 ? 3 : 2);
            }
        }
        if (!score) continue;
        if (hitTerms >= Math.min(3, terms.size)) score += 5;
        scored.push({ chunk, score, index: idx });
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, limit || 4).map(({ chunk, score }) => ({ ...chunk, score }));
}

// ==================== 病症 / 证型建议（基于 kb_support 的轻量 RAG） ====================
function clinicalQuery(input) {
    const o = input || {};
    return [
        o.chief, o.history, o.past, o.allergy,
        o.exam, o.diagnosis, o.syndrome, o.tcm
    ].filter(Boolean).join('；');
}

function synonymHits(text) {
    const n = normalize(text);
    const hits = [];
    for (const group of support.symptomSynonyms || []) {
        const terms = [group.canonical, ...(group.synonyms || [])].filter(t => String(t || '').trim().length > 1);
        const hit = terms.find(t => n.includes(normalize(t)));
        if (hit) hits.push(group.canonical);
    }
    return [...new Set(hits)];
}

function suggestConditions(input, topK) {
    loadKnowledge();
    const text = clinicalQuery(input);
    const n = normalize(text);
    if (!n) return [];
    const synonyms = synonymHits(text);
    const candidates = new Map();

    const addCandidate = (candidate) => {
        const key = normalize(candidate.name);
        if (!key) return;
        const old = candidates.get(key);
        if (!old) {
            candidates.set(key, candidate);
            return;
        }
        old.score += candidate.score;
        old.evidence = [...new Set([...old.evidence, ...candidate.evidence])].slice(0, 8);
        old.type = old.type === conditionAndPatternType ? old.type : [old.type, candidate.type].filter(Boolean).join('+');
    };
    const conditionAndPatternType = '病症+证型';

    for (const condition of support.conditions || []) {
        const names = [condition.name, ...(condition.aliases || [])].filter(t => String(t || '').trim().length > 1);
        const hits = names.filter(t => n.includes(normalize(t)));
        if (!hits.length) continue;
        const exact = hits.some(t => normalize(t) === condition.name && n.includes(normalize(condition.name)));
        addCandidate({
            type: '病症',
            name: condition.name,
            score: 24 + hits.reduce((s, t) => s + normalize(t).length, 0) + (exact ? 8 : 0),
            evidence: hits.map(t => `病历文本命中病症/别名：${t}`),
            description: condition.description || '',
            advice: condition.guide || ''
        });
    }

    for (const pattern of support.patterns || []) {
        const evidence = [];
        const matchSymptoms = (items, weightLabel) => {
            const matched = [];
            for (const item of items || []) {
                const parts = String(item || '').split(/[，,；;]|或者|或/).map(normalize).filter(s => s.length > 1);
                if (parts.some(part => n.includes(part) || part.includes(n))) matched.push(item);
            }
            matched.forEach(item => evidence.push(`${weightLabel}：${item}`));
            return matched;
        };
        const cardinal = matchSymptoms(pattern.cardinalSymptoms, '主症');
        const secondary = matchSymptoms(pattern.secondarySymptoms, '次症');
        const tongue = pattern.tongue && n.includes(normalize(pattern.tongue)) ? [pattern.tongue] : [];
        const pulse = pattern.pulse && n.includes(normalize(pattern.pulse)) ? [pattern.pulse] : [];
        tongue.forEach(item => evidence.push('舌象：' + item));
        pulse.forEach(item => evidence.push('脉象：' + item));
        if (!cardinal.length) continue;
        // 只允许“两个主症”或“一个主症且有次症/舌脉支持”的证型进入建议，避免单症状造成过强推断。
        if (cardinal.length < 2 && !secondary.length && !tongue.length && !pulse.length) continue;
        const score = cardinal.length * 12 + secondary.length * 4 +
            tongue.length * 3 + pulse.length * 3 + synonyms.length;
        addCandidate({
            type: '证型',
            name: pattern.name,
            score,
            evidence: evidence.slice(0, 8),
            description: pattern.description || '',
            advice: [pattern.treatmentPrinciple ? '治法：' + pattern.treatmentPrinciple : '',
                pattern.tongue ? '舌象：' + pattern.tongue : '',
                pattern.pulse ? '脉象：' + pattern.pulse : ''].filter(Boolean).join('；')
        });
    }

    return [...candidates.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK || 8)
        .map(item => ({
            ...item,
            evidence: [...new Set([...item.evidence, ...(synonyms.length ? ['同义词匹配：' + synonyms.join('、')] : [])])].slice(0, 8)
        }));
}

module.exports = {
    loadKnowledge, stats, lookupDrug, searchEntries, expandQuery,
    retrieveDrugs, retrieveFormulas, matchInteractions, normalize,
    listEntries, listFormulas, herbNameList, suggestConditions, clinicalQuery, searchTextChunks
};
