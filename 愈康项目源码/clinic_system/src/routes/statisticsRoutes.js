const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const statisticsService = require('../services/statisticsService');

module.exports = function registerStatisticsRoutes(app) {
    app.get('/api/statistics/enhanced', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.enhanced(req.currentUser, req.query));
    }));
    app.get('/api/dashboard/stats', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.dashboard(req.currentUser, req.query));
    }));
    app.get('/api/statistics/revenue', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.revenueStats(req.currentUser, req.query));
    }));
    app.get('/api/statistics/trend', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.trend(req.currentUser, req.query));
    }));
    app.get('/api/statistics/operations', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.operations(req.currentUser, req.query));
    }));
    app.get('/api/statistics/inventory-overview', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await statisticsService.inventoryOverview(req.currentUser));
    }));
};
