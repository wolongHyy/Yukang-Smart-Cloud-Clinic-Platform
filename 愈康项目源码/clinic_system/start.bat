@echo off
title YuKang Cloud Clinic System
cd /d "%~dp0"

:: ================================================
::  端口配置：以后改端口只改这里一个地方
:: ================================================
set PORT=3002
set "YUKONG_APP_DIR=%~dp0"
:: ================================================

echo ========================================
echo     YuKang Cloud Clinic - Quick Start
echo ========================================
echo.

:: Use bundled portable Node.js
set "NODE_EXE=%~dp0node\node.exe"
set "NPM_CMD=%~dp0node\npm.cmd"

:: 1. Check bundled node.exe
echo [1/4] Checking bundled Node.js...
if not exist "%NODE_EXE%" (
    echo   [FAIL] node.exe not found in node\ folder!
    echo   Please ensure the node folder is included.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('"%NODE_EXE%" -v') do set NODE_VER=%%i
echo   [OK] Node.js version: %NODE_VER%
echo.

:: 2. Install dependencies (bundled npm)
echo [2/4] Checking dependencies...
if not exist "node_modules\express" (
    echo   First run, installing packages...
    call "%NPM_CMD%" install express cors --production
    if %errorlevel% neq 0 (
        echo   [FAIL] npm install failed
        echo   Please run manually: cd "%~dp0" ^& npm install express cors
        echo.
        pause
        exit /b 1
    )
    echo   [OK] Dependencies installed
) else (
    echo   [OK] Dependencies ready
)
echo.

:: 3. Init data directory
echo [3/4] Initializing data directory...
if not exist "clinic_database" (
    mkdir clinic_database
    echo   [OK] Created: clinic_database\
) else (
    echo   [OK] Data directory exists
)
echo.

:: 4. Start server
echo [4/4] Starting server...
echo.
echo ========================================
echo   电脑本机访问: http://localhost:%PORT%
echo   手机扫码访问: 登录后在系统设置里查看
echo ========================================
echo.
echo   浏览器将自动打开（防缓存模式）
echo   按 Ctrl+C 停止服务器
echo.

:: Optional local RAG worker. Node falls back to keyword retrieval if unavailable.
if exist "D:\CodexEnvs\yukang-rag\Scripts\python.exe" (
    start "YuKang Local RAG" /min cmd /c "%~dp0start_rag.bat"
)

:: 自动打开浏览器（加随机数防缓存，避免跳到旧页面）
start "" "http://localhost:%PORT%/login.html?t=%random%"

"%NODE_EXE%" --disable-warning=ExperimentalWarning server.js

echo.
echo Server stopped.
pause