const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const { getLANIP } = require('../utils/helpers');

module.exports = function registerAuthRoutes(app, port) {
    app.post('/api/auth/register', asyncRoute(async (req, res) => {
        const result = await authService.register(req.body);
        res.status(result.status || 200).json(result.data);
    }));

    app.post('/api/auth/login', asyncRoute(async (req, res) => {
        const result = await authService.login(req.body);
        res.json(result.data);
    }));

    app.post('/api/auth/logout', asyncRoute(async (req, res) => {
        res.json(authService.logout(req.headers['x-auth-token']));
    }));

    app.get('/api/server-info', (req, res) => {
        try {
            const lanIp = getLANIP();
            res.json({ success: true, pcLanUrl: `http://${lanIp}:${port}` });
        } catch (err) {
            console.error('获取局域网地址失败:', err);
            res.json({
                success: false,
                error: err.message || '获取局域网地址失败',
                code: 'SERVER_INFO_FAILED',
                pcLanUrl: `http://127.0.0.1:${port}`
            });
        }
    });
};
