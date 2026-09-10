// ============================================================
//  愈康项目 v4.0 - 服务器入口
//  这里只负责装配中间件、路由、异常处理和启动流程；
//  业务逻辑在 src/services，文件读写集中在 src/repository。
// ============================================================
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const knowledge = require('./knowledge');
const repo = require('./src/repository/sqliteRepository');
const { logError } = require('./src/utils/logger');
const { getLANIP } = require('./src/utils/helpers');
const localCrypto = require('./src/security/localCryptoService');
const { startEdgeAgent, stopEdgeAgent } = require('./src/services/edgeAgentService');
const systemService = require('./src/services/systemService');

const authRoutes = require('./src/routes/authRoutes');
const clinicalRoutes = require('./src/routes/clinicalRoutes');
const knowledgeRoutes = require('./src/routes/knowledgeRoutes');
const aiRoutes = require('./src/routes/aiRoutes');
const patientRoutes = require('./src/routes/patientRoutes');
const inventoryRoutes = require('./src/routes/inventoryRoutes');
const pharmacyRoutes = require('./src/routes/pharmacyRoutes');
const statisticsRoutes = require('./src/routes/statisticsRoutes');
const visitRoutes = require('./src/routes/visitRoutes');
const systemRoutes = require('./src/routes/systemRoutes');
const collectionRoutes = require('./src/routes/collectionRoutes');
const pageRoutes = require('./src/routes/pageRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 3002;
const BASE_DIR = __dirname;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.path.endsWith('.html') || req.path === '/' || req.path === '') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

authRoutes(app, PORT);
clinicalRoutes(app);
knowledgeRoutes(app);
aiRoutes(app);
patientRoutes(app);
inventoryRoutes(app);
pharmacyRoutes(app);
statisticsRoutes(app);
visitRoutes(app);
systemRoutes(app);

// 通用集合 CRUD 放在业务路由之后，避免抢占 /api/drug-inventory 等具体路径。
collectionRoutes(app);
pageRoutes(app, BASE_DIR);

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err.status) || 500;
    const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
    if (status >= 500) logError(`接口处理失败: ${req.method} ${req.originalUrl}`, err);
    else logError(`请求被拒绝: ${req.method} ${req.originalUrl} [${code}]`, err);
    res.status(status).json({
        error: status >= 500 ? '服务器内部错误' : (err.message || '请求失败'),
        code
    });
});

async function startServer() {
    try {
        const dataKey = await localCrypto.getOrCreateDataKey(repo.DATA_DIR);
        repo.setEncryptionKey(dataKey);
        await repo.initRootStorage();
        const dbStatus = await repo.getStatus();
        console.log(`  SQLite 数据库已就绪：${dbStatus.database}`);
        repo.startAutoBackup();
        startEdgeAgent({ dataDir: repo.DATA_DIR, aggregateProvider: systemService.clinicAggregate });
    } catch (err) {
        logError('初始化根存储失败:', err);
        process.exit(1);
    }

    try {
        knowledge.loadKnowledge();
        const ks = knowledge.stats();
        console.log(`  知识库已加载：单药 ${ks.pharma} 条 / 方剂 ${ks.formulas} 首 / 相互作用 ${ks.interactions} 条`);
    } catch (err) {
        logError('知识库加载失败（请确认 data 目录存在）:', err);
    }

    app.listen(PORT, '0.0.0.0', () => {
        const lanIP = getLANIP();
        console.log('========================================');
        console.log('  愈康项目服务已启动（v4.0）');
        console.log('========================================');
        console.log(`  电脑本机访问: http://localhost:${PORT}`);
        console.log(`  手机端访问:   http://${lanIP}:${PORT}`);
        console.log('========================================');
        if (process.platform === 'win32' && !process.env.NO_OPEN_BROWSER) {
            const url = `http://localhost:${PORT}/login.html`;
            exec(`start ${url}`);
        }
    });
}

process.on('SIGINT', () => { stopEdgeAgent(); process.exit(0); });
process.on('SIGTERM', () => { stopEdgeAgent(); process.exit(0); });

startServer();
