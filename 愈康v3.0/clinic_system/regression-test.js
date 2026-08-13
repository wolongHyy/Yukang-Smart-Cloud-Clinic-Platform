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
        let r = await req('GET', '/api/registrations');
        ok(r.status === 401, '无令牌访问受保护接口返回 401');
        r = await req('GET', '/api/registrations', { token: 'invalid-token' });
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

        // 6. 挂号 + 挂号列表
        r = await req('POST', '/api/registrations', {
            token,
            body: { name: '测试患者甲', gender: '男', age: '30', phone: '13800000001', date: '2026/08/10', status: '待就诊' }
        });
        ok(r.status === 201 && r.data && r.data.data && r.data.data.id, '新建挂号成功', r.data);
        const regId = r.data && r.data.data && r.data.data.id;

        // 7. 药品入库
        r = await req('POST', '/api/drug-inventory/stock-in', {
            token,
            body: { drugName: '测试阿莫西林', qty: 100, unit: '盒', batchNo: 'B20260810', expiry: '2027/12/31', supplier: '测试供应商', cost: 8, price: 12.5 }
        });
        ok(r.status === 201, '药品入库成功', r.data);

        // 8. 事务化接诊：挂号转门诊 + 收费 + 药房推送
        r = await req('POST', '/api/visits/complete', {
            token,
            body: {
                registrationId: regId,
                patient: { chief: '咳嗽三天', diagnosis: '上呼吸道感染', feeType: '医保' },
                prescriptions: [{ name: '测试阿莫西林', qty: 10, price: 12.5, subtotal: 999 }]
            }
        });
        ok(r.status === 200 && r.data && r.data.success !== false, '事务化接诊成功', r.data);
        const visitData = r.data && r.data.data;
        ok(visitData && String(visitData.id) === String(regId), '门诊记录沿用挂号ID');
        ok(visitData && visitData.status === '已就诊' && visitData.prescriptions.length === 1, '门诊记录状态与处方正确');
        ok(r.data && r.data.revenueAmount === 125, '收费金额由服务端重算为 125（忽略客户端 subtotal=999）', r.data && r.data.revenueAmount);
        ok(r.data && r.data.pharmacyPushed === 1, '药房推送 1 条待发药记录');

        let rl = await req('GET', '/api/registrations', { token });
        ok(!rl.data.some(x => String(x.id) === String(regId)), '挂号记录已移除');
        let ol = await req('GET', '/api/outpatients', { token });
        ok(ol.data.some(x => String(x.id) === String(regId)), '门诊记录已生成');
        let rv = await req('GET', '/api/revenue', { token });
        ok(rv.data.some(x => x.amount === 125 && x.desc === '门诊药品费' && x.payMethod === '医保'), '收费记录已写入');
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
        r = await req('POST', '/api/pharmacy', {
            token,
            body: { patient: '零售客', drug: '测试阿莫西林', qty: 2, status: '待发药', date: '2026/8/10 09:30:00', source: 'retail' }
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

        // 15. 页面可访问
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
