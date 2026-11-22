#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[提示] 未检测到 Node.js！"
  echo "请先前往 https://nodejs.org 下载并安装 Node.js (LTS 20+ 版本) 后重试。"
  echo ""
  read -p "按回车键退出..."
  exit 1
fi

echo "========================================================"
echo "  ChartCopilot 正在启动（实时行情 + 自定义 API Key）"
echo "  访问地址：http://localhost:3456"
echo "  按 Ctrl+C 或关闭本窗口即可停止服务"
echo "========================================================"
echo ""

(sleep 1 && (open "http://localhost:3456" 2>/dev/null || xdg-open "http://localhost:3456" 2>/dev/null)) &
node server.js
