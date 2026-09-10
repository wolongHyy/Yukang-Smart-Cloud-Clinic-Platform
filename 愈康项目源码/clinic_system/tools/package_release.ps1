param(
    [string]$Version = "4.0.0",
    [string]$OutputRoot = "D:\YukangReleases"
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseName = "yukang-clinic-v$Version-$stamp"
$stagingRoot = Join-Path $OutputRoot $releaseName
$packageDir = Join-Path $stagingRoot "clinic_system"
New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

$excludeDirs = @(
    (Join-Path $source "clinic_database"),
    (Join-Path $source "docs"),
    (Join-Path $source "tests"),
    (Join-Path $source ".pytest_cache"),
    (Join-Path $source "local_rag_worker\tests")
)
$backupDirs = Get-ChildItem -LiteralPath $source -Directory -Filter "_backup_*" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$excludeDirs += $backupDirs
$excludeFiles = @("*.log", "*.zip", "*.tmp", "_hybrid_input_*.jsonl", "knowledge_index.db", "knowledge_index.db-wal", "knowledge_index.db-shm")
$args = @($source, $packageDir, "/E", "/R:1", "/W:1", "/XD") + $excludeDirs + @("/XF") + $excludeFiles
& robocopy @args | Out-Host
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Set-Content -LiteralPath (Join-Path $packageDir "RELEASE_VERSION.txt") -Value $Version -Encoding ASCII
$zipPath = Join-Path $OutputRoot "$releaseName.zip"
Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $zipPath -Force
Write-Output $zipPath