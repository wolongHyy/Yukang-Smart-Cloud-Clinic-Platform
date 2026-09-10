@echo off
title YuKang Local RAG Worker
cd /d "%~dp0"
set "PYTHON_EXE=D:\CodexEnvs\yukang-rag\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo Missing local RAG runtime: %PYTHON_EXE%
    pause
    exit /b 1
)
set HF_HUB_OFFLINE=1
set YUKONG_RAG_CACHE_DIR=D:\CodexModels\fastembed
"%PYTHON_EXE%" -m uvicorn app.main:app --app-dir "%~dp0local_rag_worker" --host 127.0.0.1 --port 8765