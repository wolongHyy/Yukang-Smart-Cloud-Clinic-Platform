#!/usr/bin/env node
// ============================================================
//  愈康云诊所 - 中国药典2025 知识库构建脚本
// ------------------------------------------------------------
//  作用：把「药典2025原始数据」里的 Markdown 条目
//        （一部/药材和饮片 + 一部/成方制剂和单味制剂）
//        转换为 data/pharmacopoeia.json 的同结构数据，并与现有条目合并：
//          - 同名条目：以药典数据为准（保留原有 不良反应/相互作用/本草典补充）
//          - 药典没有的：保留原条目（本草典、公开说明书等）
//  用法：node tools/build_chp2025.js [药典数据根目录，可省略]
//        省略时默认读取 项目根目录/药典2025原始数据
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PHARMA_FILE = path.join(DATA_DIR, 'pharmacopoeia.json');
const TODAY = '2026-08-16';
const NEW_SOURCE = '中国药典2025年版一部（国家药典委员会颁布）';

// 药典数据根目录：可通过命令行参数指定，否则用项目根目录下的「药典2025原始数据」
const RAW_DIR = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', '..', '..', '药典2025原始数据', '药典2025知识库_最终版', '一部');

const FOLDER_MAP = {
    '药材和饮片': '中药饮片',
    '成方制剂和单味制剂': '中成药',
    '植物油脂和提取物': '中药提取物',
};

// 只导入有临床用药信息的目录（植物油脂和提取物仅含质量标准，无功能主治，不入库）
const IMPORT_FOLDERS = ['药材和饮片', '成方制剂和单味制剂'];

// ---------- 通用文本清理 ----------
function stripWiki(s) {
    let out = String(s || '');
    for (let i = 0; i < 10; i++) {
        const next = out.replace(/\[\[([^\]]*)\]\]/g, (m, inner) => inner);
        if (next === out) break;
        out = next;
    }
    return out;
}

function clean(s) {
    return stripWiki(String(s || ''))
        .replace(/\u3000/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function oneLine(s) {
    return clean(s).replace(/\s+/g, ' ');
}

// ---------- 解析 Markdown 小节（兼容 ## 式 与 【】式 标题） ----------
const SECTION_ALIAS = {
    '性味与归经': 'xingwei', '性味归经': 'xingwei', '性味': 'xingwei',
    '功能与主治': 'gongneng', '功能主治': 'gongneng', '用途': 'gongneng',
    '用法与用量': 'usage', '用法用量': 'usage',
    '注意': 'caution', '禁忌': 'caution', '用药注意': 'caution',
    '贮藏': 'storage', '储存': 'storage',
    '处方': 'prescription', '规格': 'spec', '炮制': 'paozhi',
};

function parseSections(md) {
    const sections = [];
    let cur = null; // { key, lines } 或 { group: [sec...], lines: [] }
    const close = () => { if (cur) { sections.push(cur); cur = null; } };
    for (const line of md.split(/\r?\n/)) {
        const mrun = line.match(/^((?:【[^】]+】)+)\s*(.*)$/);
        const mh = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (mrun) {
            const keys = mrun[1].match(/【([^】]+)】/g).map(s => s.slice(1, -1));
            const rest = mrun[2].trim();
            close();
            const created = keys.map(k => ({ key: k, lines: rest ? [rest] : [] }));
            for (const c of created) sections.push(c);
            // 后续内容同时追加到所有键（处理“【用法与用量】【注意】【贮藏】同甘草。”这类写法）
            cur = { group: created, lines: [] };
            continue;
        }
        if (mh) {
            close();
            cur = { key: mh[1].trim(), lines: [] };
            continue;
        }
        if (cur) {
            if (cur.group) { for (const g of cur.group) g.lines.push(line); }
            else cur.lines.push(line);
        }
    }
    close();
    return sections
        .map(s => ({ key: s.key, content: s.lines.join('\n').trim() }))
        .filter(s => s.key && s.content);
}

function getSection(md, key) {
    const want = SECTION_ALIAS[key] || key;
    const parts = [];
    for (const s of parseSections(md)) {
        const k = s.key.replace(/\s+/g, '');
        if ((SECTION_ALIAS[k] || k) === want && s.content) parts.push(s.content);
    }
    return parts.join('\n').trim();
}

// ---------- 解析 YAML 头部 ----------
function parseFrontMatter(md) {
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { title: '', category: '', aliases: [] };
    const body = m[1];
    const get = (k) => {
        const r = body.match(new RegExp('^\\s*' + k + ':\\s*["\']?([^"\'\n]+)["\']?$', 'm'));
        return r ? r[1].trim() : '';
    };
    let aliases = [];
    const oneLineArr = body.match(/^aliases:\s*\[(.*)\]/m);
    if (oneLineArr) {
        aliases = oneLineArr[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (/^aliases:\s*$/m.test(body)) {
        const after = body.split(/^aliases:\s*$/m)[1] || '';
        aliases = after.split('\n').filter(l => /^\s*-\s+/.test(l))
            .map(l => l.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return { title: get('title'), category: get('category'), aliases };
}

// ---------- 解析性味与归经 ----------
function parseXingwei(text) {
    let t = oneLine(text);
    const tcm = t.match(/中医[：:]\s*([^。\n]+)/);
    if (tcm) t = tcm[1].trim();
    const meridianMatch = t.match(/归([\u4e00-\u9fa5、，,]+)经/);
    let meridians = '';
    let head = t;
    if (meridianMatch) {
        meridians = '归' + meridianMatch[1] + '经';
        head = t.slice(0, meridianMatch.index).trim();
    }
    let extra = '';
    head = head.replace(/(有小毒|大毒|有毒|无毒)/g, (m) => { extra = m; return ''; });
    head = head.replace(/[。；]+$/, '');
    const tokens = head.split(/[，,、]/).map(s => s.trim()).filter(Boolean);
    const natures = ['大热', '大寒', '微温', '微寒', '平', '热', '温', '寒', '凉'];
    let nature = '';
    let flavors = [];
    if (tokens.length) {
        const last = tokens[tokens.length - 1];
        if (natures.includes(last)) {
            nature = last;
            flavors = tokens.slice(0, -1);
        } else {
            flavors = tokens;
        }
    }
    return { nature, flavors, meridians, extra };
}

// ---------- 功能与主治 → 功能 / 主治 ----------
function splitFunction(text) {
    const t = oneLine(text);
    const idx = t.indexOf('用于');
    if (idx === -1) return { functions: t.replace(/[。；;]+$/, ''), indications: '' };
    let f = t.slice(0, idx).trim().replace(/[。；;]+$/, '');
    let ind = t.slice(idx + 2).trim().replace(/^[，,：:]+/, '').replace(/[。]+$/, '');
    return { functions: f, indications: ind };
}

// ---------- 禁忌合并：药典为准，保留本草典补充（含十八反/十九畏标注） ----------
function mergeCaution(chp, old) {
    chp = oneLine(chp);
    old = oneLine(old);
    if (!old) return chp;
    const compact = s => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (chp && compact(chp).includes(compact(old))) return chp;
    if (!chp) return old;

    let merged = chp.replace(/。$/, '');
    const marker = old.match(/（(十八反|十九畏)）/);
    if (marker && !merged.includes(marker[1])) {
        const core = compact(old.replace(/（(?:十八反|十九畏)）/g, '')).slice(0, 8);
        if (core && compact(merged).includes(core)) merged += '（' + marker[1] + '）';
    }
    merged += '。';

    const chpSents = merged.split(/[。；]/).map(s => s.trim()).filter(Boolean);
    const oldSents = old.split(/[。；]/)
        .map(s => s.trim().replace(/（(?:十八反|十九畏)）$/, '').replace(/^[。；]+/, ''))
        .filter(Boolean);
    for (const s of oldSents) {
        const head = compact(s).slice(0, 8);
        if (!head) continue;
        if (!chpSents.some(r => compact(r).includes(head) || head.includes(compact(r).slice(0, 8)))) chpSents.push(s);
    }
    return chpSents.join('。') + '。';
}

// ---------- 提取药材基原描述（"本品为……"段落） ----------
function extractBaseInfo(md) {
    const m = md.match(/本品(?:为|系)[\s\S]*?(?=\n\s*\n|\n【|\n##\s*性状|$)/);
    return m ? oneLine(m[0]) : '';
}

// ---------- 解析单个条目 ----------
function parseEntry(filePath) {
    const md = fs.readFileSync(filePath, 'utf8');
    if (/内容获取失败/.test(md)) return null;
    const body = md.split('审核人')[0] || md;
    const fm = parseFrontMatter(md);
    const title = fm.title || (md.match(/^#\s+(.+?)\s*$/m) || [])[1] || '';
    const name = title.trim();
    if (!name) return null;

    const xingweiText = getSection(body, '性味与归经') || getSection(body, '性味');
    const xingwei = parseXingwei(xingweiText);
    const fn = splitFunction(getSection(body, '功能与主治') || getSection(body, '用途'));
    const usage = oneLine(getSection(body, '用法与用量') || getSection(body, '用法用量'));
    const caution = oneLine(getSection(body, '注意') || getSection(body, '禁忌'));
    const storage = oneLine(getSection(body, '贮藏'));
    const prescription = oneLine(getSection(body, '处方'));
    const spec = oneLine(getSection(body, '规格'));
    const paozhi = oneLine(getSection(body, '炮制'));

    // 空壳条目（没有功能/主治/用法等临床信息）跳过
    if (!fn.functions && !fn.indications && !usage) return null;

    const notesParts = [];
    if (fm.category === '药材和饮片') {
        const base = extractBaseInfo(body);
        if (base) notesParts.push(base);
        if (xingwei.meridians) notesParts.push(xingwei.meridians);
        if (xingwei.extra) notesParts.push(xingwei.extra);
        if (paozhi) notesParts.push('【炮制】' + paozhi);
    }
    if (prescription) notesParts.push('【处方】' + prescription);
    if (spec) notesParts.push('【规格】' + spec);

    return {
        name,
        aliases: fm.aliases || [],
        category: FOLDER_MAP[fm.category] || fm.category || '中药饮片',
        nature: xingwei.nature,
        flavors: xingwei.flavors,
        functions: fn.functions,
        indications: fn.indications,
        usage,
        contraindications: caution,
        adverseReactions: '',
        notes: notesParts.join('；'),
        interactions: '',
        storage,
        source: NEW_SOURCE,
        updatedAt: TODAY,
    };
}

// ---------- 主流程 ----------
function main() {
    if (!fs.existsSync(RAW_DIR)) {
        console.error('找不到药典数据目录：' + RAW_DIR);
        console.error('用法：node tools/build_chp2025.js [药典数据根目录]');
        process.exit(1);
    }

    // 合并底库：优先使用原始备份（444 条），保证重复运行结果一致
    const BASE_FILE = path.join(DATA_DIR, 'pharmacopoeia_backup_20260816.json');
    const baseFile = fs.existsSync(BASE_FILE) ? BASE_FILE : PHARMA_FILE;
    const existing = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    // 幂等：只把「非药典2025」条目当作合并基础，重复运行结果一致
    const isChp = e => String(e.source || '').includes('中国药典2025');
    const base = existing.filter(e => !isChp(e));
    // 底库按名称去重：同名多条时保留信息更全的一条
    const score = e => [e.functions, e.indications, e.usage, e.contraindications, e.adverseReactions, e.notes]
        .filter(v => v).length;
    const byName = new Map();
    for (const e of base) {
        const cur = byName.get(e.name);
        if (!cur || score(e) > score(cur)) byName.set(e.name, e);
    }
    const baseUnique = [...byName.values()];
    const oldMap = new Map(baseUnique.map(e => [e.name, e]));
    const replaced = new Set();
    const chpEntries = [];
    const seen = new Set();
    let skipped = 0;

    for (const folder of IMPORT_FOLDERS) {
        const dir = path.join(RAW_DIR, folder);
        if (!fs.existsSync(dir)) { console.log('跳过不存在的目录：' + folder); continue; }
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
        for (const f of files) {
            const entry = parseEntry(path.join(dir, f));
            if (!entry) { skipped++; continue; }
            if (seen.has(entry.name)) { console.log('药典内部重名，保留第一条：' + entry.name); continue; }
            seen.add(entry.name);

            const old = oldMap.get(entry.name);
            if (old) {
                replaced.add(entry.name);
                entry.adverseReactions = old.adverseReactions || '';
                entry.interactions = old.interactions || '';
                entry.contraindications = mergeCaution(entry.contraindications, old.contraindications);
                if (old.notes && !entry.notes.includes(old.notes)) {
                    entry.notes = (entry.notes ? entry.notes + '；' : '') + '【本草典补充】' + old.notes;
                }
            }
            chpEntries.push(entry);
        }
    }

    const remaining = baseUnique.filter(e => !replaced.has(e.name));
    const result = chpEntries.concat(remaining);

    // 备份原文件
    const backup = path.join(DATA_DIR, 'pharmacopoeia_backup_' + TODAY.replace(/-/g, '') + '.json');
    if (!fs.existsSync(backup)) fs.copyFileSync(PHARMA_FILE, backup);

    fs.writeFileSync(PHARMA_FILE, JSON.stringify(result, null, 1));

    // 统计
    const catCount = {};
    for (const e of result) catCount[e.category] = (catCount[e.category] || 0) + 1;
    console.log('药典原始目录：' + RAW_DIR);
    console.log('药典条目导入：' + chpEntries.length + '（跳过空壳/无临床信息 ' + skipped + ' 个）');
    console.log('同名替换：' + replaced.size + ' 个；非药典保留：' + remaining.length + ' 个');
    console.log('合并后总数：' + result.length + '（合并基础 ' + base.length + '，原文件 ' + existing.length + '）');
    console.log('分类统计：' + JSON.stringify(catCount));
    console.log('备份已保存：' + backup);
}

main();
