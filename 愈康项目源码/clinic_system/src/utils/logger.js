const fs = require('fs');
const path = require('path');

function redact(value) {
    return String(value == null ? '' : value)
        .replace(/1[3-9]\d{9}/g, '1**********')
        .replace(/\b\d{17}[\dXx]\b/g, '******************')
        .replace(/(患者|姓名|name)[:：]\s*[^\s,，;；]+/gi, '$1:***');
}

function logFile() {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'clinic_database');
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'server.log');
}

function append(level, message, err) {
    const detail = err ? (err.stack || err.message || String(err)) : '';
    const line = `${new Date().toISOString()} [${level}] ${redact(message)}${detail ? ' ' + redact(detail) : ''}\n`;
    try {
        fs.appendFileSync(logFile(), line, 'utf8');
    } catch (_) {}
    return line.trimEnd();
}

function logError(message, err) {
    console.error(append('ERROR', message, err));
}

function logWarn(message, err) {
    console.warn(append('WARN', message, err));
}

module.exports = { logError, logWarn, redact, logFile };
