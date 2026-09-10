const fs = require('fs').promises;
const path = require('path');
const knowledge = require('../../knowledge');

const BASE_DIR = path.join(__dirname, '..', '..');

async function getClinicalTerms() {
    const file = path.join(BASE_DIR, 'data', 'clinical_terms.json');
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
}

function suggestConditions(body) {
    const cleanText = (value, max = 2000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const input = {
        chief: cleanText(body.chief || body.text),
        history: cleanText(body.history),
        past: cleanText(body.past),
        allergy: cleanText(body.allergy),
        exam: cleanText(body.exam),
        diagnosis: cleanText(body.diagnosis),
        syndrome: cleanText(body.syndrome),
        tcm: cleanText(body.tcm)
    };
    const candidates = knowledge.suggestConditions(input, 8).map(item => ({
        name: item.name,
        type: item.type,
        score: item.score,
        evidence: item.evidence,
        description: item.description,
        advice: item.advice
    }));
    return {
        candidates,
        hasSuggestions: candidates.length > 0,
        note: '由本地医疗知识库匹配生成，仅供医生参考，需医生确认。'
    };
}

module.exports = {
    getClinicalTerms,
    suggestConditions
};
