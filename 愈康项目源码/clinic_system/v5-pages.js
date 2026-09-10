/* 愈康 v5.0 页面增强：收费、门店控制台、图形化备份恢复。 */
(function () {
    'use strict';

    const API_ROOT = (() => {
        const saved = (localStorage.getItem('clinic_server_url') || window.location.origin).replace(/\/+$/, '');
        return saved + '/api';
    })();
    const TOKEN_KEY = 'clinic_token';
    const PROFILE_KEY = 'clinic_profile';
    const PAY_FALLBACK = ['现金', '微信', '支付宝', '银行卡', '医保', '其他'];

    const $ = id => document.getElementById(id);
    const escapeHtml = value => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const money = value => '¥' + (Number(value) || 0).toFixed(2);
    const storeRoleText = value => value === 'headquarters' ? '总店' : (value === 'branch' ? '分店' : '单体诊所');
    const billingStatusText = value => value === 'paid' ? '已收费' : '待收费';
    const formatDate = value => {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN', { hour12: false });
    };
    const formatSize = bytes => {
        const size = Number(bytes) || 0;
        if (size < 1024) return size + ' B';
        if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
        return (size / 1024 / 1024).toFixed(2) + ' MB';
    };
    const notify = (message, type) => {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'success');
        else if (type === 'error') alert(message);
    };
    const token = () => localStorage.getItem(TOKEN_KEY) || '';
    const readProfile = () => {
        try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null') || {}; } catch (_) { return {}; }
    };
    const writeProfile = value => localStorage.setItem(PROFILE_KEY, JSON.stringify(value || {}));

    async function api(path, options = {}) {
        const request = { ...options, headers: { ...(options.headers || {}), 'x-auth-token': token() } };
        const response = await fetch(API_ROOT + path, request);
        if (response.status === 401) {
            localStorage.removeItem('clinic_user');
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(PROFILE_KEY);
            window.location.href = 'login.html';
            throw new Error('登录已过期');
        }
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json') ? await response.json() : await response.text();
        if (!response.ok) {
            const message = payload && typeof payload === 'object' ? payload.error : payload;
            throw new Error(message || `请求失败（${response.status}）`);
        }
        return payload;
    }

    let profile = readProfile();
    let billingData = [];
    let billingMethods = PAY_FALLBACK.slice();
    let billingFilter = 'pending';
    let billingKeyword = '';
    let currentBill = null;
    let currentRestoreFile = '';

    function ensureShell() {
        const nav = $('mainNav');
        const wrapper = document.querySelector('.main-wrapper');
        if (!nav || !wrapper) return;

        if (!$('v5BillingNav')) {
            const billingNav = document.createElement('span');
            billingNav.id = 'v5BillingNav';
            billingNav.dataset.target = 'page-billing';
            billingNav.textContent = '收费';
            const settingsNav = nav.querySelector('[data-target="page-settings"]');
            nav.insertBefore(billingNav, settingsNav || null);
        }
        if (!$('v5ClinicsNav')) {
            const clinicsNav = document.createElement('span');
            clinicsNav.id = 'v5ClinicsNav';
            clinicsNav.dataset.target = 'page-clinics';
            clinicsNav.textContent = '门店';
            const settingsNav = nav.querySelector('[data-target="page-settings"]');
            nav.insertBefore(clinicsNav, settingsNav || null);
        }

        if (!$('page-billing')) {
            const section = document.createElement('section');
            section.id = 'page-billing';
            section.className = 'page-content';
            section.innerHTML = `
                <div class="v5-page-head">
                    <div>
                        <h2 class="v5-page-title">门诊收费</h2>
                        <div class="v5-page-copy">接诊后生成待收费单，收费成功后才计入营收；支持 A4 与 80mm 收费单打印。</div>
                    </div>
                    <div class="v5-toolbar">
                        <button class="v5-btn" id="v5RefreshBilling"><i class="fas fa-rotate"></i> 刷新</button>
                    </div>
                </div>
                <div class="v5-summary-grid">
                    <div class="v5-summary-card danger"><div class="v5-summary-label">待收费</div><div class="v5-summary-value" id="v5BillingPending">0</div><div class="v5-summary-note">尚未计入营收</div></div>
                    <div class="v5-summary-card gold"><div class="v5-summary-label">待收金额</div><div class="v5-summary-value" id="v5BillingPendingAmount">¥0.00</div><div class="v5-summary-note">支付后自动清零</div></div>
                    <div class="v5-summary-card"><div class="v5-summary-label">已收费</div><div class="v5-summary-value" id="v5BillingPaid">0</div><div class="v5-summary-note">已完成收费单</div></div>
                    <div class="v5-summary-card"><div class="v5-summary-label">已收金额</div><div class="v5-summary-value" id="v5BillingPaidAmount">¥0.00</div><div class="v5-summary-note">仅统计已支付单据</div></div>
                </div>
                <div class="v5-panel">
                    <div class="v5-panel-head">
                        <div>
                            <h3>收费工作台</h3>
                            <p>收费后不可重复支付；补打仅增加打印记录，不会重建营收。</p>
                        </div>
                        <div class="v5-filter-row">
                            <button class="v5-filter active" data-billing-filter="pending">待收费</button>
                            <button class="v5-filter" data-billing-filter="paid">已收费</button>
                            <button class="v5-filter" data-billing-filter="all">全部</button>
                        </div>
                    </div>
                    <div class="v5-toolbar" style="margin-bottom:12px;">
                        <input class="v5-input" id="v5BillingKeyword" style="max-width:310px;" placeholder="搜索患者姓名或收费单号">
                        <button class="v5-btn" id="v5BillingSearch"><i class="fas fa-search"></i> 搜索</button>
                        <button class="v5-btn" id="v5BillingClear">清空</button>
                    </div>
                    <div class="v5-table-wrap">
                        <table class="v5-table">
                            <thead><tr><th>患者</th><th>收费单号</th><th>应收金额</th><th>创建时间</th><th>状态</th><th>打印次数</th><th>操作</th></tr></thead>
                            <tbody id="v5BillingBody"><tr><td colspan="7" class="v5-empty"><i class="fas fa-receipt"></i>正在加载收费记录...</td></tr></tbody>
                        </table>
                    </div>
                </div>`;
            wrapper.appendChild(section);
        }

        if (!$('page-clinics')) {
            const section = document.createElement('section');
            section.id = 'page-clinics';
            section.className = 'page-content';
            section.innerHTML = `
                <div class="v5-page-head">
                    <div>
                        <h2 class="v5-page-title">门店控制台</h2>
                        <div class="v5-page-copy">总店负责人可查看本连锁组织全部门店的接诊、收费、药房和库存概况；分店账号无法访问本页。</div>
                    </div>
                    <div class="v5-toolbar"><button class="v5-btn" id="v5RefreshClinics"><i class="fas fa-rotate"></i> 刷新门店</button></div>
                </div>
                <div class="v5-summary-grid">
                    <div class="v5-summary-card"><div class="v5-summary-label">门店数量</div><div class="v5-summary-value" id="v5StoreCount">0</div><div class="v5-summary-note">同一连锁组织</div></div>
                    <div class="v5-summary-card"><div class="v5-summary-label">累计营收</div><div class="v5-summary-value" id="v5StoreRevenue">¥0.00</div><div class="v5-summary-note">已支付收费记录</div></div>
                    <div class="v5-summary-card danger"><div class="v5-summary-label">待收费</div><div class="v5-summary-value" id="v5StorePendingBilling">0</div><div class="v5-summary-note">全部门店合计</div></div>
                    <div class="v5-summary-card gold"><div class="v5-summary-label">库存预警</div><div class="v5-summary-value" id="v5StoreLowStock">0</div><div class="v5-summary-note">低库存与耗尽药品</div></div>
                </div>
                <div class="v5-panel">
                    <div class="v5-panel-head"><div><h3>门店经营概况</h3><p>每个门店使用独立的 SQLite 数据文件，账号会话绑定门店范围。</p></div></div>
                    <div class="v5-store-grid" id="v5StoreGrid"><div class="v5-empty"><i class="fas fa-store-alt"></i>正在加载门店概况...</div></div>
                </div>
                <div class="v5-panel">
                    <div class="v5-panel-head">
                        <div><h3>分店注册邀请</h3><p>邀请码 24 小时有效且只能使用一次。分店注册后自动加入当前连锁组织。</p></div>
                        <button class="v5-btn primary" id="v5CreateInvite"><i class="fas fa-key"></i> 生成邀请码</button>
                    </div>
                    <div class="v5-invite-box" id="v5InviteBox">
                        <div class="v5-muted">尚未生成邀请码。生成后请发送给分店负责人，由其在注册页选择“分店”并填写。</div>
                        <div class="v5-invite-code" id="v5InviteCode" style="display:none;"></div>
                        <div class="v5-muted" id="v5InviteExpiry" style="margin-top:8px;"></div>
                        <button class="v5-btn small" id="v5CopyInvite" style="display:none; margin-top:10px;"><i class="fas fa-copy"></i> 复制邀请码</button>
                    </div>
                </div>`;
            wrapper.appendChild(section);
        }

        const settingsPage = $('page-settings');
        if (settingsPage && !$('v5BackupCard')) {
            const card = document.createElement('div');
            card.id = 'v5BackupCard';
            card.className = 'card';
            card.style.marginTop = '12px';
            card.innerHTML = `
                <div class="v5-panel-head">
                    <div><div class="section-title" style="margin-bottom:3px;">图形化备份与恢复</div><small style="color:var(--text-faint);">创建数据库快照、查看备份记录，并可在误操作后恢复。恢复前会自动生成 pre-restore 快照。</small></div>
                    <div class="v5-toolbar"><button class="v5-btn" id="v5RefreshBackups"><i class="fas fa-rotate"></i> 刷新</button><button class="v5-btn primary" id="v5CreateBackup"><i class="fas fa-cloud-arrow-up"></i> 立即备份</button></div>
                </div>
                <div class="v5-backup-list" id="v5BackupList"><div class="v5-empty"><i class="fas fa-database"></i>正在加载备份记录...</div></div>
                <div class="v5-warning"><b>恢复会覆盖当前全部诊所数据。</b> 恢复成功后需要重新登录；系统会保留恢复前快照，便于再次回退。</div>`;
            settingsPage.appendChild(card);
        }

        if (!$('modalV5Payment')) {
            const payment = document.createElement('div');
            payment.id = 'modalV5Payment';
            payment.className = 'v5-modal';
            payment.innerHTML = `
                <div class="v5-modal-card" role="dialog" aria-modal="true" aria-labelledby="v5PaymentTitle">
                    <div class="v5-modal-head"><div><h3 id="v5PaymentTitle">确认收费</h3><p id="v5PaymentBillNo">-</p></div><button class="v5-modal-close" data-v5-close="modalV5Payment" aria-label="关闭">&times;</button></div>
                    <div class="v5-modal-body">
                        <div class="v5-payment-total"><span>应收金额</span><strong id="v5PaymentAmount">¥0.00</strong></div>
                        <div class="v5-form-grid">
                            <div class="v5-field"><label for="v5PayMethod">支付方式</label><select class="v5-select" id="v5PayMethod"></select></div>
                            <div class="v5-field"><label for="v5ReceivedAmount">实收金额</label><input class="v5-input" id="v5ReceivedAmount" type="number" min="0" step="0.01"></div>
                            <div class="v5-field full"><div class="v5-change" id="v5ChangeAmount">找零：¥0.00</div></div>
                        </div>
                        <div class="v5-error" id="v5PaymentError"></div>
                    </div>
                    <div class="v5-modal-actions"><button class="v5-btn" data-v5-close="modalV5Payment">取消</button><button class="v5-btn primary" id="v5SubmitPayment"><i class="fas fa-check"></i> 确认收费</button></div>
                </div>`;
            document.body.appendChild(payment);
        }

        if (!$('modalV5Restore')) {
            const restore = document.createElement('div');
            restore.id = 'modalV5Restore';
            restore.className = 'v5-modal';
            restore.innerHTML = `
                <div class="v5-modal-card" role="dialog" aria-modal="true" aria-labelledby="v5RestoreTitle">
                    <div class="v5-modal-head"><div><h3 id="v5RestoreTitle">恢复数据库快照</h3><p id="v5RestoreFile">-</p></div><button class="v5-modal-close" data-v5-close="modalV5Restore" aria-label="关闭">&times;</button></div>
                    <div class="v5-modal-body">
                        <div class="v5-warning">此操作会用所选快照覆盖当前数据库。请输入大写英文单词 <b>RESTORE</b> 确认。</div>
                        <input class="v5-input v5-restore-input" id="v5RestoreInput" autocomplete="off" placeholder="输入 RESTORE">
                        <div class="v5-error" id="v5RestoreError"></div>
                    </div>
                    <div class="v5-modal-actions"><button class="v5-btn" data-v5-close="modalV5Restore">取消</button><button class="v5-btn danger" id="v5SubmitRestore"><i class="fas fa-clock-rotate-left"></i> 确认恢复</button></div>
                </div>`;
            document.body.appendChild(restore);
        }
    }

    function syncNavigation() {
        const canManage = profile && profile.canManageStores === true;
        const clinicsNav = $('v5ClinicsNav');
        const clinicsPage = $('page-clinics');
        if (clinicsNav) clinicsNav.style.display = canManage ? '' : 'none';
        if (clinicsPage && !canManage) clinicsPage.remove();
    }

    function renderAccountContext() {
        const userInfo = document.querySelector('.user-info');
        if (!userInfo) return;
        let context = $('v5AccountContext');
        if (!context) {
            context = document.createElement('div');
            context.id = 'v5AccountContext';
            context.className = 'v5-account-context';
            userInfo.insertBefore(context, userInfo.firstChild);
        }
        const name = profile.fullName || localStorage.getItem('clinic_user') || '当前账号';
        const clinic = profile.clinicName || '未绑定门店';
        context.innerHTML = `<b>${escapeHtml(name)}</b><small>${escapeHtml(clinic)} · ${escapeHtml(storeRoleText(profile.storeRole))}</small>`;
        const currentUserEl = $('currentUsername');
        if (currentUserEl) currentUserEl.textContent = name;
    }

    async function refreshProfile() {
        try {
            profile = await api('/account/me');
            writeProfile(profile);
            renderAccountContext();
            syncNavigation();
            return profile;
        } catch (error) {
            if (error.message !== '登录已过期') notify(error.message, 'error');
            throw error;
        }
    }

    function filteredBills() {
        const keyword = billingKeyword.trim().toLowerCase();
        return billingData.filter(item => {
            if (billingFilter !== 'all' && item.status !== billingFilter) return false;
            if (!keyword) return true;
            return String(item.patientName || '').toLowerCase().includes(keyword) || String(item.billNo || '').toLowerCase().includes(keyword);
        });
    }

    function renderBilling() {
        const pending = billingData.filter(item => item.status === 'pending');
        const paid = billingData.filter(item => item.status === 'paid');
        const pendingAmount = pending.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        const paidAmount = paid.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        if ($('v5BillingPending')) $('v5BillingPending').textContent = pending.length;
        if ($('v5BillingPendingAmount')) $('v5BillingPendingAmount').textContent = money(pendingAmount);
        if ($('v5BillingPaid')) $('v5BillingPaid').textContent = paid.length;
        if ($('v5BillingPaidAmount')) $('v5BillingPaidAmount').textContent = money(paidAmount);
        document.querySelectorAll('[data-billing-filter]').forEach(button => button.classList.toggle('active', button.dataset.billingFilter === billingFilter));

        const body = $('v5BillingBody');
        if (!body) return;
        const rows = filteredBills();
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="7" class="v5-empty"><i class="fas fa-receipt"></i>${billingKeyword ? '没有匹配的收费记录' : '当前筛选下暂无收费记录'}</td></tr>`;
            return;
        }
        body.innerHTML = rows.map(item => {
            const actions = item.status === 'pending'
                ? `<button class="v5-btn primary small" data-billing-action="pay" data-id="${escapeHtml(item.id)}"><i class="fas fa-money-bill-wave"></i> 收费</button>`
                : `<button class="v5-btn small" data-billing-action="print" data-format="a4" data-id="${escapeHtml(item.id)}">A4 打印</button>
                   <button class="v5-btn small" data-billing-action="print" data-format="80mm" data-id="${escapeHtml(item.id)}">80mm</button>
                   <button class="v5-btn gold small" data-billing-action="print" data-format="80mm" data-id="${escapeHtml(item.id)}">补打</button>`;
            return `<tr>
                <td><b>${escapeHtml(item.patientName || '-')}</b>${item.outpatientId ? `<div class="v5-muted">门诊 ${escapeHtml(item.outpatientId)}</div>` : ''}</td>
                <td>${escapeHtml(item.billNo || '-')}</td>
                <td class="v5-money">${money(item.amount)}</td>
                <td>${escapeHtml(formatDate(item.createdAt))}</td>
                <td><span class="v5-status ${item.status === 'paid' ? 'paid' : 'pending'}">${billingStatusText(item.status)}</span></td>
                <td>${Number(item.printCount) || 0}</td>
                <td><div class="v5-actions">${actions}</div></td>
            </tr>`;
        }).join('');
    }

    async function loadBilling() {
        try {
            const payload = await api('/billing');
            billingMethods = Array.isArray(payload.methods) && payload.methods.length ? payload.methods : PAY_FALLBACK;
            billingData = Array.isArray(payload.bills) ? payload.bills : [];
            renderBilling();
        } catch (error) {
            if (error.message !== '登录已过期') {
                const body = $('v5BillingBody');
                if (body) body.innerHTML = `<tr><td colspan="7" class="v5-empty"><i class="fas fa-triangle-exclamation"></i>${escapeHtml(error.message)}</td></tr>`;
                notify(error.message, 'error');
            }
        }
    }

    function updateChangeAmount() {
        const amount = Number(currentBill && currentBill.amount) || 0;
        const received = Number($('v5ReceivedAmount') && $('v5ReceivedAmount').value);
        const change = Number.isFinite(received) ? received - amount : 0;
        if ($('v5ChangeAmount')) $('v5ChangeAmount').textContent = `找零：${money(Math.max(0, change))}`;
    }

    function openPayment(id) {
        currentBill = billingData.find(item => String(item.id) === String(id));
        if (!currentBill || currentBill.status !== 'pending') return notify('该收费单状态已变化，请刷新后重试', 'error');
        $('v5PaymentBillNo').textContent = currentBill.billNo || '-';
        $('v5PaymentAmount').textContent = money(currentBill.amount);
        $('v5PayMethod').innerHTML = billingMethods.map(method => `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join('');
        $('v5ReceivedAmount').value = Number(currentBill.amount).toFixed(2);
        $('v5PaymentError').textContent = '';
        updateChangeAmount();
        $('modalV5Payment').classList.add('show');
        document.body.style.overflow = 'hidden';
        setTimeout(() => $('v5PayMethod') && $('v5PayMethod').focus(), 50);
    }

    function closeModal(id) {
        const modal = $(id);
        if (modal) modal.classList.remove('show');
        if (!$('modalV5Payment').classList.contains('show') && !$('modalV5Restore').classList.contains('show')) document.body.style.overflow = '';
    }

    async function submitPayment() {
        if (!currentBill) return;
        const amount = Number(currentBill.amount) || 0;
        const receivedAmount = Number($('v5ReceivedAmount').value);
        const payMethod = $('v5PayMethod').value;
        if (!Number.isFinite(receivedAmount) || receivedAmount < amount) {
            $('v5PaymentError').textContent = `实收金额不能小于 ${money(amount)}`;
            return;
        }
        const button = $('v5SubmitPayment');
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中';
        try {
            await api(`/billing/${encodeURIComponent(currentBill.id)}/pay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payMethod, receivedAmount })
            });
            notify('收费成功，营收已入账');
            closeModal('modalV5Payment');
            await loadBilling();
            if (typeof window.loadDashboardStats === 'function') window.loadDashboardStats();
            if (typeof window.loadAllData === 'function') window.loadAllData();
        } catch (error) {
            if (error.message !== '登录已过期') $('v5PaymentError').textContent = error.message;
        } finally {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-check"></i> 确认收费';
        }
    }

    function buildPrintHtml(bill, format) {
        const items = Array.isArray(bill.items) ? bill.items : [];
        const billItems = items.length
            ? items.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.name || '-')}</td><td>${escapeHtml(item.spec || '')}</td><td>${escapeHtml(item.qty || '')}${escapeHtml(item.qtyUnit || '')}</td><td style="text-align:right;">${money(item.subtotal)}</td></tr>`).join('')
            : `<tr><td colspan="5" style="text-align:center;">门诊药品费用</td></tr>`;
        const compact = format === '80mm';
        const pageSize = compact ? '80mm auto' : 'A4';
        const title = compact ? '门诊收费小票' : '门诊收费单';
        const clinicName = profile.clinicName || '愈康云诊所';
        const printHistory = Array.isArray(bill.printHistory) ? bill.printHistory : [];
        const historyText = printHistory.length > 1 ? `第 ${printHistory.length} 次打印（补打）` : `第 ${printHistory.length || 1} 次打印`;
        const itemTable = compact
            ? `<div class="items">${items.length ? items.map((item, index) => `<div class="item"><b>${index + 1}. ${escapeHtml(item.name || '-')}</b><span>${escapeHtml(item.qty || '')}${escapeHtml(item.qtyUnit || '')}　${money(item.subtotal)}</span></div>`).join('') : '<div class="item"><b>门诊药品费用</b><span>' + money(bill.amount) + '</span></div>'}</div>`
            : `<table><thead><tr><th>序号</th><th>项目</th><th>规格</th><th>数量</th><th>金额</th></tr></thead><tbody>${billItems}</tbody></table>`;
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} - ${escapeHtml(bill.patientName || '')}</title>
        <style>
            @page { size: ${pageSize}; margin: ${compact ? '4mm 3mm' : '14mm'}; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #111; font-family: "Microsoft YaHei", "SimSun", sans-serif; font-size: ${compact ? '11px' : '13px'}; }
            .sheet { width: ${compact ? '72mm' : '100%'}; margin: 0 auto; }
            h1 { margin: 0; text-align: center; font-size: ${compact ? '18px' : '25px'}; letter-spacing: .08em; }
            .sub { margin: 4px 0 14px; text-align: center; color: #555; font-size: ${compact ? '10px' : '12px'}; }
            .meta { display: grid; grid-template-columns: ${compact ? '1fr' : '1fr 1fr'}; gap: ${compact ? '3px' : '7px 20px'}; padding: ${compact ? '8px 0' : '12px 0'}; border-top: 1px solid #222; border-bottom: 1px solid #222; }
            .meta div { display: flex; justify-content: space-between; gap: 10px; }
            .meta b { font-weight: 600; }
            table { width: 100%; margin-top: 12px; border-collapse: collapse; }
            th, td { padding: 7px 5px; border: 1px solid #777; text-align: left; }
            th { background: #f1f1f1; }
            .items { margin-top: 10px; border-top: 1px dashed #555; }
            .item { display: flex; justify-content: space-between; gap: 8px; padding: 7px 0; border-bottom: 1px dashed #aaa; }
            .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 14px; padding-top: 10px; border-top: 1px solid #222; font-weight: 700; }
            .total strong { font-size: ${compact ? '20px' : '23px'}; }
            .footer { margin-top: 18px; color: #555; font-size: ${compact ? '9px' : '11px'}; line-height: 1.7; }
            .footer .row { display: flex; justify-content: space-between; gap: 10px; }
            .sign { margin-top: ${compact ? '18px' : '48px'}; display: flex; justify-content: space-between; }
            @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        </style></head><body><main class="sheet">
            <h1>${escapeHtml(clinicName)}</h1>
            <div class="sub">${escapeHtml(title)} · ${escapeHtml(historyText)}</div>
            <div class="meta">
                <div><b>收费单号</b><span>${escapeHtml(bill.billNo || '-')}</span></div>
                <div><b>患者姓名</b><span>${escapeHtml(bill.patientName || '-')}</span></div>
                <div><b>收费时间</b><span>${escapeHtml(formatDate(bill.paidAt))}</span></div>
                <div><b>支付方式</b><span>${escapeHtml(bill.payMethod || '-')}</span></div>
            </div>
            ${itemTable}
            <div class="total"><span>应收金额</span><strong>${money(bill.amount)}</strong></div>
            <div class="footer">
                <div class="row"><span>实收：${money(bill.receivedAmount)}</span><span>找零：${money(bill.changeAmount)}</span></div>
                <div class="row"><span>打印操作员：${escapeHtml(bill.lastPrintedBy || profile.username || '-')}</span><span>打印时间：${escapeHtml(formatDate(bill.lastPrintedAt))}</span></div>
            </div>
            <div class="sign"><span>收费员：_____________</span><span>患者签字：_____________</span></div>
        </main></body></html>`;
    }

    async function printBill(id, format) {
        try {
            const bill = await api(`/billing/${encodeURIComponent(id)}/print`, { method: 'POST' });
            const popup = window.open('', '_blank', 'noopener,noreferrer');
            if (!popup) return notify('浏览器阻止了打印窗口，请允许弹出窗口后重试', 'error');
            popup.document.open();
            popup.document.write(buildPrintHtml(bill, format));
            popup.document.close();
            popup.focus();
            setTimeout(() => { try { popup.print(); } catch (_) {} }, 260);
            const index = billingData.findIndex(item => String(item.id) === String(id));
            if (index !== -1) billingData[index] = bill;
            renderBilling();
            notify(format === '80mm' ? '80mm 收费单已生成' : 'A4 收费单已生成');
        } catch (error) {
            if (error.message !== '登录已过期') notify(error.message, 'error');
        }
    }

    function renderClinics(payload) {
        const stores = Array.isArray(payload && payload.stores) ? payload.stores : [];
        const totals = (payload && payload.totals) || {};
        if ($('v5StoreCount')) $('v5StoreCount').textContent = Number(totals.clinicCount) || stores.length || 0;
        if ($('v5StoreRevenue')) $('v5StoreRevenue').textContent = money(totals.revenue);
        if ($('v5StorePendingBilling')) $('v5StorePendingBilling').textContent = Number(totals.pendingBillingCount) || 0;
        if ($('v5StoreLowStock')) $('v5StoreLowStock').textContent = Number(totals.lowStockCount) || 0;
        const grid = $('v5StoreGrid');
        if (!grid) return;
        if (!stores.length) {
            grid.innerHTML = '<div class="v5-empty"><i class="fas fa-store-slash"></i>暂无可查看门店</div>';
            return;
        }
        grid.innerHTML = stores.map(store => `<article class="v5-store-card">
            <span class="v5-status ${store.storeRole === 'headquarters' ? 'headquarters' : 'branch'}">${escapeHtml(storeRoleText(store.storeRole))}</span>
            <h4>${escapeHtml(store.name || store.clinicId || '-')}</h4>
            <div class="v5-store-meta">门店编号：${escapeHtml(store.clinicId || store.id || '-')}<br>负责人：${escapeHtml(store.owner || store.ownerName || '-')} ${store.ownerPhone ? ' · ' + escapeHtml(store.ownerPhone) : ''}</div>
            <div class="v5-store-metrics">
                <div><span>门诊量</span><b>${Number(store.visitCount) || 0}</b></div>
                <div><span>患者数</span><b>${Number(store.patientCount) || 0}</b></div>
                <div><span>累计营收</span><b>${money(store.revenue)}</b></div>
                <div><span>待收费</span><b>${Number(store.pendingBillingCount) || 0}</b></div>
                <div><span>待发药</span><b>${Number(store.pendingPharmacyCount) || 0}</b></div>
                <div><span>库存预警</span><b>${Number(store.lowStockCount) || 0}</b></div>
            </div>
        </article>`).join('');
    }

    async function loadClinics() {
        if (!profile || profile.canManageStores !== true) return;
        try {
            renderClinics(await api('/clinics/overview'));
        } catch (error) {
            if (error.message !== '登录已过期') {
                if ($('v5StoreGrid')) $('v5StoreGrid').innerHTML = `<div class="v5-empty"><i class="fas fa-triangle-exclamation"></i>${escapeHtml(error.message)}</div>`;
                notify(error.message, 'error');
            }
        }
    }

    async function createInvite() {
        const button = $('v5CreateInvite');
        if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中'; }
        try {
            const invite = await api('/clinics/invites', { method: 'POST' });
            $('v5InviteCode').style.display = '';
            $('v5InviteCode').textContent = invite.code || '-';
            $('v5InviteExpiry').textContent = `有效期至：${formatDate(invite.expiresAt)}。本邀请码只能使用一次。`;
            $('v5CopyInvite').style.display = '';
            $('v5InviteBox').dataset.code = invite.code || '';
            notify('邀请码已生成，有效期 24 小时');
        } catch (error) {
            if (error.message !== '登录已过期') notify(error.message, 'error');
        } finally {
            if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-key"></i> 生成邀请码'; }
        }
    }

    async function loadBackups() {
        try {
            const payload = await api('/system/backups');
            const backups = Array.isArray(payload.backups) ? payload.backups : [];
            const list = $('v5BackupList');
            if (!list) return;
            if (!backups.length) {
                list.innerHTML = '<div class="v5-empty"><i class="fas fa-database"></i>暂无备份，建议先创建一次手工备份</div>';
                return;
            }
            list.innerHTML = backups.map(item => `<div class="v5-backup-row">
                <div class="v5-backup-file"><b title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</b><small>${escapeHtml(formatSize(item.size))} · ${escapeHtml(formatDate(item.createdAt))}</small></div>
                <button class="v5-btn danger small" data-restore-file="${escapeHtml(item.filename)}"><i class="fas fa-clock-rotate-left"></i> 恢复</button>
            </div>`).join('');
        } catch (error) {
            if (error.message !== '登录已过期') {
                if ($('v5BackupList')) $('v5BackupList').innerHTML = `<div class="v5-empty"><i class="fas fa-triangle-exclamation"></i>${escapeHtml(error.message)}</div>`;
                notify(error.message, 'error');
            }
        }
    }

    async function createBackup() {
        const button = $('v5CreateBackup');
        if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 备份中'; }
        try {
            await api('/system/backup', { method: 'POST' });
            notify('数据库备份已创建');
            await loadBackups();
        } catch (error) {
            if (error.message !== '登录已过期') notify(error.message, 'error');
        } finally {
            if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> 立即备份'; }
        }
    }

    function openRestore(filename) {
        currentRestoreFile = filename || '';
        $('v5RestoreFile').textContent = currentRestoreFile || '-';
        $('v5RestoreInput').value = '';
        $('v5RestoreError').textContent = '';
        $('modalV5Restore').classList.add('show');
        document.body.style.overflow = 'hidden';
        setTimeout(() => $('v5RestoreInput').focus(), 50);
    }

    async function submitRestore() {
        const confirmation = ($('v5RestoreInput').value || '').trim();
        if (confirmation !== 'RESTORE') {
            $('v5RestoreError').textContent = '请输入完整的大写 RESTORE 进行确认';
            return;
        }
        const button = $('v5SubmitRestore');
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 恢复中';
        try {
            await api('/system/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentRestoreFile, confirmation })
            });
            localStorage.removeItem('clinic_user');
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(PROFILE_KEY);
            alert('数据恢复成功，即将返回登录页重新登录。');
            window.location.href = 'login.html';
        } catch (error) {
            if (error.message !== '登录已过期') $('v5RestoreError').textContent = error.message;
        } finally {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-clock-rotate-left"></i> 确认恢复';
        }
    }

    function onPageChange(pageId, options = {}) {
        if (pageId === 'page-billing') {
            if (options.billingFilter) billingFilter = options.billingFilter;
            loadBilling();
        }
        if (pageId === 'page-clinics' && profile.canManageStores) loadClinics();
    }

    function bindEvents() {
        document.addEventListener('click', event => {
            const billingFilterButton = event.target.closest('[data-billing-filter]');
            if (billingFilterButton) {
                billingFilter = billingFilterButton.dataset.billingFilter || 'all';
                renderBilling();
                return;
            }
            const action = event.target.closest('[data-billing-action]');
            if (action) {
                const id = action.dataset.id;
                if (action.dataset.billingAction === 'pay') openPayment(id);
                if (action.dataset.billingAction === 'print') printBill(id, action.dataset.format || 'a4');
                return;
            }
            const close = event.target.closest('[data-v5-close]');
            if (close) { closeModal(close.dataset.v5Close); return; }
            if (event.target.classList.contains('v5-modal')) { closeModal(event.target.id); return; }
            const restore = event.target.closest('[data-restore-file]');
            if (restore) { openRestore(restore.dataset.restoreFile); return; }
            if (event.target.closest('#v5RefreshBilling')) loadBilling();
            if (event.target.closest('#v5BillingSearch')) { billingKeyword = $('v5BillingKeyword').value || ''; renderBilling(); }
            if (event.target.closest('#v5BillingClear')) { billingKeyword = ''; $('v5BillingKeyword').value = ''; renderBilling(); }
            if (event.target.closest('#v5RefreshClinics')) loadClinics();
            if (event.target.closest('#v5CreateInvite')) createInvite();
            if (event.target.closest('#v5RefreshBackups')) loadBackups();
            if (event.target.closest('#v5CreateBackup')) createBackup();
            if (event.target.closest('#v5CopyInvite')) {
                const code = $('v5InviteCode').textContent;
                navigator.clipboard.writeText(code).then(() => notify('邀请码已复制')).catch(() => notify('复制失败，请手动选择邀请码', 'error'));
            }
        });

        const keyword = $('v5BillingKeyword');
        if (keyword) keyword.addEventListener('input', () => { billingKeyword = keyword.value || ''; renderBilling(); });
        const received = $('v5ReceivedAmount');
        if (received) received.addEventListener('input', updateChangeAmount);
        const payMethod = $('v5PayMethod');
        if (payMethod) payMethod.addEventListener('change', updateChangeAmount);
        const paymentButton = $('v5SubmitPayment');
        if (paymentButton) paymentButton.addEventListener('click', submitPayment);
        const restoreButton = $('v5SubmitRestore');
        if (restoreButton) restoreButton.addEventListener('click', submitRestore);
        const restoreInput = $('v5RestoreInput');
        if (restoreInput) restoreInput.addEventListener('keydown', event => { if (event.key === 'Enter') submitRestore(); });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if ($('modalV5Payment').classList.contains('show')) closeModal('modalV5Payment');
            if ($('modalV5Restore').classList.contains('show')) closeModal('modalV5Restore');
        });
    }

    async function init() {
        ensureShell();
        syncNavigation();
        renderAccountContext();
        bindEvents();
        try { await refreshProfile(); } catch (_) { return; }
        syncNavigation();
        await loadBilling();
        loadBackups();
        if (profile.canManageStores) loadClinics();
    }

    window.YKV5 = {
        onPageChange,
        refreshProfile,
        loadBilling,
        loadClinics,
        loadBackups,
        openPayment
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
