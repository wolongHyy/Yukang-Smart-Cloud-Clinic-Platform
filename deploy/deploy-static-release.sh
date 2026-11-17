#!/usr/bin/env bash
set -Eeuo pipefail

COMMIT='a54b7c98448c4685f5ccf3ffb00434fde3da1620'
RELEASE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
SITE_ROOT='/var/www/yukang-site'
RELEASE_DIR="$SITE_ROOT/releases/$RELEASE_TS"
SHARED_DIR="$SITE_ROOT/shared"
DOWNLOAD_DIR="$SHARED_DIR/downloads"
ASSET='YuKangClinic-Setup-5.1.0-x64.exe'
EXPECTED_SHA='8549DEB884709E45A759124D7F3586767449B704C2EE20D2FFCB2EB4098B5841'
EXPECTED_SIZE='258904900'
TMP_DIR="/tmp/yukang-static-deploy-$RELEASE_TS"
ARCHIVE_URL="https://codeload.github.com/wolongHyy/Yukang-Smart-Cloud-Clinic-Platform/tar.gz/$COMMIT"
LOG="/tmp/yukang-static-deploy-$RELEASE_TS.log"
SWITCHED=0
SUCCESS=0
PREVIOUS_RELEASE=''

exec > >(tee "$LOG") 2>&1

rollback() {
  local code=$?
  if [[ "$SUCCESS" = '1' ]]; then
    exit 0
  fi
  echo "__YK_DEPLOY_FAILED__ exit=$code line=${BASH_LINENO[0]:-unknown}"
  if [[ "$SWITCHED" = '1' && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    echo "__YK_ROLLBACK_START__ previous=$PREVIOUS_RELEASE"
    ln -s "$PREVIOUS_RELEASE" "$SITE_ROOT/current.tmp"
    mv -Tf "$SITE_ROOT/current.tmp" "$SITE_ROOT/current"
    if nginx -t; then systemctl reload nginx || true; fi
    echo "__YK_ROLLBACK_DONE__ current=$(readlink -f "$SITE_ROOT/current")"
  fi
  exit "$code"
}
trap rollback EXIT

echo "__YK_DEPLOY_START__ $RELEASE_TS"
echo "COMMIT=$COMMIT"
mkdir -p "$TMP_DIR" "$SITE_ROOT/releases"

echo '__YK_DOWNLOAD_SOURCE__'
for attempt in 1 2 3 4; do
  if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 600 "$ARCHIVE_URL" -o "$TMP_DIR/site.tar.gz"; then
    break
  fi
  echo "archive_attempt_${attempt}_failed"
  sleep 3
done
test -s "$TMP_DIR/site.tar.gz"
mkdir -p "$TMP_DIR/extract"
tar -xzf "$TMP_DIR/site.tar.gz" -C "$TMP_DIR/extract"
SRC_DIR="$(find "$TMP_DIR/extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
test -n "$SRC_DIR"
test -f "$SRC_DIR/website/index.html"

echo '__YK_STAGE_RELEASE__'
mkdir -p "$RELEASE_DIR"
cp -a "$SRC_DIR/website/." "$RELEASE_DIR/"
for f in index.html ai.html download.html site.css gallery.css site.js gallery.js workbench-preview.css workbench-preview.js favicon.svg robots.txt; do
  test -s "$RELEASE_DIR/$f" || { echo "missing_site_file=$f"; exit 1; }
done
test -s "$RELEASE_DIR/assets/screens/03-ai-assist.jpg"
test "$(find "$RELEASE_DIR/assets/screens" -type f -name '*.jpg' | wc -l)" -ge 15
grep -Fq '让每一次接诊，都有据可循' "$RELEASE_DIR/index.html"
grep -Fq 'AI 辅助诊疗' "$RELEASE_DIR/ai.html"
grep -Fq 'styles.css?v=20261117c' "$RELEASE_DIR/index.html"
grep -Fq 'script.js?v=20261117c' "$RELEASE_DIR/index.html"
grep -Fq 'site.css?v=20261117b' "$RELEASE_DIR/ai.html"
grep -Fq 'site.js?v=20261117b' "$RELEASE_DIR/ai.html"
grep -Fq 'workbench-preview.css?v=20261117c' "$RELEASE_DIR/index.html"
grep -Fq 'workbench-preview.js?v=20261117c' "$RELEASE_DIR/index.html"
grep -Fq 'workbench-preview.css?v=20261117c' "$RELEASE_DIR/download.html"
grep -Fq 'workbench-preview.js?v=20261117c' "$RELEASE_DIR/download.html"
grep -Fq 'data-workbench-preview' "$RELEASE_DIR/index.html"
grep -Fq 'data-workbench-preview' "$RELEASE_DIR/download.html"
grep -Fq 'code-block-spaced' "$RELEASE_DIR/download.html"
chown -R root:root "$RELEASE_DIR"
find "$RELEASE_DIR" -type d -exec chmod 755 {} +
find "$RELEASE_DIR" -type f -exec chmod 644 {} +

echo '__YK_SWITCH_RELEASE__'
PREVIOUS_RELEASE="$(readlink -f "$SITE_ROOT/current" 2>/dev/null || true)"
test -n "$PREVIOUS_RELEASE"
test -d "$PREVIOUS_RELEASE"
rm -f "$SITE_ROOT/current.tmp"
ln -s "$RELEASE_DIR" "$SITE_ROOT/current.tmp"
mv -Tf "$SITE_ROOT/current.tmp" "$SITE_ROOT/current"
SWITCHED=1
echo "PREVIOUS_RELEASE=$PREVIOUS_RELEASE"
echo "CURRENT_RELEASE=$(readlink -f "$SITE_ROOT/current")"

echo '__YK_NGINX_RELOAD__'
nginx -t
systemctl reload nginx
sleep 2

echo '__YK_VERIFY__'
ROOT_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o "$TMP_DIR/home.html" -w '%{http_code}' https://yukangclinic.cn/)"
AI_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o "$TMP_DIR/ai.html" -w '%{http_code}' https://yukangclinic.cn/ai.html)"
DLPAGE_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o "$TMP_DIR/download.html" -w '%{http_code}' https://yukangclinic.cn/download.html)"
CSS_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w '%{http_code}' https://yukangclinic.cn/gallery.css)"
WORKBENCH_CSS_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w '%{http_code}' https://yukangclinic.cn/workbench-preview.css)"
WORKBENCH_JS_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w '%{http_code}' https://yukangclinic.cn/workbench-preview.js)"
SCREEN_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w '%{http_code}' https://yukangclinic.cn/assets/screens/03-ai-assist.jpg)"
WWW_CODE="$(curl --resolve www.yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w '%{http_code}' https://www.yukangclinic.cn/)"
HTTP_CODE="$(curl --resolve yukangclinic.cn:80:127.0.0.1 -sS -o /dev/null -w '%{http_code}' http://yukangclinic.cn/)"
INSTALLER_HEAD_CODE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -I -o /dev/null -w '%{http_code}' https://yukangclinic.cn/downloads/$ASSET)"
INSTALLER_RANGE="$(curl --resolve yukangclinic.cn:443:127.0.0.1 -k -sS -o /dev/null -w 'status=%{http_code} bytes=%{size_download}' -r 0-1023 https://yukangclinic.cn/downloads/$ASSET)"

test "$ROOT_CODE" = '200'
test "$AI_CODE" = '200'
test "$DLPAGE_CODE" = '200'
test "$CSS_CODE" = '200'
test "$WORKBENCH_CSS_CODE" = '200'
test "$WORKBENCH_JS_CODE" = '200'
test "$SCREEN_CODE" = '200'
test "$WWW_CODE" = '200'
test "$HTTP_CODE" = '301'
test "$INSTALLER_HEAD_CODE" = '200'
test "$INSTALLER_RANGE" = 'status=206 bytes=1024'
grep -Fq '让每一次接诊，都有据可循' "$TMP_DIR/home.html"
grep -Fq 'AI 辅助诊疗' "$TMP_DIR/ai.html"
grep -Fq 'styles.css?v=20261117c' "$TMP_DIR/home.html"
grep -Fq 'script.js?v=20261117c' "$TMP_DIR/home.html"
grep -Fq 'site.css?v=20261117b' "$TMP_DIR/ai.html"
grep -Fq 'workbench-preview.css?v=20261117c' "$TMP_DIR/home.html"
grep -Fq 'workbench-preview.js?v=20261117c' "$TMP_DIR/home.html"
grep -Fq 'workbench-preview.css?v=20261117c' "$TMP_DIR/download.html"
grep -Fq 'workbench-preview.js?v=20261117c' "$TMP_DIR/download.html"
grep -Fq 'data-workbench-preview' "$TMP_DIR/home.html"
grep -Fq 'data-workbench-preview' "$TMP_DIR/download.html"
test -f "$DOWNLOAD_DIR/$ASSET"
SIZE="$(stat -c %s "$DOWNLOAD_DIR/$ASSET")"
ACTUAL_SHA="$(sha256sum "$DOWNLOAD_DIR/$ASSET" | awk '{print toupper($1)}')"
test "$SIZE" = "$EXPECTED_SIZE"
test "$ACTUAL_SHA" = "$EXPECTED_SHA"

echo "root_https=$ROOT_CODE"
echo "ai_https=$AI_CODE"
echo "download_page_https=$DLPAGE_CODE"
echo "gallery_css_https=$CSS_CODE"
echo "workbench_css_https=$WORKBENCH_CSS_CODE"
echo "workbench_js_https=$WORKBENCH_JS_CODE"
echo "ai_screenshot_https=$SCREEN_CODE"
echo "www_https=$WWW_CODE"
echo "root_http=$HTTP_CODE"
echo "installer_head=$INSTALLER_HEAD_CODE"
echo "installer_range=$INSTALLER_RANGE"
echo "installer_bytes=$SIZE"
echo "installer_sha256=$ACTUAL_SHA"

echo '__YK_RELEASE_NOTES__'
{
  echo "deployed_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit=$COMMIT"
  echo "release_dir=$RELEASE_DIR"
  echo "previous_release=$PREVIOUS_RELEASE"
  echo "root_https=$ROOT_CODE ai_https=$AI_CODE download_page_https=$DLPAGE_CODE"
  echo "workbench_css_https=$WORKBENCH_CSS_CODE workbench_js_https=$WORKBENCH_JS_CODE"
  echo "root_http=$HTTP_CODE www_https=$WWW_CODE"
  echo "installer_size=$SIZE"
  echo "installer_sha256=$ACTUAL_SHA"
  echo "installer_range=$INSTALLER_RANGE"
} | tee "$SHARED_DIR/last-deploy.txt"

SUCCESS=1
rm -rf "$TMP_DIR"
echo "__YK_DEPLOY_SUCCESS__ $RELEASE_TS"