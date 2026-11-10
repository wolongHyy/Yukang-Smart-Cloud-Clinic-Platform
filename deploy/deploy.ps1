[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerHost,

  [string]$User = "root",

  [ValidateRange(1, 65535)]
  [int]$Port = 22,

  [Parameter(Mandatory = $true)]
  [string]$KeyPath,

  [Parameter(Mandatory = $true)]
  [string]$Domain,

  [string]$Email,

  [switch]$IncludeWww,
  [switch]$SkipTls,
  [switch]$SkipDnsCheck,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host "`n[愈康官网] $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "本机缺少命令：$Name。Windows 10/11 通常已自带 OpenSSH 和 tar。"
  }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败（退出码 $LASTEXITCODE）：$FilePath $($Arguments -join ' ')"
  }
}

if (-not $PlanOnly -and -not (Test-Path -LiteralPath "D:\")) {
  throw "D 盘不可用。按照全局规则，部署临时文件必须放在 D 盘。"
}

$serverHostValue = $ServerHost.Trim()
$userValue = $User.Trim()
$domainValue = $Domain.Trim().TrimEnd(".").ToLowerInvariant()
$emailValue = if ($null -eq $Email) { "" } else { $Email.Trim() }

if ($serverHostValue -notmatch "^[A-Za-z0-9][A-Za-z0-9.-]*$") {
  throw "ServerHost 只接受 ECS 公网 IPv4 或主机名，例如 47.100.1.2。"
}
if ($userValue -notmatch "^[A-Za-z0-9._-]+$") {
  throw "SSH 用户名格式不正确：$userValue"
}
if ($domainValue -notmatch "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$") {
  throw "域名格式不正确：$domainValue"
}
if (-not $SkipTls) {
  if ([string]::IsNullOrWhiteSpace($emailValue) -or $emailValue -notmatch "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$") {
    throw "启用 HTTPS 时必须提供有效 -Email；如只配置 HTTP，请显式使用 -SkipTls。"
  }
}

$keyItem = Get-Item -LiteralPath $KeyPath -ErrorAction Stop
if ($keyItem.PSIsContainer) {
  throw "KeyPath 必须指向 SSH 私钥文件，而不是目录：$($keyItem.FullName)"
}
$keyFullPath = $keyItem.FullName

foreach ($cmd in @("ssh", "scp", "tar")) {
  Assert-Command $cmd
}

$deployDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $deployDir
$websiteDir = Join-Path $projectRoot "website"
$installerPath = Join-Path $deployDir "install-site.sh"
$templatePath = Join-Path $deployDir "nginx\yukang-site.conf.template"

foreach ($requiredPath in @($websiteDir, $installerPath, $templatePath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "缺少部署文件：$requiredPath"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $websiteDir "index.html"))) {
  throw "website/index.html 不存在，无法部署。"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempRoot = "D:\CodexTemp\yukang-site-deploy"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$runDir = Join-Path $tempRoot ("run-" + $timestamp + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$archivePath = Join-Path $runDir "yukang-site.tar.gz"

$remoteDir = "/tmp/yukang-site-$timestamp"
$knownHosts = Join-Path $HOME ".ssh\known_hosts"
$sshBaseArgs = @(
  "-i", $keyFullPath,
  "-p", "$Port",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=$knownHosts"
)
$scpBaseArgs = @(
  "-i", $keyFullPath,
  "-P", "$Port",
  "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=$knownHosts"
)
$target = "$userValue@$serverHostValue"

$installArgs = @(
  "--archive", "$remoteDir/yukang-site.tar.gz",
  "--template", "$remoteDir/yukang-site.conf.template",
  "--domain", $domainValue
)
if (-not [string]::IsNullOrWhiteSpace($emailValue)) {
  $installArgs += @("--email", $emailValue)
}
if ($IncludeWww) { $installArgs += "--include-www" }
if ($SkipTls) { $installArgs += "--skip-tls" }
if ($SkipDnsCheck) { $installArgs += "--skip-dns-check" }

$quotedInstallArgs = ($installArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join " "
$remoteCommand = if ($userValue -eq "root") {
  "bash '$remoteDir/install-site.sh' $quotedInstallArgs"
} else {
  "sudo bash '$remoteDir/install-site.sh' $quotedInstallArgs"
}

$remoteCreated = $false
try {
  Write-Step "打包静态官网"
  Push-Location $websiteDir
  try {
    Invoke-Native "tar" @("-C", $websiteDir, "-czf", $archivePath, ".")
  }
  finally {
    Pop-Location
  }
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  Write-Host "压缩包：$archivePath"
  Write-Host "SHA-256：$hash"

  Write-Step "部署参数"
  Write-Host "服务器：$target"
  Write-Host "SSH 端口：$Port"
  Write-Host "域名：$domainValue$([Environment]::NewLine)HTTPS：$(-not $SkipTls)"
  Write-Host "站点隔离：仅上传 website 静态文件，不上传诊所业务系统、数据库或 .env"

  if ($PlanOnly) {
    Write-Step "PlanOnly：已完成本地校验，未连接服务器"
    Write-Host "将要执行：$remoteCommand"
    return
  }

  $runSshArgs = @($sshBaseArgs)
  if ($userValue -ne "root") {
    $runSshArgs = @("-t") + $runSshArgs
  }

  Write-Step "创建远程临时目录"
  Invoke-Native "ssh" (@($sshBaseArgs) + @($target, "mkdir -p -- '$remoteDir'"))
  $remoteCreated = $true

  Write-Step "上传站点与安装脚本"
  Invoke-Native "scp" (@($scpBaseArgs) + @($archivePath, "${target}:$remoteDir/"))
  Invoke-Native "scp" (@($scpBaseArgs) + @($installerPath, "${target}:$remoteDir/"))
  Invoke-Native "scp" (@($scpBaseArgs) + @($templatePath, "${target}:$remoteDir/"))

  Write-Step "在 ECS 上安装 Nginx、发布站点并配置 HTTPS"
  Invoke-Native "ssh" (@($runSshArgs) + @($target, $remoteCommand))

  Write-Step "本机发起公网访问检查"
  Start-Sleep -Seconds 2
  try {
    $dnsRecords = Resolve-DnsName -Name $domainValue -Type A -ErrorAction Stop |
      Where-Object { $_.Type -eq "A" } |
      Select-Object -ExpandProperty IPAddress
    Write-Host "DNS A 记录：$($dnsRecords -join ', ')"
  }
  catch {
    Write-Warning "本机暂时无法解析 $domainValue，请稍后用 Resolve-DnsName 再检查。"
  }

  $scheme = if ($SkipTls) { "http" } else { "https" }
  $siteUrl = "${scheme}://$domainValue/"
  try {
    $response = Invoke-WebRequest -Uri $siteUrl -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 20
    Write-Host "公网访问：HTTP $([int]$response.StatusCode)  $siteUrl"
  }
  catch {
    Write-Warning "本机公网检查未通过：$($_.Exception.Message)"
    Write-Warning "服务器端健康检查已经通过。若刚改 DNS，请等待解析生效后再打开 $siteUrl。"
  }

  Write-Step "部署命令执行完成"
  Write-Host "官网地址：$siteUrl"
  Write-Host "如遇备案、DNS 或安全组问题，请阅读 deploy/README.md。"
}
finally {
  if ($remoteCreated) {
    try {
      Invoke-Native "ssh" (@($sshBaseArgs) + @($target, "rm -rf -- '$remoteDir'"))
    }
    catch {
      Write-Warning "远程临时目录清理失败，可手工删除：$remoteDir"
    }
  }

  $resolvedRunDir = [IO.Path]::GetFullPath($runDir)
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot).TrimEnd("\") + "\"
  if ($resolvedRunDir.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedRunDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  else {
    Write-Warning "安全检查阻止了临时目录清理：$resolvedRunDir"
  }
}