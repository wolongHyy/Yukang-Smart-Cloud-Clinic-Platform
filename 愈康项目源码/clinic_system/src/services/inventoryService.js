const fs = require('fs');
const path = require('path');
const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId, toNum, todayKey } = require('../utils/helpers');

// 官方药品类型。中药饮片是法定名称，不能写成“中药饮品”；
// 中药配方颗粒也有明确监管定义，不能把所有名称带“颗粒”的产品都归入此类。
const DRUG_CATEGORIES = ['中药饮片', '中成药', '西药', '中药配方颗粒', '自制成品', '保健食品'];
const NON_DRUG_CATEGORIES = ['医疗器械', '医用耗材', '其他商品'];
const INVENTORY_CATEGORIES = [...DRUG_CATEGORIES, ...NON_DRUG_CATEGORIES];
const UNCLASSIFIED_CATEGORY = '未归类';
const ALL_INVENTORY_CATEGORIES = [...INVENTORY_CATEGORIES, UNCLASSIFIED_CATEGORY];

const LEGACY_CATEGORY_MAP = {
    '中药饮品': '中药饮片',
    '保健品': '保健食品',
    '中药颗粒': '中药配方颗粒',
    '未分类': UNCLASSIFIED_CATEGORY,
    '': '',
};

const FORMULA_GRANULE_SOURCE = '黑龙江省药品监督管理局《什么是中药配方颗粒？》';
const HEALTH_FOOD_SOURCE = '国家市场监督管理总局特殊食品信息查询平台';
const PHARMACOPOEIA_SOURCE = '中国药典2025年版及系统内置药品知识库';
const PHARMACOPOEIA_PATH = path.join(__dirname, '..', '..', 'data', 'pharmacopoeia.json');

let pharmacopoeiaIndex;

function normalizeInventoryCategory(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return LEGACY_CATEGORY_MAP[raw] || raw;
}

function validateInventoryCategory(value, required) {
    const category = normalizeInventoryCategory(value);
    if (!category && required) {
        throw new HttpError(400, '请选择药品类型，新入库药品必须归类', 'VALIDATION_ERROR');
    }
    if (category && !INVENTORY_CATEGORIES.includes(category)) {
        throw new HttpError(400, `药品类型无效：${category}`, 'VALIDATION_ERROR');
    }
    return category;
}

function compactName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[（）()【】\[\]·•\-—_]/g, '');
}

function nameVariants(value) {
    const raw = String(value || '').trim();
    const variants = new Set();
    if (!raw) return [];

    const add = candidate => {
        const compact = compactName(candidate);
        if (compact) variants.add(compact);
    };

    add(raw);
    // 常见商业名写在末尾括号内，例如“三黄片(英雄)”。
    // 只去掉末尾括号，不做包含式模糊匹配，避免把“甘草片”当成“甘草”。
    const stripped = raw.replace(/[（(][^（）()]{1,30}[）)]\s*$/g, '').trim();
    add(stripped);
    return [...variants];
}

function loadPharmacopoeiaIndex() {
    if (pharmacopoeiaIndex) return pharmacopoeiaIndex;
    const index = new Map();
    try {
        const entries = JSON.parse(fs.readFileSync(PHARMACOPOEIA_PATH, 'utf8'));
        for (const entry of entries) {
            if (!entry || !DRUG_CATEGORIES.includes(entry.category)) continue;
            const names = [entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
            for (const name of names) {
                for (const key of nameVariants(name)) {
                    if (!index.has(key)) {
                        index.set(key, {
                            name: entry.name,
                            category: entry.category,
                            source: entry.source || PHARMACOPOEIA_SOURCE,
                        });
                    }
                }
            }
        }
    } catch (error) {
        // 知识库缺失时仍可使用批准文号等高置信证据，不能退回名称关键词猜测。
        if (process.env.NODE_ENV !== 'test') {
            console.warn(`药品分类知识库读取失败，将只使用批准文号等证据：${error.message}`);
        }
    }
    pharmacopoeiaIndex = index;
    return index;
}

function manualClassification(category, source) {
    const normalized = validateInventoryCategory(category, false);
    if (!normalized) return null;
    return {
        category: normalized,
        reason: `人工确认药品类型为“${normalized}”`,
        source: source || '入库时人工选择',
        confidence: 'manual',
    };
}

function unclassifiedClassification(reason) {
    return {
        category: UNCLASSIFIED_CATEGORY,
        reason: reason || '现有资料不足以可靠判断药品类型',
        source: '保守分类规则',
        confidence: 'none',
    };
}

function classifyInventoryDrug(item = {}) {
    const name = String(item.name || item.drugName || '').trim();
    const approvalNo = String(item.approvalNo || '').replace(/[\s\u3000_\-—–－·•.]/g, '').toUpperCase();
    const evidenceText = [
        name,
        item.spec,
        item.manufacturer,
        item.drugClassZh,
        item.dosageForm,
        item.form,
    ].map(value => String(value || '')).join(' ');

    // 只有明确出现法定名称“中药配方颗粒”才自动识别。
    // 单纯名称含“颗粒”不能作为配方颗粒依据；例如胃苏颗粒属于中成药。
    if (/中药配方颗粒/.test(name) || /中药配方颗粒/.test(evidenceText)) {
        return {
            category: '中药配方颗粒',
            reason: '名称或包装信息明确标注“中药配方颗粒”',
            source: FORMULA_GRANULE_SOURCE,
            confidence: 'high',
        };
    }

    // 仅使用高置信度的国药准字类别字母。J、HC、S、B 等存在生物制品、
    // 进口分装、历史保健药等不同背景，不能强行归入当前六类。
    if (/^(?:国药准字)?H\d/.test(approvalNo)) {
        return {
            category: '西药',
            reason: '国药准字 H 为化学药品批准文号类别',
            source: '国家药品批准文号编码规则',
            confidence: 'high',
        };
    }
    if (/^(?:国药准字)?Z\d/.test(approvalNo)) {
        return {
            category: '中成药',
            reason: '国药准字 Z 为中药批准文号类别',
            source: '国家药品批准文号编码规则',
            confidence: 'high',
        };
    }

    // 保健食品注册号或备案号是格式明确的官方标识；没有此类编号时不凭名称猜测。
    if (/^(?:国食健注|国食健字|食健备)[GJ]/i.test(approvalNo)) {
        return {
            category: '保健食品',
            reason: '批准文号符合保健食品注册号或备案号格式',
            source: HEALTH_FOOD_SOURCE,
            confidence: 'high',
        };
    }

    // 医疗机构制剂标识可作为“自制成品”的明确证据。
    if (/(药制字|医疗机构制剂|医院制剂|院内制剂)/.test(`${approvalNo} ${evidenceText}`)) {
        return {
            category: '自制成品',
            reason: '批准文号或产品信息明确标注为医疗机构制剂',
            source: '医疗机构制剂批准文号信息',
            confidence: 'high',
        };
    }

    // 药典和系统内置知识库采用“精确名称/别名”匹配，不做关键词包含匹配。
    const catalog = loadPharmacopoeiaIndex();
    for (const key of nameVariants(name)) {
        const entry = catalog.get(key);
        if (!entry) continue;
        return {
            category: entry.category,
            reason: `名称“${name}”与知识库条目“${entry.name}”精确匹配`,
            source: entry.source || PHARMACOPOEIA_SOURCE,
            confidence: 'high',
        };
    }

    return unclassifiedClassification(
        '未找到明确的批准文号、药典条目或制剂信息，系统不会按名称关键词猜测分类'
    );
}

function applyClassification(target, classification) {
    target.category = classification.category;
    target.categoryReason = classification.reason || '';
    target.categorySource = classification.source || '';
    target.categoryConfidence = classification.confidence || '';
    target.categoryUpdatedAt = new Date().toISOString();
}

function existingClassification(drug) {
    const category = normalizeInventoryCategory(drug && drug.category);
    if (!category || !INVENTORY_CATEGORIES.includes(category)) return null;
    return {
        category,
        reason: drug.categoryReason || `沿用已有库存类型“${category}”`,
        source: drug.categorySource || '已有库存记录',
        confidence: drug.categoryConfidence || 'existing',
    };
}

function resolveClassification(item, existing) {
    const manual = manualClassification(item && item.category, '入库或导入时人工选择');
    if (manual) return manual;
    const existingResult = existingClassification(existing);
    if (existingResult) return existingResult;
    return classifyInventoryDrug(item);
}

function migrateLegacyInventoryData(inventory = [], inRecords = []) {
    let inventoryUpdated = 0;
    let recordsUpdated = 0;
    let unclassifiedInventory = 0;
    let unclassifiedRecords = 0;
    const categoriesByName = new Map();

    for (const drug of inventory) {
        const oldCategory = String(drug.category || '').trim();
        const normalized = normalizeInventoryCategory(oldCategory);

        // 合法分类原样保留；旧别名按法定名称修正；空值和任意未知值必须
        // 重新走客观证据分类。证据不足时标记“未归类”，不再保留旧字符串。
        let category;
        let classification = null;
        if (INVENTORY_CATEGORIES.includes(normalized)) {
            category = normalized;
        } else {
            classification = classifyInventoryDrug(drug);
            category = classification.category;
        }

        if (category !== oldCategory) {
            drug.category = category;
            inventoryUpdated += 1;
        }
        if (classification) applyClassification(drug, classification);
        if (category === UNCLASSIFIED_CATEGORY) unclassifiedInventory += 1;

        const name = String(drug.name || '').trim().toLowerCase();
        if (name && INVENTORY_CATEGORIES.includes(category)) {
            if (!categoriesByName.has(name)) categoriesByName.set(name, new Set());
            categoriesByName.get(name).add(category);
        }
    }

    for (const record of inRecords) {
        const oldCategory = String(record.category || '').trim();
        const normalized = normalizeInventoryCategory(oldCategory);
        const matchingCategories = categoriesByName.get(String(record.drugName || '').trim().toLowerCase());
        const inventoryCategory = matchingCategories && matchingCategories.size === 1
            ? [...matchingCategories][0]
            : '';

        let category;
        let classification = null;
        if (inventoryCategory) {
            category = inventoryCategory;
        } else if (INVENTORY_CATEGORIES.includes(normalized)) {
            category = normalized;
        } else {
            classification = classifyInventoryDrug(record);
            category = classification.category;
        }

        if (category !== oldCategory) {
            record.category = category;
            recordsUpdated += 1;
        }
        if (classification) applyClassification(record, classification);
        if (category === UNCLASSIFIED_CATEGORY) unclassifiedRecords += 1;
    }

    return {
        inventoryUpdated,
        recordsUpdated,
        unclassifiedInventory,
        unclassifiedRecords,
    };
}

async function checkInventoryUnsafe(username, operator, body) {
    const items = Array.isArray(body && body.items) ? body.items : [];
    if (!items.length) throw new HttpError(400, '盘点数据不能为空', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const checks = await repo.readCollection(username, 'inventoryChecks');
    const details = [];
    let changed = 0;

    for (const it of items) {
        const actual = Number(it.actual);
        if (!Number.isFinite(actual) || actual < 0) continue;
        const drug = it.id
            ? inventory.find(d => String(d.id) === String(it.id))
            : inventory.find(d => d.name === it.name);
        if (!drug) continue;
        const oldStock = toNum(drug.stock || drug.quantity);
        if (oldStock !== actual) {
            drug.stock = actual;
            drug.updatedAt = new Date().toISOString();
            changed++;
        }
        details.push({ name: drug.name, oldStock, newStock: actual, diff: +(actual - oldStock).toFixed(2) });
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    checks.push({ id: newId(), date: new Date().toLocaleString(), operator, items: details });
    await repo.writeCollection(username, 'inventoryChecks', checks);
    return { success: true, changed, details };
}

async function stockInUnsafe(username, operator, body) {
    const {
        drugId, drugName, qty, batchNo, expiry, productionDate, supplier, cost,
        supplierId, unit, minStock, price, category, approvalNo, manufacturer, spec
    } = body || {};
    const normalizedDrugName = String(drugName || '').trim();
    const qtyNum = toNum(qty);
    if (!normalizedDrugName || qtyNum <= 0) {
        throw new HttpError(400, '药品名称和数量不能为空，且数量必须大于0', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const drug = drugId
        ? inventory.find(d => String(d.id) === String(drugId))
        : inventory.find(d => d.name === normalizedDrugName);

    const classification = resolveClassification({
        category,
        name: normalizedDrugName,
        approvalNo: approvalNo || (drug && drug.approvalNo) || '',
        manufacturer: manufacturer || (drug && drug.manufacturer) || '',
        spec: spec || (drug && drug.spec) || '',
    }, drug);

    if (classification.category === UNCLASSIFIED_CATEGORY) {
        throw new HttpError(
            400,
            `暂时无法可靠归类“${normalizedDrugName}”：${classification.reason}。请人工选择药品类型。`,
            'CATEGORY_REQUIRED'
        );
    }

    let finalSupplierId = supplierId;
    if (supplier && !finalSupplierId) {
        const suppliers = await repo.readCollection(username, 'suppliers');
        let sup = suppliers.find(s => s.name === supplier);
        if (!sup) {
            sup = { id: newId(), name: supplier, contact: '', phone: '', address: '' };
            suppliers.push(sup);
            await repo.writeCollection(username, 'suppliers', suppliers);
        }
        finalSupplierId = sup.id;
    }

    if (drug) {
        applyClassification(drug, classification);
        drug.stock = toNum(drug.stock) + qtyNum;
        if (batchNo) drug.batchNo = batchNo;
        if (expiry) drug.expiry = expiry;
        if (productionDate) drug.productionDate = productionDate;
        if (supplier) drug.supplier = supplier;
        if (finalSupplierId) drug.supplierId = finalSupplierId;
        if (cost !== undefined && cost !== '') drug.costPrice = toNum(cost);
        if (price !== undefined && price !== '') drug.price = toNum(price);
        if (unit) drug.unit = unit;
        if (minStock !== undefined && minStock !== '') drug.minStock = toNum(minStock, 10);
        if (approvalNo) drug.approvalNo = approvalNo;
        if (manufacturer) drug.manufacturer = manufacturer;
        if (spec) drug.spec = spec;
        drug.purchaseDate = todayKey();
        drug.updatedAt = new Date().toISOString();
    }

    if (!drug) {
        const newDrug = {
            id: newId(),
            name: normalizedDrugName,
            approvalNo: approvalNo || '',
            manufacturer: manufacturer || '',
            spec: spec || '',
            stock: qtyNum,
            unit: unit || '盒',
            minStock: minStock || 10,
            batchNo: batchNo || '',
            expiry: expiry || '',
            productionDate: productionDate || '',
            purchaseDate: todayKey(),
            supplier: supplier || '',
            supplierId: finalSupplierId || '',
            costPrice: toNum(cost),
            price: toNum(price),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        applyClassification(newDrug, classification);
        inventory.push(newDrug);
    }
    await repo.writeCollection(username, 'drugInventory', inventory);

    const inRecords = await repo.readCollection(username, 'drugInRecords');
    inRecords.push({
        id: newId(),
        drugName: normalizedDrugName,
        category: classification.category,
        categoryReason: classification.reason || '',
        categorySource: classification.source || '',
        categoryConfidence: classification.confidence || '',
        qty: qtyNum,
        batchNo: batchNo || '',
        expiry: expiry || '',
        productionDate: productionDate || '',
        supplier: supplier || '',
        supplierId: finalSupplierId || '',
        cost: toNum(cost),
        date: new Date().toLocaleString(),
        operator
    });
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return { status: 201, data: { success: true, category: classification.category } };
}

async function batchImportUnsafe(username, operator, body) {
    const items = (body && body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(400, '导入数据不能为空', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const suppliers = await repo.readCollection(username, 'suppliers');
    const inRecords = await repo.readCollection(username, 'drugInRecords');
    let added = 0;
    let updated = 0;
    let classified = 0;
    let skipped = 0;
    const failedItems = [];
    const seenNames = new Set();

    for (const item of items) {
        const name = String(item.name || '').trim();
        if (!name) {
            skipped += 1;
            failedItems.push({ name: '（空名称）', reason: '药品名称为空，已跳过' });
            continue;
        }
        const existing = inventory.find(d => d.name === name);
        const classification = resolveClassification(item, existing);

        if (classification.category === UNCLASSIFIED_CATEGORY) {
            failedItems.push({ name, reason: `无法可靠归类：${classification.reason}。请在 Excel 中填写明确的药品类型。` });
            continue;
        }
        if (classification.confidence !== 'manual' && classification.confidence !== 'existing') {
            classified += 1;
        }

        const key = name.toLowerCase();
        if (seenNames.has(key)) {
            skipped += 1;
            failedItems.push({ name, reason: '同一批次中药品名称重复，已跳过重复项' });
            continue;
        }
        seenNames.add(key);

        const supName = (item.supplier || '').trim();
        let finalSupplierId = '';
        if (supName) {
            let existingSup = suppliers.find(s => s.name === supName);
            if (!existingSup) {
                existingSup = {
                    id: newId(),
                    name: supName,
                    contact: '',
                    phone: '',
                    address: '',
                    createdAt: new Date().toISOString()
                };
                suppliers.push(existingSup);
            }
            finalSupplierId = existingSup.id;
        }

        if (existing) {
            applyClassification(existing, classification);
            if (item.stock !== undefined && item.stock !== '') existing.stock = toNum(existing.stock) + Math.max(0, toNum(item.stock));
            if (item.price !== undefined && item.price !== '') existing.price = toNum(item.price);
            if (item.costPrice !== undefined && item.costPrice !== '') existing.costPrice = toNum(item.costPrice);
            if (item.batchNo) existing.batchNo = item.batchNo;
            if (item.expiry) existing.expiry = item.expiry;
            if (supName) existing.supplier = supName;
            if (finalSupplierId) existing.supplierId = finalSupplierId;
            if (item.manufacturer) existing.manufacturer = item.manufacturer;
            if (item.spec) existing.spec = item.spec;
            if (item.unit) existing.unit = item.unit;
            if (item.code) existing.code = item.code;
            if (item.approvalNo) existing.approvalNo = item.approvalNo;
            if (item.productionDate) existing.productionDate = item.productionDate;
            if (Math.max(0, toNum(item.stock)) > 0) existing.purchaseDate = item.purchaseDate || todayKey();
            existing.updatedAt = new Date().toISOString();
            updated++;
        } else {
            const newDrug = {
                id: newId(),
                name,
                code: item.code || '',
                approvalNo: item.approvalNo || '',
                spec: item.spec || '',
                unit: item.unit || '盒',
                manufacturer: item.manufacturer || '',
                stock: Math.max(0, toNum(item.stock)),
                minStock: item.minStock || 10,
                price: toNum(item.price),
                costPrice: toNum(item.costPrice),
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                purchaseDate: item.purchaseDate || (Math.max(0, toNum(item.stock)) > 0 ? todayKey() : ''),
                supplier: supName || '',
                supplierId: finalSupplierId || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            applyClassification(newDrug, classification);
            inventory.push(newDrug);
            added++;
        }

        const inQty = Math.max(0, toNum(item.stock));
        if (inQty > 0) {
            inRecords.push({
                id: newId(),
                drugName: name,
                category: classification.category,
                categoryReason: classification.reason || '',
                categorySource: classification.source || '',
                categoryConfidence: classification.confidence || '',
                qty: inQty,
                unit: item.unit || '盒',
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                supplier: supName || '',
                cost: toNum(item.costPrice),
                date: new Date().toLocaleString(),
                operator,
                source: 'Excel导入'
            });
        }
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    await repo.writeCollection(username, 'suppliers', suppliers);
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return {
        success: true,
        added,
        updated,
        classified,
        skipped,
        failed: failedItems.length,
        failedItems,
        total: items.length,
    };
}

async function deleteDrugsUnsafe(username, body) {
    const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new HttpError(400, '请选择要删除的药品', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const kept = inventory.filter(item => !ids.includes(String(item.id)));
    await repo.writeCollection(username, 'drugInventory', kept);
    const removed = inventory.filter(item => ids.includes(String(item.id)));
    const removedNames = new Set(removed.map(item => String(item.name || '').trim()).filter(Boolean));
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const pendingKept = pharmacy.filter(item => !(item.status !== '已发药' && removedNames.has(String(item.drug || '').trim())));
    if (pendingKept.length !== pharmacy.length) await repo.writeCollection(username, 'pharmacy', pendingKept);
    return {
        success: true,
        deleted: inventory.length - kept.length,
        pendingRemoved: pharmacy.length - pendingKept.length
    };
}

async function migrateLegacyCategoriesForStore(clinicId) {
    return repo.runWithStore(clinicId, () => repo.transaction(async () => {
        const inventory = await repo.readCollection('__clinic__', 'drugInventory');
        const inRecords = await repo.readCollection('__clinic__', 'drugInRecords');
        const result = migrateLegacyInventoryData(inventory, inRecords);
        if (result.inventoryUpdated) await repo.writeCollection('__clinic__', 'drugInventory', inventory);
        if (result.recordsUpdated) await repo.writeCollection('__clinic__', 'drugInRecords', inRecords);
        return { clinicId, ...result };
    }));
}

async function migrateLegacyCategories() {
    const clinicIds = repo.listStoreIds();
    const stores = [];
    for (const clinicId of clinicIds) {
        stores.push(await migrateLegacyCategoriesForStore(clinicId));
    }
    return {
        stores,
        inventoryUpdated: stores.reduce((sum, item) => sum + item.inventoryUpdated, 0),
        recordsUpdated: stores.reduce((sum, item) => sum + item.recordsUpdated, 0),
        unclassifiedInventory: stores.reduce((sum, item) => sum + item.unclassifiedInventory, 0),
        unclassifiedRecords: stores.reduce((sum, item) => sum + item.unclassifiedRecords, 0),
    };
}

async function checkInventory(username, operator, body) {
    return repo.transaction(() => checkInventoryUnsafe(username, operator, body));
}

async function stockIn(username, operator, body) {
    return repo.transaction(() => stockInUnsafe(username, operator, body));
}

async function batchImport(username, operator, body) {
    return repo.transaction(() => batchImportUnsafe(username, operator, body));
}

async function deleteDrugs(username, body) {
    return repo.transaction(() => deleteDrugsUnsafe(username, body));
}

module.exports = {
    DRUG_CATEGORIES,
    NON_DRUG_CATEGORIES,
    INVENTORY_CATEGORIES,
    UNCLASSIFIED_CATEGORY,
    normalizeInventoryCategory,
    classifyInventoryDrug,
    migrateLegacyInventoryData,
    migrateLegacyCategoriesForStore,
    migrateLegacyCategories,
    checkInventory,
    stockIn,
    batchImport,
    deleteDrugs
};
