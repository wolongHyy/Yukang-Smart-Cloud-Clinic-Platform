const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const collectionService = require('../services/collectionService');

module.exports = function registerCollectionRoutes(app) {
    app.get('/api/:collection', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await collectionService.listCollection(req.currentUser, req.params.collection));
    }));

    app.post('/api/:collection', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await collectionService.createItem(req.currentUser, req.params.collection, req.body);
        res.status(result.status || 200).json(result.data);
    }));

    app.put('/api/:collection/:id', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await collectionService.updateItem(req.currentUser, req.params.collection, req.params.id, req.body);
        res.json(result.data);
    }));

    app.delete('/api/:collection/:id', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await collectionService.deleteItem(req.currentUser, req.params.collection, req.params.id);
        res.json(result.data);
    }));
};
