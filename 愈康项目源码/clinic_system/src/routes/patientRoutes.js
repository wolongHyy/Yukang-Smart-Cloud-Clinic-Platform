const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const patientService = require('../services/patientService');

module.exports = function registerPatientRoutes(app) {
    app.post('/api/patients/migrate', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await patientService.migrate(req.currentUser));
    }));
};
