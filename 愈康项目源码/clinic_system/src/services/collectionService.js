const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { isPlainObject, newId } = require('../utils/helpers');

function listCollection(username, collection) {
    if (!repo.COLLECTIONS[collection]) throw new HttpError(404, '集合不存在', 'COLLECTION_NOT_FOUND');
    return repo.readCollection(username, collection);
}

async function createItemUnsafe(username, collection, body) {
    const meta = repo.COLLECTIONS[collection];
    if (!meta || meta.type !== 'array') throw new HttpError(400, '不支持', 'UNSUPPORTED_OPERATION');
    if (!isPlainObject(body)) throw new HttpError(400, '请求数据格式错误', 'VALIDATION_ERROR');
    const data = await repo.readCollection(username, collection);
    const newItem = { ...body, id: body.id || newId() };
    data.push(newItem);
    await repo.writeCollection(username, collection, data);
    return { status: 201, data: { success: true, data: newItem } };
}

async function updateItemUnsafe(username, collection, id, body) {
    const meta = repo.COLLECTIONS[collection];
    if (!meta) throw new HttpError(404, '集合不存在', 'COLLECTION_NOT_FOUND');
    if (!isPlainObject(body)) throw new HttpError(400, '请求数据格式错误', 'VALIDATION_ERROR');
    const data = await repo.readCollection(username, collection);
    if (meta.type === 'array') {
        const idx = data.findIndex(item => String(item.id) === String(id));
        if (idx === -1) throw new HttpError(404, '条目不存在', 'ITEM_NOT_FOUND');
        data[idx] = { ...data[idx], ...body, id: data[idx].id };
        await repo.writeCollection(username, collection, data);
        return { data: { success: true, data: data[idx] } };
    }
    const updated = { ...data, ...body };
    await repo.writeCollection(username, collection, updated);
    return { data: { success: true, data: updated } };
}

async function deleteItemUnsafe(username, collection, id) {
    const meta = repo.COLLECTIONS[collection];
    if (!meta || meta.type !== 'array') throw new HttpError(400, '不支持', 'UNSUPPORTED_OPERATION');
    const data = await repo.readCollection(username, collection);
    const filtered = data.filter(item => String(item.id) !== String(id));
    await repo.writeCollection(username, collection, filtered);
    return { data: { success: true } };
}

async function updateRecordTermsUnsafe(username, body) {
    if (!isPlainObject(body)) throw new HttpError(400, '请求数据格式错误', 'VALIDATION_ERROR');
    const data = await repo.readCollection(username, 'recordTerms');
    const updated = { ...data, ...body };
    await repo.writeCollection(username, 'recordTerms', updated);
    return { data: { success: true, data: updated } };
}

async function createItem(username, collection, body) {
    return repo.transaction(() => createItemUnsafe(username, collection, body));
}

async function updateItem(username, collection, id, body) {
    return repo.transaction(() => updateItemUnsafe(username, collection, id, body));
}

async function deleteItem(username, collection, id) {
    return repo.transaction(() => deleteItemUnsafe(username, collection, id));
}

async function updateRecordTerms(username, body) {
    return repo.transaction(() => updateRecordTermsUnsafe(username, body));
}

module.exports = {
    listCollection,
    createItem,
    updateItem,
    deleteItem,
    updateRecordTerms
};
