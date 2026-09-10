const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const billingService = require('../services/billingService');

module.exports = function registerBillingRoutes(app) {
    app.get('/api/billing', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json({
            methods: billingService.PAY_METHODS,
            bills: await billingService.listBills(req.currentUser, req.query),
        });
    }));

    app.post('/api/billing/:id/pay', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await billingService.payBill(req.currentUser, req.currentUser, req.params.id, req.body));
    }));

    app.post('/api/billing/:id/print', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await billingService.markPrinted(req.currentUser, req.params.id));
    }));
};