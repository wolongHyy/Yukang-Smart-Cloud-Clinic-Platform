param(
    [string]$Version = "",
    [string]$OutputRoot = "D:\WorkBuddy下载\愈康商业化交付",
    [string]$KnowledgeDb = "D:\YukangKnowledge\v5-full\knowledge_index.db",
    [switch]$AllowLite,
    [switch]$AllowUnsigned,
    [switch]$SkipBuild,
    [switch]$DataLicenseConfirmed,
    [switch]$CleanVmVerified,
    [string]$CertificatePath = $env:CSC_LINK,
    [string]$CertificatePassword = $env:CSC_KEY_PASSWORD,
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repoRoot '愈康项目源码\clinic_system'
$desktopRoot = Join-Path $repoRoot 'desktop'
$sourcePackagePath = Join-Path $sourceRoot 'package.json'
$desktopPackagePath = Join-Path $desktopRoot 'package.json'

if (-not (Test-Path -LiteralPath $sourcePackagePath)) { throw "缺少主程序 package.json: $sourcePackagePath" }
if (-not (Test-Path -LiteralPath $desktopPackagePath)) { throw "缺少桌面构建 package.json: $desktopPackagePath" }

$sourcePackage = Get-Content -Raw -Encoding UTF8 $sourcePackagePath | ConvertFrom-Json
$desktopPackage = Get-Content -Raw -Encoding UTF8 $desktopPackagePath | ConvertFrom-Json
if (-not $Version) { $Version = [string]$sourcePackage.version }
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') { throw "版本号格式无效: $Version" }
if ([string]$sourcePackage.version -ne $Version) { throw "主程序版本 $($sourcePackage.version) 与请求版本 $Version 不一致，先统一版本号。" }
if ([string]$desktopPackage.version -ne $Version) { throw "桌面版本 $($desktopPackage.version) 与请求版本 $Version 不一致，先统一版本号。" }

$outputRootFull = [IO.Path]::GetFullPath($OutputRoot)
$driveRoot = [IO.Path]::GetPathRoot($outputRootFull)
if ($driveRoot -ne 'D:\') { throw "新构建和交付产物必须写入 D 盘。当前输出目录: $outputRootFull" }

if (-not $SkipBuild) {
    if (-not $AllowLite -and -not (Test-Path -LiteralPath $KnowledgeDb)) {
        throw "缺少完整知识库索引: $KnowledgeDb。如仅作测试可显式添加 -AllowLite。"
    }
    New-Item -ItemType Directory -Force -Path 'D:\CodexCache\npm','D:\CodexCache\electron','D:\CodexCache\electron-builder' | Out-Null
    $env:npm_config_cache = 'D:\CodexCache\npm'
    $env:ELECTRON_CACHE = 'D:\CodexCache\electron'
    $env:ELECTRON_BUILDER_CACHE = 'D:\CodexCache\electron-builder'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    $env:YUKANG_KNOWLEDGE_DB = $KnowledgeDb

    if ($CertificatePath) {
        $resolvedCertificate = (Resolve-Path -LiteralPath $CertificatePath).Path
        $env:CSC_LINK = $resolvedCertificate
        $env:WIN_CSC_LINK = $resolvedCertificate
        $env:CSC_KEY_PASSWORD = $CertificatePassword
        $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
        $env:CSC_TIMESTAMP_SERVER = $TimestampServer
    }
    if ($AllowLite) { $env:YUKANG_ALLOW_LITE_INDEX = '1' } else { Remove-Item Env:YUKANG_ALLOW_LITE_INDEX -ErrorAction SilentlyContinue }

    Push-Location $desktopRoot
    try {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE" }
        npm run install:electron
        if ($LASTEXITCODE -ne 0) { throw "Electron 运行时安装失败，退出码 $LASTEXITCODE" }
        npm run dist:win
        if ($LASTEXITCODE -ne 0) { throw "Windows 安装包构建失败，退出码 $LASTEXITCODE" }
        npm run smoke:runtime
        if ($LASTEXITCODE -ne 0) { throw "安装包运行时冒烟测试失败，退出码 $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

$artifactsRoot = Join-Path $desktopRoot 'artifacts'
$installerPattern = "YuKangClinic-Setup-$Version-x64.exe"
$installer = Get-ChildItem -LiteralPath $artifactsRoot -File -Filter $installerPattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    $candidates = Get-ChildItem -LiteralPath $artifactsRoot -File -Filter 'YuKangClinic-Setup-*.exe' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    throw "未找到目标安装包 $installerPattern。artifacts 中现有安装包: $($candidates -join ', ')"
}

$signatureScript = Join-Path $desktopRoot 'scripts\verify-signature.ps1'
$signatureArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$signatureScript,'-InstallerPath',$installer.FullName)
if ($AllowUnsigned) { $signatureArgs += '-AllowUnsigned' }
$signatureOutput = & powershell @signatureArgs 2>&1
$signatureText = ($signatureOutput | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "代码签名校验未通过:`n$signatureText" }

$signatureValid = [bool]($signatureText -match '(?m)^SIGNATURE_VALID=1\s*$')
$promotionReady = $signatureValid -and $DataLicenseConfirmed -and $CleanVmVerified
$releaseChannel = if ($promotionReady) {
    'commercial-signed'
} elseif ($signatureValid) {
    'commercial-signed-pending-release-gates'
} else {
    'internal-preview-unsigned'
}
$promotionBlockers = @()
if (-not $signatureValid) { $promotionBlockers += '缺少有效 Authenticode 代码签名' }
if (-not $DataLicenseConfirmed) { $promotionBlockers += '尚未确认药典数据商业授权' }
if (-not $CleanVmVerified) { $promotionBlockers += '尚未完成干净 Windows 虚拟机验收' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$versionRoot = Join-Path $outputRootFull "v$Version"
$releaseName = "YuKangClinic-v$Version-Windows-x64-$stamp"
$stage = Join-Path $versionRoot $releaseName
$dirs = @{
    installer = Join-Path $stage '安装包'
    documents = Join-Path $stage '文档'
    updater = Join-Path $stage '更新通道'
    license = Join-Path $stage '许可'
    verification = Join-Path $stage '校验'
    release = Join-Path $stage '发布信息'
}
foreach ($dir in $dirs.Values) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $dirs.installer $installer.Name) -Force
Copy-Item -Path (Join-Path $repoRoot 'docs\commercial\*') -Destination $dirs.documents -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $dirs.license 'LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.txt') -Destination (Join-Path $dirs.license 'THIRD_PARTY_NOTICES.txt') -Force
Copy-Item -LiteralPath (Join-Path $desktopRoot 'scripts\sign-update.js') -Destination (Join-Path $dirs.updater 'sign-update.js') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\commercial\update-config.example.json') -Destination (Join-Path $dirs.updater 'update-config.example.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\commercial\update-manifest.example.json') -Destination (Join-Path $dirs.updater 'update-manifest.example.json') -Force

$releaseInfo = [ordered]@{
    product = '愈康云诊所'
    version = $Version
    platform = 'Windows x64'
    built_at = (Get-Date).ToString('o')
    installer = $installer.Name
    installer_size_bytes = $installer.Length
    knowledge_db = if ($AllowLite) { 'lite' } else { $KnowledgeDb }
    source_commit = (& git -C $repoRoot rev-parse HEAD 2>$null)
    source_working_tree_dirty = [bool](& git -C $repoRoot status --porcelain 2>$null)
    signature_status = if ($signatureValid) { 'Valid' } else { 'NotSignedOrInvalid' }
    release_channel = $releaseChannel
    promotion_ready = $promotionReady
    signature_required = $true
    data_license_confirmed = [bool]$DataLicenseConfirmed
    clean_vm_verified = [bool]$CleanVmVerified
    promotion_blockers = @($promotionBlockers)
}
$releaseInfo | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $dirs.release 'RELEASE_INFO.json')
$signatureText | Set-Content -Encoding UTF8 (Join-Path $dirs.release 'SIGNATURE_STATUS.txt')

$readmeFirst = @(
    '# 先读我',
    '',
    "产品：愈康云诊所 v$Version",
    "发布通道：$releaseChannel",
    "是否达到推广条件：$(if ($promotionReady) { '是' } else { '否' })",
    '',
    '安装：双击“安装包”目录中的 YuKangClinic-Setup-*.exe。',
    '校验：文件哈希见“校验\SHA256SUMS.txt”，签名状态见“发布信息\SIGNATURE_STATUS.txt”。',
    ''
)
if ($promotionReady) {
    $readmeFirst += @(
        '本包已通过代码签名，并已声明完成药典数据授权确认和干净 Windows 虚拟机验收。',
        '仍应按发布合同和所在地法规保留审计记录。'
    )
} else {
    $readmeFirst += @(
        '重要：本目录当前不是正式商业版，也不是可直接大规模推广的稳定版本。',
        '不得以“正式版”或“商业稳定版”名义销售或收费分发。',
        '可在明确标注“未签名内部预览”的前提下通过项目 GitHub Release 提供受控下载。',
        '不得隐藏未签名事实后转发到官网、网盘、群聊或第三方下载站，也不得用于真实患者长期运行。',
        '推广阻断项：'
    )
    foreach ($blocker in $promotionBlockers) { $readmeFirst += "- $blocker" }
    $readmeFirst += @(
        '',
        '本包可用于内部开发、功能验收和安装链路演示。'
    )
}
[IO.File]::WriteAllText((Join-Path $stage 'README_FIRST.txt'), (($readmeFirst -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))

$hashLines = Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($stage.Length + 1).Replace('\','/')
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    "$hash *$relative"
}
$hashText = ($hashLines -join [Environment]::NewLine) + [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $dirs.verification 'SHA256SUMS.txt'), $hashText, (New-Object Text.UTF8Encoding($false)))

$latestText = (Join-Path "v$Version" $releaseName) + [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $versionRoot 'LATEST.txt'), $latestText, (New-Object Text.UTF8Encoding($false)))

$deliveryVerifier = Join-Path $repoRoot 'tools\verify-delivery.ps1'
if (-not (Test-Path -LiteralPath $deliveryVerifier)) { throw "缺少交付目录校验脚本: $deliveryVerifier" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $deliveryVerifier -DeliveryPath $stage
if ($LASTEXITCODE -ne 0) { throw "交付目录校验失败，退出码 $LASTEXITCODE" }

Write-Output "DELIVERY=$stage"
Write-Output "INSTALLER=$(Join-Path $dirs.installer $installer.Name)"
Write-Output "SIZE_MB=$([math]::Round($installer.Length / 1MB, 2))"
Write-Output "SHA256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash)"
Write-Output "SIGNATURE=$($releaseInfo.signature_status)"
Write-Output "RELEASE_CHANNEL=$releaseChannel"
Write-Output "PROMOTION_READY=$promotionReady"
