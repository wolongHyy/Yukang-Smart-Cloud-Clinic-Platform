# YuKang Clinic Desktop Installers

This directory contains packaging source for the existing `clinic_system` application. Installer binaries and the full 209 MB knowledge index are not committed to Git.

## Default Logo

- Windows: `build/icon.ico`
- macOS: `build/icon.icns`
- Linux: `build/icon.png`

The source is copied from `愈康基本盘/圆角Logo-内层无边框-20260910`.

## Build on Windows

```powershell
npm ci
npm run install:electron
$env:YUKANG_KNOWLEDGE_DB = 'D:\YukangKnowledge\v5-full\knowledge_index.db'
npm run dist:win
```

## Build on Linux

On a Linux x86_64 machine:

```bash
npm ci
npm run install:electron
YUKANG_KNOWLEDGE_DB=/path/to/knowledge_index.db npm run dist:linux
```

For a smaller build without the full vector index:

```bash
YUKANG_ALLOW_LITE_INDEX=1 npm run dist:linux
```

The lite build still starts normally through the desktop shell and can use the existing keyword knowledge-base fallback. The full RAG index can be supplied at build time with `YUKANG_KNOWLEDGE_DB`.

## Build on macOS

macOS packaging is deferred for now. When needed:

```bash
YUKANG_KNOWLEDGE_DB=/path/to/knowledge_index.db npm run dist:mac
```

Generated output is written to `artifacts/`, which is ignored by Git. No installer binaries are uploaded automatically.
