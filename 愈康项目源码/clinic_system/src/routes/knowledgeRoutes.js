const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const knowledgeService = require('../services/knowledgeService');

module.exports = function registerKnowledgeRoutes(app) {
    app.get('/api/pharmacopoeia/lookup', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await knowledgeService.lookupDrug(req.currentUser, req.query));
    }));
    app.get('/api/pharmacopoeia/search', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await knowledgeService.search(req.currentUser, req.query));
    }));
    app.get('/api/pharmacopoeia/herbs', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await knowledgeService.herbs(req.currentUser));
    }));
    app.get('/api/pharmacopoeia/stats', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(knowledgeService.stats());
    }));
    app.get('/api/formulas/library', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await knowledgeService.formulaLibrary(req.currentUser));
    }));
};
