const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const clinicalService = require('../services/clinicalService');
const collectionService = require('../services/collectionService');

module.exports = function registerClinicalRoutes(app) {
    app.get('/api/clinical-terms', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await clinicalService.getClinicalTerms());
    }));

    app.post('/api/clinical/suggestions', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(clinicalService.suggestConditions(req.body || {}));
    }));

    app.put('/api/recordTerms', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await collectionService.updateRecordTerms(req.currentUser, req.body);
        res.json(result.data);
    }));
};
