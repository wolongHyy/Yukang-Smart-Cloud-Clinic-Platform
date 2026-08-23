# -*- coding: utf-8 -*-
"""
愈康云诊所 v3.2 知识库构建脚本
================================
用途：把 D 盘下载的本草典开放数据（v1，CC BY-SA 4.0）与手工整理的西药/中成药
条目，转换成项目运行使用的标准 JSON 知识库：
  - data/pharmacopoeia.json  单药条目（中药饮片 + 西药 + 中成药）
  - data/formulas.json       方剂条目
  - data/interactions.json   本草-西药相互作用
  - data/kb_support.json     病症/证型/症状同义词（用于检索与 AI 上下文）

原始数据目录：D:\\愈康v3.2药典原始数据\\v1（可修改 RAW_DIR 环境变量）
运行：python tools/build_knowledge.py
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # clinic_system/
DATA_DIR = os.path.join(BASE, 'data')
RAW_DIR = os.environ.get('RAW_DIR', r'D:\愈康v3.2药典原始数据\v1')
SOURCE_REF = '本草典 v1（CC BY-SA 4.0，本草典编辑部）'
UPDATED_AT = '2026-04-17'

NATURE_ZH = {'cold': '寒', 'cool': '凉', 'neutral': '平', 'warm': '温', 'hot': '热'}
FLAVOR_ZH = {
    'sweet': '甘', 'bitter': '苦', 'sour': '酸', 'pungent': '辛', 'salty': '咸',
    'bland': '淡', 'astringent': '涩'
}
ROLE_ZH = {'jun': '君', 'chen': '臣', 'zuo': '佐', 'shi': '使'}
TEXT_SOURCE_ZH = {
    'shang_han_lun': '伤寒论',
    'jin_gui_yao_lue': '金匮要略',
    'tai_ping_hui_min_he_ji_ju_fang': '太平惠民和剂局方',
    'shen_nong_ben_cao_jing': '神农本草经',
    'huang_di_nei_jing': '黄帝内经',
    'wen_bing_tiao_bian': '温病条辨',
    'yi_xue_qi_meng': '医学启源',
    'xiao_er_yao_zheng_zhi_jue': '小儿药证直诀',
    'jing_yue_quan_shu': '景岳全书',
    'pi_wei_lun': '脾胃论'
}
SEVERITY_ZH = {'major': '严重', 'moderate': '中等', 'theoretical': '理论风险'}


def load(name):
    p = os.path.join(RAW_DIR, name)
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def build_pharmacopoeia(herbs, western):
    entries = []
    for h in herbs:
        actions = '；'.join(x.get('zh', '') for x in h.get('actions', []) if x.get('zh'))
        indications = '；'.join(x.get('zh', '') for x in h.get('indications', []) if x.get('zh'))
        dr = h.get('dosage_range') or {}
        usage_parts = []
        if dr.get('min') is not None and dr.get('max') is not None:
            usage_parts.append(f"常用量 {dr['min']}–{dr['max']}{dr.get('unit', 'g')}")
        if dr.get('notes'):
            usage_parts.append(dr['notes'])
        proc = h.get('processing_methods', [])
        proc_notes = '；'.join(f"{p.get('name','')}：{p.get('effect','')}" for p in proc if p.get('name')) if proc else ''
        safety = h.get('safety_notes_zh') or ''
        desc = h.get('description_zh') or ''
        notes_parts = [x for x in [desc, proc_notes] if x]
        pregnancy = h.get('pregnancy') or {}
        lactation = h.get('lactation') or {}
        pediatric = h.get('pediatric') or {}
        special = []
        if pregnancy.get('note_zh'):
            special.append('孕妇：' + pregnancy['note_zh'])
        if lactation.get('note_zh'):
            special.append('哺乳期：' + lactation['note_zh'])
        if pediatric.get('note_zh'):
            special.append('儿童：' + pediatric['note_zh'])
        if special:
            notes_parts.append('；'.join(special))
        entry = {
            'name': h.get('name_zh', ''),
            'aliases': [],
            'category': '中药饮片',
            'nature': NATURE_ZH.get(h.get('nature', ''), h.get('nature', '')),
            'flavors': [FLAVOR_ZH.get(x, x) for x in h.get('flavors', [])],
            'functions': actions,
            'indications': indications,
            'usage': '；'.join(usage_parts),
            'contraindications': h.get('contraindications_zh') or '',
            'adverseReactions': safety,
            'notes': '；'.join(notes_parts),
            'interactions': '',
            'storage': '',
            'source': SOURCE_REF,
            'updatedAt': (h.get('verification') or {}).get('last_reviewed', UPDATED_AT)
        }
        entries.append(entry)

    for w in western:
        entries.append({
            'name': w.get('name', ''),
            'aliases': w.get('aliases', []),
            'category': w.get('category', '西药'),
            'nature': '',
            'flavors': [],
            'functions': w.get('functions', ''),
            'indications': '',
            'usage': w.get('usage', ''),
            'contraindications': w.get('contraindications', ''),
            'adverseReactions': w.get('adverseReactions', ''),
            'notes': w.get('notes', ''),
            'interactions': w.get('interactions', ''),
            'storage': w.get('storage', ''),
            'source': w.get('source', '公开药品说明书整理（v3.2 初始库）'),
            'updatedAt': w.get('updatedAt', UPDATED_AT)
        })
    return entries


def build_formulas(formulas, herb_name_map):
    out = []
    for f in formulas:
        composition = []
        for c in f.get('composition', []):
            herb = herb_name_map.get(c.get('herb_key'), c.get('herb_key', ''))
            composition.append({
                'name': herb,
                'amount': c.get('dosage', ''),
                'role': ROLE_ZH.get(c.get('role', ''), c.get('role', '')),
                'note': c.get('explanation_zh', '')
            })
        mods = []
        for m in f.get('modifications', []):
            add = '、'.join(m.get('add', [])) or '酌加'
            mods.append(f"若{m.get('condition','')}：{m.get('rationale','')}，加{add}")
        out.append({
            'name': f.get('name_zh', ''),
            'source': TEXT_SOURCE_ZH.get(f.get('source_text_key', ''), f.get('source_text_key', '') or '') + ('（' + f.get('source_chapter', '') + '）' if f.get('source_chapter') else ''),
            'category': (f.get('category', '') + (('-' + f.get('subcategory', '')) if f.get('subcategory') else '')),
            'composition': composition,
            'functions': (f.get('treatment_principle') or {}).get('zh', ''),
            'indications': f.get('description_zh', ''),
            'usage': f.get('preparation_zh', ''),
            'modifications': mods,
            'notes': '',
            'sourceRef': SOURCE_REF,
            'updatedAt': (f.get('verification') or {}).get('last_reviewed', UPDATED_AT)
        })
    return out


def build_interactions(interactions, herb_name_map):
    out = []
    for it in interactions:
        out.append({
            'herbs': [herb_name_map.get(k, k) for k in it.get('herb_keys', [])],
            'drugClassZh': it.get('drug_class_zh', ''),
            'drugExamples': it.get('drug_examples', []),
            'severity': SEVERITY_ZH.get(it.get('severity', ''), it.get('severity', '')),
            'mechanismZh': it.get('mechanism_zh', ''),
            'recommendationZh': it.get('clinical_recommendation_zh', ''),
            'source': SOURCE_REF,
            'updatedAt': UPDATED_AT
        })
    return out


def build_support(conditions, patterns, synonyms):
    conds = [{
        'name': c.get('name_zh', ''),
        'aliases': c.get('aliases_zh', []),
        'description': c.get('description_zh', ''),
        'relatedHerbs': [],
        'relatedFormulas': [],
        'guide': c.get('differentiation_guide_zh', '')
    } for c in conditions]
    pats = [{
        'name': p.get('name_zh', ''),
        'cardinalSymptoms': [s.get('zh', '') for s in p.get('cardinal_symptoms', []) if s.get('zh')],
        'secondarySymptoms': [s.get('zh', '') for s in p.get('secondary_symptoms', []) if s.get('zh')],
        'tongue': (p.get('tongue') or {}).get('zh', ''),
        'pulse': (p.get('pulse') or {}).get('zh', ''),
        'treatmentPrinciple': (p.get('treatment_principle') or {}).get('zh', ''),
        'description': p.get('description_zh', '')
    } for p in patterns]
    syns = [{
        'canonical': s.get('canonical_zh', ''),
        'synonyms': s.get('synonyms_zh', [])
    } for s in synonyms]
    return {'conditions': conds, 'patterns': pats, 'symptomSynonyms': syns}


def main():
    herbs = load('herbs.json')
    formulas = load('formulas.json')
    interactions = load('interactions.json')['herb_drug_interactions']
    conditions = load('conditions.json')
    patterns = load('patterns.json')
    synonyms = load('symptom_synonyms.json')

    with open(os.path.join(DATA_DIR, 'western_drugs.json'), encoding='utf-8') as f:
        western = json.load(f)

    herb_name_map = {h.get('key'): h.get('name_zh', '') for h in herbs}

    os.makedirs(DATA_DIR, exist_ok=True)

    pharma = build_pharmacopoeia(herbs, western)
    with open(os.path.join(DATA_DIR, 'pharmacopoeia.json'), 'w', encoding='utf-8') as f:
        json.dump(pharma, f, ensure_ascii=False, indent=1)
    print('pharmacopoeia.json:', len(pharma), 'entries')

    fm = build_formulas(formulas, herb_name_map)
    with open(os.path.join(DATA_DIR, 'formulas.json'), 'w', encoding='utf-8') as f:
        json.dump(fm, f, ensure_ascii=False, indent=1)
    print('formulas.json:', len(fm), 'entries')

    inter = build_interactions(interactions, herb_name_map)
    with open(os.path.join(DATA_DIR, 'interactions.json'), 'w', encoding='utf-8') as f:
        json.dump(inter, f, ensure_ascii=False, indent=1)
    print('interactions.json:', len(inter), 'entries')

    support = build_support(conditions, patterns, synonyms)
    with open(os.path.join(DATA_DIR, 'kb_support.json'), 'w', encoding='utf-8') as f:
        json.dump(support, f, ensure_ascii=False, indent=1)
    print('kb_support.json:',
          len(support['conditions']), 'conditions,',
          len(support['patterns']), 'patterns,',
          len(support['symptomSynonyms']), 'synonym groups')


if __name__ == '__main__':
    main()
