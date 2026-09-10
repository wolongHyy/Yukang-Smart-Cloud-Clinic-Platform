const path = require('path');

module.exports = function registerPageRoutes(app, baseDir) {
    app.get(['/', '/index.html'], (req, res) => {
        res.sendFile(path.join(baseDir, 'index.html'));
    });
    app.get('/login.html', (req, res) => {
        res.sendFile(path.join(baseDir, 'login.html'));
    });
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) {
            return res.status(404).json({ error: '接口不存在', code: 'API_NOT_FOUND' });
        }
        res.status(404).send('页面不存在');
    });
};
