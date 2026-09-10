const path = require('path');
const express = require('express');

module.exports = function registerPageRoutes(app, baseDir) {
    // 只开放页面运行所需的静态资源，避免把 server.js、数据库和 node_modules 暴露出去。
    app.use('/assets', express.static(path.join(baseDir, 'assets'), {
        dotfiles: 'deny',
        index: false,
    }));
    app.get('/v5-pages.css', (req, res) => {
        res.sendFile(path.join(baseDir, 'v5-pages.css'));
    });
    app.get('/v5-pages.js', (req, res) => {
        res.sendFile(path.join(baseDir, 'v5-pages.js'));
    });
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