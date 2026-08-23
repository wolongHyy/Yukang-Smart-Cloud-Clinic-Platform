// ============================================================
//  愈康项目 v3.5 - AI 辅助诊断模块
//  - 支持智谱 GLM（免费）/ DeepSeek / 硅基流动 / 自定义 OpenAI 兼容接口
//  - RAG：从知识库检索相关单药/方剂/相互作用后注入 prompt
//  - 输出严格 JSON，服务端逐条校验药品必须在本诊所库存内（白名单）
// ============================================================
const knowledge = require('./knowledge');

const PROVIDERS = {
    zhipu: { label: '智谱 GLM（免费）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/glm-4-9b-chat' },
    custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
};

let fetchImpl = (typeof fetch === 'function') ? fetch.bind(globalThis) : null;
function _setFetch(fn) { fetchImpl = fn; }

function normalizeConfig(cfg) {
    const p = PROVIDERS[cfg && cfg.provider] || PROVIDERS.zhipu;
    return {
        enabled: !!(cfg && cfg.enabled),
        provider: (cfg && cfg.provider) || 'zhipu',
        baseUrl: ((cfg && cfg.baseUrl) || p.baseUrl).replace(/\/+$/, ''),
        apiKey: (cfg && cfg.apiKey) || '',
        model: (cfg && cfg.model) || p.model,
        temperature: Number((cfg && cfg.temperature) || 0.2),
        timeoutMs: Number((cfg && cfg.timeoutMs) || 60000)
    };
}

function providerLabel(provider) {
    const p = PROVIDERS[provider];
    return p ? p.label : provider;
}

async function chat(cfg, messages, opts) {
    const c = normalizeConfig(cfg);
    if (!fetchImpl) throw new Error('当前运行环境不支持网络请求，请升级 Node.js 到 18 以上版本');
    if (!c.apiKey) throw new Error('尚未配置 API Key：请在【设置 → AI 配置】中填写并保存');
    const url = c.baseUrl + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts && opts.timeoutMs ? opts.timeoutMs : c.timeoutMs);
    try {
        const resp = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
            body: JSON.stringify({
                model: c.model,
                messages,
                temperature: opts && opts.temperature !== undefined ? opts.temperature : c.temperature,
                max_tokens: (opts && opts.maxTokens) || 2000,
                stream: false
            }),
            signal: controller.signal
        });
        if (!resp.ok) {
            let msg = 'AI 服务商返回错误（' + resp.status + '）';
            try {
                const d = await resp.json();
                msg = (d && (d.error && (d.error.message || d.error)) || d.message) || msg;
            } catch (e) { /* ignore */ }
            if (resp.status === 401) msg = 'API Key 无效或未授权，请到【设置 → AI 配置】检查';
            if (resp.status === 429) msg = 'AI 免费额度已用完或请求过于频繁，请稍后再试或更换服务商';
            if (resp.status >= 500) msg = 'AI 服务商暂时不可用，请稍后再试';
            throw new Error(msg);
        }
        const data = await resp.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) throw new Error('AI 返回内容为空，请重试');
        return String(content);
    } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('AI 请求超时，请稍后重试或调大超时时间');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function extractJson(text) {
    const t = String(text || '').trim();
    try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { /* fallthrough */ } }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fallthrough */ }
    }
    return null;
}

// ==================== 上下文构建（RAG） ====================
function buildContext({ query, draftDrugs, inventoryNames, userEntries }) {
    const expanded = knowledge.expandQuery(query);
    const drugs = knowledge.retrieveDrugs(expanded, userEntries, inventoryNames, 6);
    const formulas = knowledge.retrieveFormulas(expanded, 4);
    // 已选药品的专论必须完整带入
    for (const name of (draftDrugs || [])) {
        if (!drugs.find(d => d.name === name)) {
            const e = knowledge.lookupDrug(name, userEntries);
            if (e) drugs.push(e);
        }
    }
    const interNames = [...drugs.map(d => d.name), ...(draftDrugs || [])];
    const interactions = knowledge.matchInteractions(interNames);
    return { drugs, formulas, interactions };
}

function fmtEntry(e) {
    const parts = [];
    if (e.functions) parts.push('功能/适应症：' + e.functions);
    if (e.usage) parts.push('用法用量：' + e.usage);
    if (e.contraindications) parts.push('禁忌：' + e.contraindications);
    if (e.adverseReactions) parts.push('不良反应：' + e.adverseReactions);
    if (e.notes) parts.push('注意事项：' + e.notes);
    return '【' + e.name + '】' + parts.join('；');
}

function fmtFormula(f) {
    const comp = (f.composition || []).map(c => `${c.name}${c.amount || ''}${c.role ? '(' + c.role + ')' : ''}`).join('、');
    return '【方剂：' + f.name + '】来源：' + (f.source || '') + '；组成：' + comp +
        '；功效：' + (f.functions || '') + '；主治：' + (f.indications || '') +
        (f.usage ? '；用法：' + f.usage : '') +
        ((f.modifications || []).length ? '；加减：' + f.modifications.join('；') : '');
}

const SYSTEM_PROMPT = [
    '你是"愈康云诊所"的中西医辅助开方助手，协助基层医生生成处方建议。',
    '必须遵守以下规则：',
    '1. 只能依据下方【知识库】与本诊所【药品目录】作答，严禁编造药品名、剂量或医学知识。',
    '2. 只能从【药品目录】中选择药品；若知识库未收录该药，请在对应 note 中写明"知识库未收录，请医生自行判断"。',
    '3. 若患者有过敏史、禁忌或用药风险，必须在 warnings 中给出明确提示。',
    '4. 剂量用法尽量引用知识库内容；不确定时宁缺毋滥，不要勉强开方。',
    '5. 输出必须是严格 JSON，禁止输出 JSON 以外的任何文字，禁止使用 Markdown 代码块。',
    'JSON 结构：{"suggestions":[{"name":"药品名","qty":数字,"dose":"每次用量，如 1片","frequency":"每日次数，如 一日2次","days":"用药天数，如 3天","note":"说明/理由/注意"}],"rationale":"开方思路简述（1-2句）","warnings":["风险提示1","风险提示2"]}'
].join('\n');

function buildUserPrompt(ctx, patient, inventory) {
    const invText = (inventory || []).map(d => `${d.name}(${Number(d.price) || 0}元/${d.unit || ''})`).join('，');
    const drugText = (ctx.drugs || []).map(fmtEntry).join('\n');
    const formulaText = (ctx.formulas || []).map(fmtFormula).join('\n');
    const interText = (ctx.interactions || []).map(it =>
        '【' + (it.herbs || []).join('、') + ' × ' + it.drugClassZh + '】严重度：' + it.severity +
        '；机制：' + (it.mechanismZh || '') + '；建议：' + (it.recommendationZh || '')
    ).join('\n');
    const p = patient || {};
    const lines = [
        '【患者信息】性别：' + (p.gender || '未填') + '；年龄：' + (p.age || '未填') + '；过敏史：' + (p.allergy || '无') + '；类型：' + (p.visitType || '初诊') + '；收费：' + (p.feeType || '自费'),
        '【主诉】' + (p.chief || '未填'),
        '【现病史】' + (p.history || '未填'),
        '【既往史】' + (p.past || '未填'),
        '【体格检查】' + (p.exam || '未填'),
        '【望闻问切】' + (p.tcm || '未填'),
        '【诊断】' + (p.diagnosis || '未填'),
        '【辨证】' + (p.syndrome || '未填'),
        '【已选药品】' + ((p.draftDrugs || []).join('、') || '暂无'),
        '【本诊所药品目录】' + (invText || '空'),
        '【知识库·相关单药】' + (drugText || '无匹配条目'),
        '【知识库·相关方剂】' + (formulaText || '无匹配条目'),
        '【知识库·相互作用】' + (interText || '无相关条目'),
        '请结合患者情况生成处方建议。'
    ];
    return lines.join('\n');
}

// ==================== 开方建议 ====================
async function generatePrescription(settings, { patient, prescriptions, inventory, userEntries }) {
    const cfg = normalizeConfig(settings && settings.aiConfig);
    if (!cfg.enabled) throw new Error('AI 辅助诊断未开启：请先到【设置 → AI 配置】启用并填写 API Key');
    const draftDrugs = (prescriptions || []).map(d => d.name).filter(Boolean);
    const query = [patient.chief, patient.diagnosis, patient.syndrome, patient.history, patient.tcm].filter(Boolean).join(' ');
    const ctx = buildContext({ query, draftDrugs, inventoryNames: inventory.map(d => d.name), userEntries });
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(ctx, { ...patient, draftDrugs }, inventory) }
    ];
    const raw = await chat(cfg, messages);
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.suggestions)) {
        throw new Error('AI 返回格式不正确（未得到有效处方 JSON），请重试或更换模型');
    }

    // 校验：白名单（必须在本诊所库存）、数量、条数上限
    const suggestions = [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 6) : [];
    for (const s of parsed.suggestions.slice(0, 12)) {
        const rawName = String(s.name || '').trim();
        if (!rawName) continue;
        let inv = inventory.find(d => d.name === rawName);
        if (!inv) inv = inventory.find(d => d.name.includes(rawName));
        if (!inv) inv = inventory.find(d => rawName.includes(d.name));
        if (!inv) {
            warnings.push('AI 建议的药品不在本诊所库存中，已忽略：' + rawName);
            continue;
        }
        const qty = Number(s.qty);
        const item = {
            name: inv.name,
            qty: (qty > 0 && Number.isFinite(qty)) ? qty : 1,
            price: Number(inv.price) || 0,
            subtotal: 0,
            dose: String(s.dose || '').trim(),
            frequency: String(s.frequency || '').trim(),
            days: String(s.days || '').trim(),
            note: String(s.note || '').trim()
        };
        item.subtotal = +(item.qty * item.price).toFixed(2);
        if (Number(inv.stock || 0) < item.qty) {
            warnings.push(`库存不足：${inv.name} 当前库存 ${Number(inv.stock || 0)}，建议 ${item.qty}，请先入库或调整数量`);
        }
        suggestions.push(item);
    }
    if (!suggestions.length) {
        throw new Error('AI 未能给出可用的处方建议（所有药品均不在本诊所库存中）。请在【药房】先补充药品目录');
    }
    return {
        suggestions,
        rationale: String(parsed.rationale || '').trim(),
        warnings,
        raw,
        model: cfg.model
    };
}

// ==================== 处方审核（知识库规则 + AI） ====================
async function reviewPrescription(settings, { patient, prescriptions, userEntries }) {
    const risks = [];
    const rx = (prescriptions || []).map(d => d.name).filter(Boolean);
    const entries = rx.map(n => ({ name: n, entry: knowledge.lookupDrug(n, userEntries) }));
    const allergyText = String((patient && patient.allergy) || '').trim();

    // 1) 过敏史检查
    if (allergyText) {
        const tokens = allergyText.split(/[，,、;；\s]+/).filter(t => t.length >= 2);
        for (const { name, entry } of entries) {
            if (!entry) continue;
            const hay = (entry.contraindications || '') + (entry.adverseReactions || '') + (entry.notes || '');
            for (const t of tokens) {
                if (hay.includes(t)) {
                    risks.push({ drug: name, issue: `患者过敏史包含"${t}"，该药说明/禁忌中提及相关风险`, severity: '严重', source: '知识库' });
                    break;
                }
            }
        }
    }
    // 2) 十八反/十九畏与药物互斥（同方两药禁忌互提）
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i], b = entries[j];
            if (a.entry && b.entry) {
                if ((a.entry.contraindications || '').includes(b.name)) {
                    risks.push({ drug: a.name + ' + ' + b.name, issue: `知识库记载：${a.name} 禁忌中提及 ${b.name}（可能属十八反/十九畏或配伍禁忌）`, severity: '严重', source: '知识库' });
                }
                if ((b.entry.contraindications || '').includes(a.name)) {
                    risks.push({ drug: a.name + ' + ' + b.name, issue: `知识库记载：${b.name} 禁忌中提及 ${a.name}（可能属十八反/十九畏或配伍禁忌）`, severity: '严重', source: '知识库' });
                }
            }
        }
    }
    // 3) 本草-西药相互作用
    for (const it of knowledge.matchInteractions(rx)) {
        risks.push({
            drug: (it.herbs || []).join('、'),
            issue: `与${it.drugClassZh}存在${it.severity}相互作用（如 ${(it.drugExamples || []).join('、')}）：${it.mechanismZh || ''} ${it.recommendationZh || ''}`,
            severity: it.severity,
            source: '本草典'
        });
    }

    // 4) LLM 复核（尽力而为，失败不影响结果）
    let llmUsed = false;
    const cfg = normalizeConfig(settings && settings.aiConfig);
    if (cfg.enabled && cfg.apiKey && rx.length) {
        try {
            const ctx = buildContext({ query: (patient.chief || '') + ' ' + (patient.diagnosis || ''), draftDrugs: rx, inventoryNames: rx, userEntries });
            const context = [
                '【处方】' + rx.join('、'),
                '【患者】' + (patient.gender || '') + ' ' + (patient.age || '') + '岁 过敏史：' + (patient.allergy || '无'),
                '【知识库·单药】' + ctx.drugs.map(fmtEntry).join('\n'),
                '【知识库·相互作用】' + (ctx.interactions || []).map(it => it.herbs.join('、') + '×' + it.drugClassZh + '：' + it.mechanismZh).join('\n')
            ].join('\n');
            const messages = [
                { role: 'system', content: '你是处方安全审核助手。请基于知识库检查处方中的用药风险（禁忌、过敏、相互作用、配伍禁忌）。只依据知识库内容，不确定就说"知识库未收录"。输出严格 JSON：{"risks":[{"drug":"药名","issue":"问题描述","severity":"严重/中等/提示","source":"依据"}]}，没有风险时输出 {"risks":[]}。' },
                { role: 'user', content: context }
            ];
            const raw = await chat(cfg, messages, { maxTokens: 1200, temperature: 0.1 });
            const parsed = extractJson(raw);
            if (parsed && Array.isArray(parsed.risks)) {
                for (const r of parsed.risks.slice(0, 10)) {
                    if (r && r.issue) risks.push({ drug: String(r.drug || ''), issue: String(r.issue), severity: String(r.severity || '提示'), source: 'AI 审方' });
                }
                llmUsed = true;
            }
        } catch (e) { /* AI 审方失败不影响规则检查 */ }
    }
    return { risks, llmUsed, ruleCount: risks.length };
}

// ==================== 连接测试 ====================
async function testConnection(settings) {
    const cfg = normalizeConfig(settings && settings.aiConfig);
    if (!cfg.apiKey) throw new Error('尚未填写 API Key');
    const raw = await chat(cfg, [
        { role: 'system', content: '只回复四个字：连接成功' },
        { role: 'user', content: '测试' }
    ], { maxTokens: 20, temperature: 0 });
    return { ok: true, reply: String(raw).slice(0, 100), model: cfg.model, provider: providerLabel(cfg.provider) };
}

module.exports = {
    PROVIDERS, normalizeConfig, providerLabel, chat, extractJson,
    generatePrescription, reviewPrescription, testConnection, _setFetch
};
