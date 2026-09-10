const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const inventoryService = require('../services/inventoryService');

module.exports = function registerInventoryRoutes(app) {
    app.post('/api/inventory/check', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await inventoryService.checkInventory(req.currentUser, req.currentUser, req.body));
    }));
    app.post('/api/drug-inventory/stock-in', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await inventoryService.stockIn(req.currentUser, req.currentUser, req.body);
        res.status(result.status || 200).json(result.data);
    }));
    app.post('/api/drug-inventory/batch-import', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await inventoryService.batchImport(req.currentUser, req.currentUser, req.body));
    }));
    app.delete('/api/drug-inventory', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await inventoryService.deleteDrugs(req.currentUser, req.body));
    }));
};
