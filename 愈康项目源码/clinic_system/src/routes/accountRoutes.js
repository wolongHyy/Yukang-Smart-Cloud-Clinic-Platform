const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const accountService = require('../services/accountService');

module.exports = function registerAccountRoutes(app) {
    app.get('/api/account/me', authService.authMiddleware, (req, res) => {
        res.json(accountService.publicProfile(req.currentSession));
    });

    app.get('/api/clinics/overview', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await accountService.overview(req.currentSession));
    }));

    app.post('/api/clinics/invites', authService.authMiddleware, (req, res, next) => {
        try {
            res.status(201).json(accountService.createInvite(req.currentSession));
        } catch (err) {
            next(err);
        }
    });
};