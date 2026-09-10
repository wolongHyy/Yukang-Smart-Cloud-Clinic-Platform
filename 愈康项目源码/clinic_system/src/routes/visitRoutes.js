const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const visitService = require('../services/visitService');

module.exports = function registerVisitRoutes(app) {
    app.post('/api/visits/complete', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await visitService.completeVisit(req.currentUser, req.body);
        res.json({ success: true, ...result });
    }));
};
