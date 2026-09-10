# YuKang Clinic Desktop Installers

This directory contains the packaging-only Electron shell for the existing `clinic_system` application. It does not change the web application's routes, database format, or business logic.

## Download

Prebuilt installers are published at:

https://github.com/wolongHyy/Yukang-Smart-Cloud-Clinic-Platform/releases/tag/v5.0.0-preview.1

## Default Logo

The installer uses the inner rounded YuKang logo without its outer border:

- Windows: `build/icon.ico`
- macOS: `build/icon.icns`
- Linux: `build/icon.png`
- Window title bar: the same `build/icon.png`

The source is copied from `愈康基本盘/圆角Logo-内层无边框-20260910`.

## Build

Set `YUKANG_KNOWLEDGE_DB` to the full `knowledge_index.db` before building.

```powershell
npm ci
npm run install:electron
$env:YUKANG_KNOWLEDGE_DB = 'D:\YukangKnowledge\v5-full\knowledge_index.db'
npm run dist:win
```

Linux and macOS are built through `.github/workflows/build-desktop-installers.yml` on their native GitHub runners.

## Outputs

- Windows: NSIS `.exe`
- Linux: `.AppImage` and `.deb`
- macOS: `.dmg` and `.zip`

Generated output is written to `artifacts/`, which is intentionally ignored by Git.
