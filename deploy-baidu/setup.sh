#!/usr/bin/env bash
# ============================================
# 百度云服务器 采集环境初始化（一次性执行）
# 用法: ssh root@服务器IP 后执行
#   bash <(curl -s ...)  或 上传本目录后 bash setup.sh
# ============================================
set -euo pipefail

APP_DIR=/opt/kaogong

echo "[1/5] 检查 Node.js（爬虫依赖 node:sqlite，必须 >= 22.13）"
if command -v node >/dev/null 2>&1; then
  echo "   已安装 Node $(node -v)"
else
  echo "   安装 Node 22 LTS（nodesource）..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('select 1');console.log('   node:sqlite OK, node '+process.version)" || {
  echo "[错误] node:sqlite 不可用。请确认是 Node 22.13+，低于此版本会崩。"
  exit 1
}

echo "[2/5] 准备应用目录 $APP_DIR"
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ -f server.mjs ]; then
  echo "   目录已有代码，跳过拉取（如需重新拉取: cd $APP_DIR && git pull）"
else
  echo "   拉取仓库..."
  git clone --depth 1 https://github.com/cxandy/kaogong-shuati.git .
fi

echo "[3/5] 准备 cookie.txt（粉笔登录 Cookie，采集必需）"
if [ -f cookie.txt ]; then
  echo "   cookie.txt 已存在（$(wc -c < cookie.txt) 字节）"
else
  echo "   ⚠️ 请把本机 cookie.txt 上传到此服务器 $APP_DIR/cookie.txt"
  echo "     采集脚本会读取它；Cookie 过期后需重新上传更新"
fi

echo "[4/5] 试跑验证（仅爬第 1 套，验证链路）"
node zhejiang-crawler.mjs --only=行测 --limit=1 || echo "   ⚠️ 试跑失败，请检查 cookie 是否有效（403/429 视作风控触发）"

echo "[5/5] 完成。启用定时采集："
echo "   crontab -e  并加入 deploy-baidu/crontab.example 中的那一行"