const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const pharmacyService = require('../services/pharmacyService');

module.exports = function registerPharmacyRoutes(app) {
    app.post('/api/pharmacy/dispense/:id', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await pharmacyService.dispenseOne(req.currentUser, req.currentUser, req.params.id));
    }));
    app.post('/api/pharmacy/dispense-all', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await pharmacyService.dispenseAll(req.currentUser, req.currentUser));
    }));
};
