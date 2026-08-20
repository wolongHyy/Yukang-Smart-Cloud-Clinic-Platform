// ============================================================
//  愈康云诊所 - 回归测试脚本（v3.1）
//  用法: node regression-test.js
//  说明: 使用临时 DATA_DIR 运行，不会触碰真实 clinic_database 数据；
//        测试完成后自动关闭服务器并清理临时数据。
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const knowledge = require('./knowledge');
const ai = require('./ai');

const BASE = __dirname;
const PORT = 3917; // 专用测试端口，避免与正式 3002 冲突
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yk_test_'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, extra) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        failures.push(name);
        console.log(`  FAIL  ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
    }
}

async function req(method, urlPath, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-auth-token'] = token;
    const res = await fetch(BASE_URL + urlPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
}

async function waitReady(proc, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${BASE_URL}/api/server-info`);
            if (res.ok) return true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function main() {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: BASE,
        env: { ...process.env, PORT: String(PORT), DATA_DIR, NO_OPEN_BROWSER: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let bootLog = '';
    child.stdout.on('data', d => { bootLog += d.toString(); });
    child.stderr.on('data', d => { bootLog += d.toString(); });

    try {
        console.log('[1] 等待服务启动...');
        ok(await waitReady(child, 15000), '服务启动', bootLog.slice(-200));

        // 2. 未授权访问
        let r = await req('GET', '/api/outpatients');
        ok(r.status === 401, '无令牌访问受保护接口返回 401');
        r = await req('GET', '/api/outpatients', { token: 'invalid-token' });
        ok(r.status === 401, '错误令牌返回 401');

        // 3. 静态目录泄露防护
        for (const p of ['/clinic_database/users.json', '/server.js', '/package.json', '/node_modules/express/package.json', '/clinic_database']) {
            const res = await fetch(BASE_URL + p);
            ok(res.status === 404, `静态文件不泄露: ${p} 返回 404`);
        }

        // 4. 注册 + 登录
        r = await req('POST', '/api/auth/register', { body: { username: 'qatest', password: '1234' } });
        ok(r.status === 201 && r.data && r.data.token, '注册成功并返回会话令牌', r.data);
        const token = r.data && r.data.token;

        r = await req('POST', '/api/auth/login', { body: { username: 'qatest', password: '1234' } });
        ok(r.status === 200 && r.data && r.data.token, '登录成功并返回会话令牌');

        r = await req('POST', '/api/auth/login', { body: { username: 'qatest', password: 'wrong' } });
        ok(r.status === 401, '错误密码登录返回 401');

        // 5. 旧版明文密码自动迁移
        const usersFile = path.join(DATA_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        users.push({ username: 'legacy', password: 'plain123' });
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), 'utf8');
        r = await req('POST', '/api/auth/login', { body: { username: 'legacy', password: 'plain123' } });
        ok(r.status === 200 && r.data && r.data.token, '旧版明文账号可登录');
        const users2 = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        const legacy = users2.find(u => u.username === 'legacy');
        ok(legacy && legacy.passwordHash && !legacy.password, '登录后密码自动迁移为哈希存储');

        // 6. 直接建档（v3.3 无挂号，直接创建门诊患者）
        const nowD6 = new Date();
        const todayKey6 = `${nowD6.getFullYear()}/${nowD6.getMonth() + 1}/${nowD6.getDate()}`;
        r = await req('POST', '/api/outpatients', {
            token,
            body: { name: '测试患者甲', gender: '男', age: '30', phone: '13800000001', status: '已就诊', date: todayKey6, opDate: todayKey6, source: 'direct' }
        });
        ok(r.status === 201 && r.data && r.data.data && r.data.data.id, '直接建档成功', r.data);
        const opId = r.data && r.data.data && r.data.data.id;

        // 7. 药品入库
        r = await req('POST', '/api/drug-inventory/stock-in', {
            token,
            body: { drugName: '测试阿莫西林', qty: 100, unit: '盒', batchNo: 'B20260810', expiry: '2027/12/31', supplier: '测试供应商', cost: 8, price: 12.5 }
        });
        ok(r.status === 201, '药品入库成功', r.data);

        // 8. 事务化接诊：更新门诊 + 收费 + 药房推送
        r = await req('POST', '/api/visits/complete', {
            token,
            body: {
                outpatientId: opId,
                patient: { chief: '咳嗽三天', diagnosis: '上呼吸道感染', feeType: '医保' },
                prescriptions: [{ name: '测试阿莫西林', qty: 10, price: 12.5, subtotal: 999 }]
            }
        });
        ok(r.status === 200 && r.data && r.data.success !== false, '事务化接诊成功', r.data);
        const visitData = r.data && r.data.data;
        ok(visitData && String(visitData.id) === String(opId), '门诊记录沿用建档ID');
        ok(visitData && visitData.status === '已就诊' && visitData.prescriptions.length === 1, '门诊记录状态与处方正确');
        ok(r.data && r.data.revenueAmount === 125, '收费金额由服务端重算为 125（忽略客户端 subtotal=999）', r.data && r.data.revenueAmount);
        ok(r.data && r.data.pharmacyPushed === 1, '药房推送 1 条待发药记录');

        let ol = await req('GET', '/api/outpatients', { token });
        ok(ol.data.some(x => String(x.id) === String(opId) && x.status === '已就诊'), '门诊记录已更新');
        let rv = await req('GET', '/api/revenue', { token });
        ok(rv.data.some(x => x.amount === 125 && x.desc === '门诊药品费' && x.payMethod === '自费'), '收费记录已写入且医保参数已按自费处理');
        let ph = await req('GET', '/api/pharmacy', { token });
        const pharmaItem = ph.data.find(x => x.patient === '测试患者甲' && x.drug === '测试阿莫西林');
        ok(!!pharmaItem && pharmaItem.status === '待发药', '药房待发药记录存在');

        // 9. 库存不足拦截
        r = await req('POST', '/api/visits/complete', {
            token,
            body: { patient: { name: '测试患者乙' }, prescriptions: [{ name: '测试阿莫西林', qty: 99999, price: 1 }] }
        });
        ok(r.status === 400 && /库存不足/.test((r.data && r.data.error) || ''), '库存不足时接诊被拦截', r.data);

        // 10. 发药：库存扣减 + 出库记录
        const invBefore = (await req('GET', '/api/drugInventory', { token })).data.find(d => d.name === '测试阿莫西林');
        r = await req('POST', `/api/pharmacy/dispense/${pharmaItem.id}`, { token });
        ok(r.status === 200, '发药成功');
        r = await req('POST', `/api/pharmacy/dispense/${pharmaItem.id}`, { token });
        ok(r.status === 400, '重复发药被拦截');
        const invAfter = (await req('GET', '/api/drugInventory', { token })).data.find(d => d.name === '测试阿莫西林');
        ok(Number(invAfter.stock) === Number(invBefore.stock) - 10, `库存扣减正确 ${invBefore.stock} -> ${invAfter.stock}`);
        const outRec = await req('GET', '/api/drugOutRecords', { token });
        ok(outRec.data.some(x => x.drugName === '测试阿莫西林' && x.qty === 10 && x.type === '发药'), '出库记录已写入');

        // 11. autoPharmacy=false 时不再推送药房
        await req('PUT', '/api/settings/1', { token, body: { warningAlert: false, autoPharmacy: false } });
        r = await req('POST', '/api/visits/complete', {
            token,
            body: { patient: { name: '测试患者丙' }, prescriptions: [{ name: '测试阿莫西林', qty: 1, price: 12.5 }] }
        });
        ok(r.status === 200 && r.data.pharmacyPushed === 0 && r.data.revenueAmount === 12.5, '关闭自动入库后只写收费不推送药房', r.data);
        await req('PUT', '/api/settings/1', { token, body: { warningAlert: false, autoPharmacy: true } });

        // 12. 带时间戳的日期解析（旧数据格式兼容）
        const nowD = new Date();
        const todayStamp = `${nowD.getFullYear()}/${nowD.getMonth() + 1}/${nowD.getDate()} 09:30:00`;
        r = await req('POST', '/api/pharmacy', {
            token,
            body: { patient: '零售客', drug: '测试阿莫西林', qty: 2, status: '待发药', date: todayStamp, source: 'retail' }
        });
        ok(r.status === 201, '带时间戳药房记录创建成功');
        const dash = await req('GET', '/api/dashboard/stats?period=today', { token });
        ok(dash.data && dash.data.today.pendingDrug >= 1, '带时间戳药房记录被计入今日待发药', dash.data && dash.data.today);

        // 13. 统计口径
        const stats = await req('GET', '/api/statistics/revenue?period=today', { token });
        ok(stats.data && stats.data.cards[0].value >= 137.5, '营业收费统计正确');
        const opFee = stats.data.cards.find(c => c.name === '门诊收费').value;
        const opCnt = stats.data.cards.find(c => c.name === '门诊诊量').value;
        const opCard = stats.data.cards.find(c => c.name === '门诊客单价');
        ok(opCard && Math.abs(opCard.value - opFee / opCnt) < 0.01, `门诊客单价按门诊收费/门诊诊量计算（${opCard && opCard.value}）`);

        // 14. 运营分析 + 日报
        const ops = await req('GET', '/api/statistics/operations?period=week', { token });
        ok(ops.data && Array.isArray(ops.data.daily) && ops.data.daily.length > 0, '运营分析含按日明细');
        ok(ops.data && ops.data.cards.finishedVisits >= 1, '运营分析完诊次数正确', ops.data && ops.data.cards);
        const trend = await req('GET', '/api/statistics/trend?range=1m', { token });
        ok(trend.data && Array.isArray(trend.data.revenue) && trend.data.revenue.length > 0, '趋势统计返回数据');
        const inv = await req('GET', '/api/statistics/inventory-overview', { token });
        ok(inv.data && Array.isArray(inv.data.pieData) && inv.data.pieData.length === 4, '库存统计返回4类数据');

        // ==================== v3.3 专项测试 ====================

        // 14.5 首页统计不再返回挂号数/预约数/挂号营收
        const dashV3 = await req('GET', '/api/dashboard/stats?period=today', { token });
        ok(dashV3.data && dashV3.data.today && dashV3.data.today.regCount === undefined && dashV3.data.today.appointmentCount === undefined,
            '首页统计不再返回挂号数/预约数', dashV3.data && dashV3.data.today);
        ok(dashV3.data && dashV3.data.revenue && dashV3.data.revenue.registration === undefined,
            '首页营收不再包含挂号预约收费');

        // 14.6 营收统计不再包含挂号预约收费卡片
        const revV3 = await req('GET', '/api/statistics/revenue?period=today', { token });
        ok(revV3.data && revV3.data.cards && !revV3.data.cards.some(c => (c.name || '').includes('挂号')),
            '营收统计无挂号预约收费卡片');

        // 14.7 病历词条自定义保存与读取
        r = await req('PUT', '/api/recordTerms', { token, body: { chief: ['自定义主诉词'], allergy: ['尘螨过敏'] } });
        ok(r.status === 200, '病历词条保存成功');
        r = await req('GET', '/api/recordTerms', { token });
        ok(r.data && Array.isArray(r.data.chief) && r.data.chief.includes('自定义主诉词') &&
           Array.isArray(r.data.allergy) && r.data.allergy.includes('尘螨过敏'), '病历词条读取成功');

        // 14.8 Excel 导入宽容性：缺列可导入，无名称行自动跳过
        r = await req('POST', '/api/drug-inventory/batch-import', {
            token,
            body: { items: [{ name: '测试导入药品', stock: 5 }, { name: '', stock: 9 }] }
        });
        ok(r.status === 200 && r.data && r.data.added === 1, '批量导入：缺列可导入，无名称行自动跳过', r.data);

        // 14.9 门诊结构化病历（症状/四诊/处方）随接诊保存
        r = await req('POST', '/api/visits/complete', {
            token,
            body: {
                patient: {
                    name: '测试患者丁',
                    chief: '咳嗽',
                    clinicData: {
                        duration_name: '3 天',
                        symptoms: ['咳嗽', '咽痛'],
                        tcm_exam: { body_shape: '形体中等', pulse_types: ['脉浮'] },
                        prescription: { type: 'herbal', herbs: [{ name: '甘草', dosage: 6, footnote: '' }] }
                    }
                }
            }
        });
        ok(r.status === 200 && r.data.data && r.data.data.clinicData &&
           r.data.data.clinicData.symptoms.includes('咽痛') &&
           r.data.data.clinicData.prescription.herbs[0].name === '甘草',
            '门诊结构化病历保存成功', r.data && r.data.data && r.data.data.clinicData);

        // 14.10 库存预警批量删除
        r = await req('POST', '/api/drug-inventory/stock-in', {
            token,
            body: { drugName: '测试待删除药品', qty: 1, unit: '盒', batchNo: 'DEL1', price: 10, cost: 5 }
        });
        const delInv = (await req('GET', '/api/drugInventory', { token })).data.find(d => d.name === '测试待删除药品');
        ok(!!delInv && delInv.id, '库存预警测试药品已入库', delInv);
        const invStat = await req('GET', '/api/statistics/inventory-overview', { token });
        ok(invStat.data && Array.isArray(invStat.data.alerts) && invStat.data.alerts.length > 0,
            '库存统计返回统一预警列表', invStat.data && invStat.data.alerts && invStat.data.alerts.length);
        r = await req('DELETE', '/api/drug-inventory', { token, body: { ids: [delInv.id] } });
        ok(r.status === 200 && r.data.deleted === 1, '库存预警批量删除成功', r.data);
        const delAfter = (await req('GET', '/api/drugInventory', { token })).data.find(d => d.name === '测试待删除药品');
        ok(!delAfter, '删除后库存不再包含该药品');

        // ==================== v3.2 专项测试 ====================

        // 15. 药典知识库（HTTP）
        const kbStats = await req('GET', '/api/pharmacopoeia/stats', { token });
        ok(kbStats.data && kbStats.data.pharma >= 400 && kbStats.data.formulas >= 100 && kbStats.data.interactions >= 50,
            '知识库统计：单药>=400、方剂>=100、相互作用>=50', kbStats.data);

        const lk = await req('GET', '/api/pharmacopoeia/lookup?name=' + encodeURIComponent('甘草'), { token });
        ok(lk.data && lk.data.found && lk.data.entry.category === '中药饮片' && /十八反/.test(lk.data.entry.contraindications || ''),
            '药典查询：甘草命中且含十八反禁忌', lk.data && lk.data.entry);

        const lkAlias = await req('GET', '/api/pharmacopoeia/lookup?name=' + encodeURIComponent('扑热息痛'), { token });
        ok(lkAlias.data && lkAlias.data.found && lkAlias.data.entry.name === '对乙酰氨基酚片', '药典查询：别名扑热息痛命中对乙酰氨基酚片');

        const lkMiss = await req('GET', '/api/pharmacopoeia/lookup?name=' + encodeURIComponent('不存在的药xyz'), { token });
        ok(lkMiss.data && lkMiss.data.found === false, '药典查询：未知药品返回 found=false');

        const sr = await req('GET', '/api/pharmacopoeia/search?q=' + encodeURIComponent('感冒') + '&limit=5', { token });
        ok(sr.data && Array.isArray(sr.data.items) && sr.data.items.length > 0, '药典搜索：感冒返回结果');

        const fl = await req('GET', '/api/formulas/library', { token });
        ok(fl.data && Array.isArray(fl.data) && fl.data.length >= 100 && fl.data.some(f => f.name === '四君子汤' && (f.composition || []).length === 4),
            '方剂库：>=100 首且四君子汤组成完整');

        // 16. 知识库模块单元测试（检索/RAG）
        knowledge.loadKnowledge();
        const invNames = ['测试阿莫西林', '甘草'];
        const topDrugs = knowledge.retrieveDrugs('咳嗽 发热 风寒 感冒', null, invNames, 6);
        ok(topDrugs.length > 0, 'RAG 检索：按症状检索到相关单药', topDrugs.map(d => d.name));
        const topFm = knowledge.retrieveFormulas('风寒 咳嗽', 3);
        ok(topFm.length > 0, 'RAG 检索：按症状检索到相关方剂', topFm.map(f => f.name));
        ok(knowledge.matchInteractions(['丹参']).some(i => i.drugClassZh === '抗凝血药'), '相互作用：丹参命中抗凝血药');
        ok(knowledge.expandQuery('怕冷 头痛').includes('恶寒'), '症状同义词扩展：怕冷→恶寒');
        const ganCao = knowledge.lookupDrug('甘草');
        ok(!!knowledge.lookupDrug('甘遂') && /甘遂/.test((ganCao && ganCao.contraindications) || ''),
            '十八反：甘草禁忌含甘遂（知识库可命中）');

        // 17. AI 模块单元测试（mock fetch，不联网）
        const mockOk = async () => ({
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify({
                suggestions: [{ name: '测试阿莫西林', qty: 10, dose: '1片', frequency: '一日2次', days: '3天', note: '测试' }],
                rationale: '测试思路', warnings: []
            }) } }] })
        });
        const mock429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
        const mockInvalid = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '这不是JSON' } }] }) });
        const settingsOn = { aiConfig: { enabled: true, provider: 'zhipu', baseUrl: 'https://example.com', apiKey: 'test-key', model: 'glm-4.7-flash' } };
        const inventory = [{ name: '测试阿莫西林', price: 12.5, unit: '盒', stock: 100 }];
        const patient = { chief: '咳嗽3天', diagnosis: '感冒', allergy: '', gender: '男', age: 30 };

        ai._setFetch(mockOk);
        const gen = await ai.generatePrescription(settingsOn, { patient, prescriptions: [], inventory, userEntries: [] });
        ok(gen.suggestions.length === 1 && gen.suggestions[0].name === '测试阿莫西林' && gen.suggestions[0].subtotal === 125,
            'AI 开方：合法 JSON 通过白名单校验且金额服务端计算', gen.suggestions);

        ai._setFetch(mockInvalid);
        let genErr = null;
        try { await ai.generatePrescription(settingsOn, { patient, prescriptions: [], inventory, userEntries: [] }); } catch (e) { genErr = e.message; }
        ok(genErr && /格式不正确/.test(genErr), 'AI 开方：非法 JSON 返回明确错误', genErr);

        ai._setFetch(mock429);
        let quotaErr = null;
        try { await ai.testConnection(settingsOn); } catch (e) { quotaErr = e.message; }
        ok(quotaErr && /额度/.test(quotaErr), 'AI 测试：限流 429 返回友好提示', quotaErr);

        const mockOutOfStock = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
            suggestions: [{ name: '不存在的药', qty: 1, dose: '', frequency: '', days: '', note: '' }],
            rationale: '', warnings: []
        }) } }] }) });
        ai._setFetch(mockOutOfStock);
        let outErr = null;
        try { await ai.generatePrescription(settingsOn, { patient, prescriptions: [], inventory, userEntries: [] }); } catch (e) { outErr = e.message; }
        ok(outErr && /不在本诊所库存/.test(outErr), 'AI 开方：非库存药品被白名单拦截', outErr);

        // 18. AI 审方（知识库规则）
        ai._setFetch(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"risks":[]}' } }] }) }));
        const revShiBa = await ai.reviewPrescription({ aiConfig: { enabled: true, apiKey: 'k', baseUrl: 'https://example.com', model: 'm' } },
            { patient: { allergy: '' }, prescriptions: [{ name: '甘草' }, { name: '甘遂' }], userEntries: [] });
        ok(revShiBa.risks.some(x => /甘草/.test(x.drug) || /甘遂/.test(x.drug)), 'AI 审方：甘草+甘遂触发十八反', revShiBa.risks);

        const revAllergy = await ai.reviewPrescription({ aiConfig: { enabled: false } },
            { patient: { allergy: '青霉素' }, prescriptions: [{ name: '阿莫西林胶囊' }], userEntries: [] });
        ok(revAllergy.risks.some(x => /青霉素/.test(x.issue)), 'AI 审方：青霉素过敏命中阿莫西林禁忌', revAllergy.risks);

        const revInter = await ai.reviewPrescription({ aiConfig: { enabled: false } },
            { patient: { allergy: '' }, prescriptions: [{ name: '丹参' }], userEntries: [] });
        ok(revInter.risks.some(x => /抗凝血/.test(x.issue)), 'AI 审方：丹参命中抗凝药相互作用', revInter.risks);

        // 19. AI 接口未配置 Key 时的 HTTP 行为
        r = await req('POST', '/api/ai/test', { token });
        ok(r.status === 400 && /API Key/.test((r.data && r.data.error) || ''), 'AI 测试未配置 Key 返回明确错误', r.data);
        r = await req('POST', '/api/ai/generate-prescription', { token, body: { patient: { chief: '咳嗽', diagnosis: '感冒' }, prescriptions: [] } });
        ok(r.status === 400 && /AI 辅助诊断未开启/.test((r.data && r.data.error) || ''), 'AI 开方未启用返回明确错误', r.data);

        // 20. 患者档案迁移（幂等）
        r = await req('POST', '/api/patients/migrate', { token });
        const totalP1 = r.data && r.data.total;
        r = await req('POST', '/api/patients/migrate', { token });
        ok(r.data && r.data.total === totalP1 && r.data.total >= 2 && r.data.created === 0, '患者迁移幂等：重复执行不重复建档', r.data);
        const pats = await req('GET', '/api/patients', { token });
        const patA = pats.data.find(p => p.name === '测试患者甲');
        ok(!!patA && patA.visitCount >= 1 && Array.isArray(patA.visits) && patA.visits.length >= 1, '患者档案包含历次就诊记录', patA && patA.visits && patA.visits.length);
        r = await req('PUT', `/api/patients/${patA.id}`, { token, body: { allergy: '阿莫西林' } });
        ok(r.status === 200 && r.data.data && r.data.data.allergy === '阿莫西林', '患者档案编辑保存成功', r.data);

        // 21. 盘点
        const invCur = (await req('GET', '/api/drugInventory', { token })).data.find(d => d.name === '测试阿莫西林');
        const target = Number(invCur.stock) - 5;
        r = await req('POST', '/api/inventory/check', { token, body: { items: [{ name: '测试阿莫西林', actual: target }] } });
        ok(r.status === 200 && r.data.changed === 1 && r.data.details[0].newStock === target, '盘点：账面库存调整正确', r.data);
        r = await req('POST', '/api/inventory/check', { token, body: { items: [{ name: '测试阿莫西林', actual: target }] } });
        ok(r.status === 200 && r.data.changed === 0, '盘点：相同实盘数不重复调整', r.data);

        // 22. 增强统计（处方量/毛利/复诊率）
        r = await req('GET', '/api/statistics/enhanced?range=1m', { token });
        ok(r.status === 200 && r.data.rxTotal >= 1 && r.data.grossProfit !== undefined && r.data.totalPatients >= 1,
            '增强统计：处方量/毛利/患者数返回', r.data);

        // 23. 页面可访问
        for (const p of ['/', '/index.html', '/login.html']) {
            const res = await fetch(BASE_URL + p);
            ok(res.status === 200 && /愈康/.test(await res.text()), `页面可访问: ${p}`);
        }

        console.log('\n========================================');
        console.log(`  通过: ${passed}  |  失败: ${failed}`);
        if (failures.length) console.log('  失败项: ' + failures.join('; '));
        console.log('========================================');
    } finally {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 1500);
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试异常:', err);
    process.exit(2);
});
