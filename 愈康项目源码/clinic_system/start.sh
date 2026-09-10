#!/bin/bash
# 智慧云诊所 - Linux/Mac 一键启动脚本
cd "$(dirname "$0")"
export YUKONG_APP_DIR="$(pwd)"

echo "╔══════════════════════════════════════╗"
echo "║     智慧云诊所管理系统 - 一键启动     ║"
echo "╚══════════════════════════════════════╝"
echo

# 1. 检查 Node.js
echo "[1/4] 检查 Node.js..."
if ! command -v node &>/dev/null; then
    echo "  ✘ 未检测到 Node.js，请先安装: https://nodejs.org"
    exit 1
fi
echo "  ✓ Node.js: $(node -v)"
echo

# 2. 安装依赖
echo "[2/4] 检查依赖..."
if [ ! -d "node_modules/express" ]; then
    echo "  首次运行，安装依赖..."
    if [ ! -f "package.json" ]; then
        echo '{"name":"clinic_system","version":"1.0.0","dependencies":{"express":"^4.18.2","cors":"^2.8.5"}}' > package.json
    fi
    npm install express cors
    echo "  ✓ 依赖安装完成"
else
    echo "  ✓ 依赖已就绪"
fi
echo

# 3. 数据目录
echo "[3/4] 初始化数据目录..."
mkdir -p clinic_database
echo "  ✓ clinic_database/ 已就绪"
echo

# 4. 启动
echo "[4/4] 启动服务..."
echo "  地址: http://localhost:3002"
echo "  按 Ctrl+C 停止"
echo

node --disable-warning=ExperimentalWarning server.js
