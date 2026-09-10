const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const aiService = require('../services/aiService');

module.exports = function registerAiRoutes(app) {
    app.post('/api/ai/test', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await aiService.testConnection(req.currentUser));
    }));
    app.post('/api/ai/generate-prescription', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await aiService.generatePrescription(req.currentUser, req.body));
    }));
    app.post('/api/ai/review-prescription', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await aiService.reviewPrescription(req.currentUser, req.body));
    }));
    app.post('/api/ai/assist-agent', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await aiService.runAssistAgent(req.currentUser, req.body));
    }));
};
