#!/usr/bin/env bash
# 智慧云诊所 - macOS double-clickable launcher.
# Wraps start.sh and keeps the Terminal window open on exit.

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
chmod +x start.sh start.command 2>/dev/null || true
bash ./start.sh

echo ""
echo "智慧云诊所 has stopped. You can close this window now."
read -rp "Press Enter to close..."
