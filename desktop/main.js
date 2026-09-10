'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const Module = require('module');

const packageJson = require('./package.json');
const PORT = Math.max(1, Number(process.env.YUKANG_DESKTOP_PORT) || 3002);
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const LOGIN_URL = `${LOCAL_URL}/login.html`;
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'runtime');
const CLINIC_DIR = process.env.YUKANG_DESKTOP_CLINIC_DIR || path.join(RESOURCE_ROOT, 'clinic_system');
const DATA_DIR = process.env.YUKANG_DESKTOP_DATA_DIR || path.join(app.getPath('userData'), 'clinic_database');

let mainWindow = null;
let fatalDialogShown = false;
let serverWasStartedByUs = false;

function showFatal(error) {
    if (fatalDialogShown) return;
    fatalDialogShown = true;
    const message = error && error.stack ? error.stack : String(error || '未知错误');
    console.error(message);
    if (app.isReady()) {
        dialog.showErrorBox('YuKang Clinic 启动失败', `本地服务无法启动。\n\n${message}`);
    }
    app.exit(1);
}

process.on('uncaughtException', showFatal);
process.on('unhandledRejection', showFatal);

function requestServerInfo() {
    return new Promise((resolve) => {
        const request = http.get(`${LOCAL_URL}/api/server-info`, { timeout: 800 }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve(data && data.success === true ? data : null);
                } catch (_) {
                    resolve(null);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

function canBindLocalPort() {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', () => resolve(false));
        probe.listen(PORT, '0.0.0.0', () => {
            probe.close(() => resolve(true));
        });
    });
}

async function waitForServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await requestServerInfo()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#f3f7f6',
        title: 'YuKang Clinic',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(LOCAL_URL)) return { action: 'allow' };
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(LOCAL_URL)) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });

    mainWindow.loadURL(LOGIN_URL).catch(showFatal);
}

async function bootstrap() {
    if (!fs.existsSync(path.join(CLINIC_DIR, 'server.js'))) {
        throw new Error(`应用文件缺失: ${CLINIC_DIR}`);
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    process.env.PORT = String(PORT);
    process.env.DATA_DIR = DATA_DIR;
    process.env.NO_OPEN_BROWSER = '1';
    process.env.YUKONG_APP_DIR = CLINIC_DIR;
    process.env.YUKONG_APP_VERSION = packageJson.version;
    process.env.NODE_PATH = [path.join(CLINIC_DIR, 'vendor'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    Module._initPaths();
    process.chdir(CLINIC_DIR);

    const existingServer = await requestServerInfo();
    if (!existingServer) {
        if (!(await canBindLocalPort())) {
            throw new Error(`端口 ${PORT} 已被其他程序占用，请关闭占用程序后重试。`);
        }
        serverWasStartedByUs = true;
        require(path.join(CLINIC_DIR, 'server.js'));
        if (!(await waitForServer())) {
            throw new Error(`本地服务在 60 秒内未就绪。数据目录: ${DATA_DIR}`);
        }
    } else {
        console.log(`检测到已有愈康服务，直接连接 ${LOCAL_URL}`);
    }

    if (process.env.YUKANG_DESKTOP_SMOKE === '1') {
        console.log(`YUKANG_DESKTOP_SMOKE_READY data=${DATA_DIR} serverStartedByUs=${serverWasStartedByUs}`);
        setTimeout(() => app.exit(0), 500);
        return;
    }

    createMainWindow();
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        } else if (app.isReady()) {
            createMainWindow();
        }
    });

    app.whenReady().then(bootstrap).catch(showFatal);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createMainWindow();
    });

    app.on('window-all-closed', () => app.quit());
}




