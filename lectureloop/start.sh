#!/usr/bin/env bash
# LectureLoop 一键启动（macOS / Linux）。macOS 用户直接在访达里双击 start-mac.command 即可。
set -u
cd "$(dirname "$0")/app" || exit 1

pause() { [ -t 0 ] && read -r -p "按回车键退出…" _; }

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 20 或更新版本：https://nodejs.org/zh-cn/download"
  pause; exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"; then
  echo "Node.js 版本过低（当前 $(node -v)），需要 20 或更新版本：https://nodejs.org/zh-cn/download"
  pause; exit 1
fi
if [ ! -d node_modules/@anthropic-ai/sdk ]; then
  echo "首次运行：正在安装依赖（只需一次）…"
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "依赖安装失败，请检查网络后重试。"
    pause; exit 1
  fi
fi
echo "正在启动 LectureLoop…（浏览器会自动打开；关闭这个窗口即可停止）"
node server.js --open
pause
