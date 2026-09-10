const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const systemService = require('../services/systemService');

module.exports = function registerSystemRoutes(app) {
    app.get('/api/system/health', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await systemService.health());
    }));

    app.post('/api/system/backup', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.status(201).json(await systemService.createBackup());
    }));

    app.get('/api/system/backups', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json({ backups: await systemService.listBackups() });
    }));

    app.get('/api/system/export/json', authService.authMiddleware, asyncRoute(async (req, res) => {
        const archive = await systemService.exportJson(req.currentUser);
        res.setHeader('Content-Disposition', `attachment; filename="yukang-${Date.now()}.json"`);
        res.json(archive);
    }));

    app.get('/api/system/export/csv/:collection', authService.authMiddleware, asyncRoute(async (req, res) => {
        const csv = await systemService.exportCsv(req.currentUser, req.params.collection);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.collection}.csv"`);
        res.send(csv);
    }));

    app.get('/api/system/export/html', authService.authMiddleware, asyncRoute(async (req, res) => {
        const html = await systemService.exportHtml(req.currentUser);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="yukang-${Date.now()}.html"`);
        res.send(html);
    }));

    app.post('/api/system/import/json', authService.authMiddleware, asyncRoute(async (req, res) => {
        if (!req.body || req.body.confirmation !== 'IMPORT') {
            return res.status(400).json({ error: '导入操作需要 confirmation=IMPORT', code: 'IMPORT_CONFIRMATION_REQUIRED' });
        }
        res.json(await systemService.importJson(req.currentUser, req.body.archive));
    }));

    app.post('/api/system/restore', authService.authMiddleware, asyncRoute(async (req, res) => {
        if (!req.body || req.body.confirmation !== 'RESTORE') {
            return res.status(400).json({ error: '恢复操作需要 confirmation=RESTORE', code: 'RESTORE_CONFIRMATION_REQUIRED' });
        }
        res.json(await systemService.restoreBackup(req.body.filename));
    }));

    app.get('/api/system/logs', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await systemService.exportLogs(Number(req.query.limit) || 200000);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="server.log"');
        res.send(result.content);
    }));
    app.get('/api/system/rag', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await systemService.ragStatus());
    }));

    app.get('/api/system/audit', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await systemService.audit(req.currentUser, Number(req.query.limit) || 200));
    }));
};
