#!/usr/bin/env bash
# 愈康官网服务器安装脚本
# 支持：Ubuntu / Debian / Rocky / AlmaLinux / CentOS Stream / Alibaba Cloud Linux
set -Eeuo pipefail
IFS=$'\n\t'

INSTALLER_VERSION="1.0.0"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || { printf '[愈康官网][错误] 需要 root 权限，请使用 sudo 运行。\n' >&2; exit 1; }
  exec sudo -- bash "$0" "$@"
fi

SITE_BASE="/var/www/yukang-site"
SITE_ROOT="${SITE_BASE}/current"
DOMAIN=""
EMAIL=""
INCLUDE_WWW=0
SKIP_TLS=0
SKIP_DNS_CHECK=0
ARCHIVE=""
TEMPLATE=""

usage() {
  cat <<'EOF'
用法：
  sudo bash install-site.sh --archive /tmp/site.tar.gz --template /tmp/yukang-site.conf.template \
    --domain example.com [--email admin@example.com] [选项]

必填：
  --archive PATH       官网静态文件 tar.gz
  --template PATH      Nginx 配置模板
  --domain DOMAIN      主域名，例如 example.com

HTTPS：
  --email EMAIL        用于 Let's Encrypt 证书通知
  --skip-tls           只配置 HTTP，不签发证书
  --include-www        同时为 www.DOMAIN 配置证书
  --skip-dns-check     跳过“域名是否解析到本机公网 IP”的预检查

示例：
  sudo bash install-site.sh --archive /tmp/site.tar.gz --template /tmp/site.conf.template \
    --domain example.com --email admin@example.com --include-www
EOF
}

log()  { printf '[愈康官网] %s\n' "$*"; }
warn() { printf '[愈康官网][警告] %s\n' "$*" >&2; }
die()  { printf '[愈康官网][错误] %s\n' "$*" >&2; exit 1; }
trap 'warn "安装脚本在第 ${LINENO} 行退出，请保留上面的错误信息。"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)      [[ $# -ge 2 ]] || die "--archive 缺少参数"; ARCHIVE="$2"; shift 2 ;;
    --template)     [[ $# -ge 2 ]] || die "--template 缺少参数"; TEMPLATE="$2"; shift 2 ;;
    --domain)       [[ $# -ge 2 ]] || die "--domain 缺少参数"; DOMAIN="$2"; shift 2 ;;
    --email)        [[ $# -ge 2 ]] || die "--email 缺少参数"; EMAIL="$2"; shift 2 ;;
    --include-www)  INCLUDE_WWW=1; shift ;;
    --skip-tls)     SKIP_TLS=1; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "未知参数：$1（使用 --help 查看帮助）" ;;
  esac
done


[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || die "找不到官网压缩包：${ARCHIVE:-<未提供>}"
[[ -n "$TEMPLATE" && -f "$TEMPLATE" ]] || die "找不到 Nginx 模板：${TEMPLATE:-<未提供>}"
[[ -n "$DOMAIN" ]] || die "必须提供 --domain。"

DOMAIN="${DOMAIN%.}"
DOMAIN="${DOMAIN,,}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
  || die "域名格式不正确：$DOMAIN"

if [[ "$SKIP_TLS" -eq 0 ]]; then
  [[ -n "$EMAIL" ]] || die "启用 HTTPS 时必须提供 --email。"
  [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] \
    || die "邮箱格式不正确：$EMAIL"
fi

command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，当前脚本仅支持带 systemd 的常见 Linux 发行版。"

[ -r /etc/os-release ] || die "无法读取 /etc/os-release，不能识别系统版本。"
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_LIKE="${ID_LIKE:-}"
PACKAGE_FAMILY=""
case " ${OS_ID} ${OS_LIKE} " in
  *" debian "*|*" ubuntu "*) PACKAGE_FAMILY="debian" ;;
  *" rhel "*|*" centos "*|*" fedora "*|*" rocky "*|*" almalinux "*|*" anolis "*) PACKAGE_FAMILY="rhel" ;;
  *) die "暂未适配系统 ${PRETTY_NAME:-$OS_ID}。支持 Ubuntu/Debian/Rocky/AlmaLinux/CentOS Stream/Alibaba Cloud Linux。" ;;
esac

log "系统：${PRETTY_NAME:-$OS_ID}；安装方式：$PACKAGE_FAMILY"
if [[ "$PACKAGE_FAMILY" == "debian" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends nginx rsync curl ca-certificates tar
  if [[ "$SKIP_TLS" -eq 0 ]]; then
    apt-get install -y --no-install-recommends certbot python3-certbot-nginx
  fi
else
  if command -v dnf >/dev/null 2>&1; then
    PKG=dnf
  elif command -v yum >/dev/null 2>&1; then
    PKG=yum
  else
    die "未检测到 dnf 或 yum。"
  fi
  "$PKG" install -y nginx rsync curl ca-certificates tar
  if [[ "$SKIP_TLS" -eq 0 ]]; then
    if ! "$PKG" install -y certbot python3-certbot-nginx; then
      warn "首次安装 certbot 失败，尝试启用 EPEL 后重试。"
      "$PKG" install -y epel-release || true
      "$PKG" install -y certbot python3-certbot-nginx
    fi
  fi
fi

for cmd in nginx tar curl rsync; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少命令：$cmd"
done
if [[ "$SKIP_TLS" -eq 0 ]]; then
  command -v certbot >/dev/null 2>&1 || die "缺少 certbot，无法签发 HTTPS 证书。"
fi

stage="$(mktemp -d /tmp/yukang-site-stage.XXXXXX)"
trap 'rm -rf -- "$stage" "${config_backup:-}" 2>/dev/null || true' EXIT

log "解压并检查静态站点。"
tar -xzf "$ARCHIVE" -C "$stage"
for required in index.html styles.css script.js favicon.svg; do
  [[ -f "$stage/$required" ]] || die "压缩包缺少必要文件：$required"
done
if find "$stage" -type l -print -quit | grep -q .; then
  die "压缩包内包含符号链接，已停止安装。"
fi

install -d -m 0755 "$SITE_BASE" "$SITE_BASE/releases"
release="$SITE_BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0755 "$release"
cp -a "$stage"/. "$release"/
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
ln -sfn "$release" "$SITE_BASE/current.new"
mv -Tf "$SITE_BASE/current.new" "$SITE_ROOT"
log "站点文件已发布到 $release"

server_names="$DOMAIN"
if [[ "$INCLUDE_WWW" -eq 1 ]]; then
  server_names="$DOMAIN www.$DOMAIN"
fi

rendered="$(mktemp /tmp/yukang-site-nginx.XXXXXX)"
sed \
  -e "s|__SERVER_NAMES__|$server_names|g" \
  -e "s|__SITE_ROOT__|$SITE_ROOT|g" \
  "$TEMPLATE" > "$rendered"
if [[ "$SKIP_TLS" -eq 1 ]]; then
  sed -i '/__HSTS_MARKER__/d' "$rendered"
else
  sed -i 's/[[:space:]]*# __HSTS_MARKER__//' "$rendered"
fi

if [[ "$PACKAGE_FAMILY" == "debian" ]]; then
  conf_path="/etc/nginx/sites-available/yukang-site.conf"
  enabled_link="/etc/nginx/sites-enabled/yukang-site.conf"
else
  conf_path="/etc/nginx/conf.d/yukang-site.conf"
  enabled_link=""
fi

config_backup="$(mktemp)"
if [[ -f "$conf_path" ]]; then
  cp -p "$conf_path" "$config_backup"
else
  : > "$config_backup"
fi
install -m 0644 "$rendered" "$conf_path"
if [[ -n "$enabled_link" ]]; then
  ln -sfn "$conf_path" "$enabled_link"
fi
rm -f -- "$rendered"

if ! nginx -t; then
  warn "Nginx 配置测试失败，正在恢复原配置。"
  if [[ -s "$config_backup" ]]; then
    install -m 0644 "$config_backup" "$conf_path"
  else
    rm -f -- "$conf_path"
    [[ -n "$enabled_link" ]] && rm -f -- "$enabled_link"
  fi
  die "Nginx 配置未通过测试，官网文件已保留，但配置未启用。"
fi

systemctl enable nginx >/dev/null 2>&1 || true
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi

log "检查本机 HTTP 健康状态。"
curl -fsS --max-time 8 -H "Host: $DOMAIN" http://127.0.0.1/healthz >/dev/null \
  || die "本机健康检查失败，请查看 nginx 错误日志。"

if [[ "$SKIP_TLS" -eq 0 ]]; then
  if [[ "$SKIP_DNS_CHECK" -eq 0 ]]; then
    log "检查 $DOMAIN 是否解析到当前服务器的公网 IPv4。"
    public_ip="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    resolved_ips="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    if [[ -z "$public_ip" ]]; then
      warn "无法自动读取服务器公网 IP，跳过 IP 匹配。"
    elif [[ -z "$resolved_ips" ]]; then
      die "域名尚未解析出 IPv4。请先在阿里云 DNS 添加 A 记录，或使用 --skip-dns-check。"
    elif ! grep -Fxq "$public_ip" <<<"$resolved_ips"; then
      die "域名当前解析结果（$(tr '\n' ' ' <<<"$resolved_ips")）不包含服务器公网 IP（$public_ip）。请先修正 DNS，或使用 --skip-dns-check。"
    fi
  fi

  log "申请并安装 Let's Encrypt 证书。"
  certbot_args=(--nginx --non-interactive --agree-tos --redirect --keep-until-expiring --email "$EMAIL" -d "$DOMAIN")
  if [[ "$INCLUDE_WWW" -eq 1 ]]; then
    certbot_args+=(-d "www.$DOMAIN")
  fi
  if ! certbot "${certbot_args[@]}"; then
    die "证书签发失败。HTTP 站点仍可使用；请确认安全组已放行 80/443、DNS 已生效后重新运行脚本。"
  fi
  nginx -t
  systemctl reload nginx

  log "检查本机 HTTPS 健康状态。"
  curl -fsS --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null "https://$DOMAIN/" \
    || die "HTTPS 健康检查失败，请检查证书和 Nginx 配置。"
  if [[ "$INCLUDE_WWW" -eq 1 ]]; then
    curl -fsS --max-time 8 --resolve "www.$DOMAIN:443:127.0.0.1" -o /dev/null "https://www.$DOMAIN/" \
      || die "www HTTPS 健康检查失败，请检查 DNS 和证书是否同时覆盖 www。"
  fi
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  warn "系统启用了 ufw。请确认已放行 80/tcp 与 443/tcp；脚本不会自动修改防火墙。"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  warn "系统启用了 firewalld。请确认已放行 http 与 https；脚本不会自动修改防火墙。"
fi

log "部署完成。安装器版本：$INSTALLER_VERSION"
if [[ "$SKIP_TLS" -eq 1 ]]; then
  log "访问：http://$DOMAIN"
else
  log "访问：https://$DOMAIN"
fi
log "站点目录：$SITE_ROOT；Nginx 配置：$conf_path"