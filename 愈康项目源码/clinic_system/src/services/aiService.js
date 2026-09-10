const ai = require('../../ai');
const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { logError } = require('../utils/logger');
const { newId } = require('../utils/helpers');

function asBadRequest(action, err) {
    return new HttpError(400, err.message, `AI_${action}_FAILED`);
}

async function readSettingsData(username) {
    const settings = await repo.readCollection(username, 'settings');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const userEntries = await repo.readCollection(username, 'drugKnowledge');
    return { settings, inventory, userEntries };
}

async function testConnection(username) {
    try {
        const settings = await repo.readCollection(username, 'settings');
        return await ai.testConnection(settings);
    } catch (err) {
        throw asBadRequest('TEST', err);
    }
}

async function appendAiLog(username, type, log) {
    try {
        const logs = await repo.readCollection(username, 'aiLogs');
        logs.push({ id: newId(), type, createdAt: new Date().toISOString(), ...log });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
        await repo.writeCollection(username, 'aiLogs', logs);
    } catch (err) {
        logError('AI 日志写入失败:', err);
    }
}

async function generatePrescription(username, body) {
    try {
        const { settings, inventory, userEntries } = await readSettingsData(username);
        const patient = (body && body.patient) || {};
        const prescriptions = Array.isArray(body && body.prescriptions) ? body.prescriptions : [];
        const result = await ai.generatePrescription(settings, { patient, prescriptions, inventory, userEntries });
        await appendAiLog(username, 'generate', {
            patientId: patient.id || null,
            model: result.model,
            items: result.suggestions.map(s => s.name),
            rationale: result.rationale
        });
        return result;
    } catch (err) {
        if (err instanceof HttpError) throw err;
        logError('AI 开方失败:', err);
        throw asBadRequest('GENERATE_PRESCRIPTION', err);
    }
}

async function reviewPrescription(username, body) {
    try {
        const { settings, userEntries } = await readSettingsData(username);
        const patient = (body && body.patient) || {};
        const prescriptions = Array.isArray(body && body.prescriptions) ? body.prescriptions : [];
        const result = await ai.reviewPrescription(settings, { patient, prescriptions, userEntries });
        await appendAiLog(username, 'review', {
            patientId: patient.id || null,
            items: prescriptions.map(d => d.name),
            risks: result.risks.map(r => r.issue).slice(0, 10)
        });
        return result;
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err.message, 'AI_REVIEW_PRESCRIPTION_FAILED');
    }
}

async function runAssistAgent(username, body) {
    try {
        const { settings, inventory, userEntries } = await readSettingsData(username);
        const patient = (body && body.patient) || {};
        const prescriptions = Array.isArray(body && body.prescriptions) ? body.prescriptions : [];
        const result = await ai.runAssistAgent(settings, { patient, prescriptions, inventory, userEntries });
        await appendAiLog(username, 'assist-agent', {
            patientId: patient.id || null,
            model: result.model,
            checks: (result.plan && result.plan.checks) ? result.plan.checks.map(c => c.tool) : [],
            suggestionCount: result.suggestion ? result.suggestion.suggestions.length : 0,
            riskCount: result.verification ? result.verification.risks.length : 0,
            blocked: result.verification ? result.verification.blocked : false
        });
        return result;
    } catch (err) {
        if (err instanceof HttpError) throw err;
        logError('AI 辅助诊疗 Agent 失败:', err);
        throw asBadRequest('ASSIST_AGENT', err);
    }
}

module.exports = {
    testConnection,
    generatePrescription,
    reviewPrescription,
    runAssistAgent
};
