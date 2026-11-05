@echo off
chcp 65001 >nul
rem LectureLoop 一键启动（Windows）：双击本文件即可
cd /d "%~dp0app"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 20 或更新版本：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过低，需要 20 或更新版本：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
if not exist "node_modules\@anthropic-ai\sdk" (
  echo 首次运行：正在安装依赖，只需一次……
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
echo 正在启动 LectureLoop……浏览器会自动打开；关闭这个窗口即可停止
node server.js --open
pause
