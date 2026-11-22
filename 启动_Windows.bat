@echo off
chcp 65001 >nul
title ChartCopilot — TradingView 风格实时 K 线与 AI 副驾驶
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo [提示] 未检测到 Node.js！
  echo 请先前往 https://nodejs.org 下载并安装 Node.js (LTS 20+ 版本)，安装后重新双击本脚本。
  echo.
  pause
  exit /b 1
)

echo ========================================================
echo   ChartCopilot 正在启动（实时行情 + 自定义 API Key）
echo   浏览器将自动打开：http://localhost:3456
echo   关闭本窗口即可停止服务
echo ========================================================
echo.

start "" "http://localhost:3456"
node server.js
pause
