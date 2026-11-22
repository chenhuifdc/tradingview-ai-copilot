# ChartCopilot — 仿 TradingView 实时 K 线与 BYOK 人工智能副驾驶

基于零外部依赖的 Node.js + High-DPI HTML5 Canvas 构建，完整复刻 TradingView 专业看盘界面与 **AI Copilot 副驾驶**，支持使用您自己的 **DeepSeek / OpenAI / OpenRouter / 硅基流动 / 本地 Ollama** API Key，实现多市场实时行情搜索、AI 技术分析以及**截屏自动画线标注 + 实时 K 线坐标同步画线**。

## 核心功能

1. **多市场实时 K 线与股票搜索**
   - 点击左上角搜索框（或按 `/` 快捷键），支持输入**中文名、英文名或代码**搜索全球标的：
     - **加密货币**：Binance 实时 WebSocket 毫秒级推送（如 `BTCUSDT`、`ETHUSDT`、`SOLUSDT`）
     - **全球股票 / 指数 / 外汇**：通过 Yahoo Finance 实时拉取美股（`NVDA`、`AAPL`、`TSLA`）、印股 NSE（`ALKALI.NS`、`IRFC.NS`）、港股（`0700.HK`、`9988.HK`）、A 股（`600519.SS`、`300750.SZ`）、黄金（`GC=F`）及外汇汇率
     - **离线兜底**：当网络受限无法连接外部交易所时，自动切换至高仿真实时跳动行情引擎并在右上角明确提示 `模拟实时 SIM`
   - 内置 **成交量**、**MACD (10, 21, 9)** 可拖拽分屏副图、**EMA (20/50/200)**、**布林带**、**自动支撑阻力位 [Auto S&R]** 及手动趋势线/水平线/区间框/测距尺工具。

2. **BYOK 自定义 API Key 人工智能副驾驶**
   - 预设 **DeepSeek 官方**、**OpenAI 官方**、**OpenRouter**、**硅基流动 SiliconFlow**、**自定义 / Ollama** 一键配置，内置 **测试 API 连接** 按钮。
   - API Key 仅保存于浏览器本地 `localStorage`，服务端仅做无状态代理以规避跨域限制。
   - **纯文本 + 多模态双兼容**：
     - 使用 DeepSeek-V3 / DeepSeek-R1 时，自动提取精准可见 K 线 OHLCV、波段高低点与指标上下文，依然可在图表与截屏上实现像素级精准画线。
     - 使用 GPT-4o / Claude 3.7 / Gemini / Qwen-VL 等视觉模型时，可在设置中开启「多模态视觉识图」，同时将图表截屏图片发给 AI。
   - 未填写 API Key 时内置**量化分析演示引擎**，开箱即可完整体验截屏画线标注流程。

3. **截屏自动画线标注 + 截屏标注工作室**
   - 每次 AI 分析都会自动截取当前 K 线画面，并将 AI 识别出的：
     - **关键支撑位 / 压力水平线**（含强弱等级与右侧防重叠价格标签）
     - **上升 / 下降趋势线与延伸射线**
     - **技术形态**（收敛三角形、上升/下降通道、双底等半透明区域 + 突破目标箭头）
     - **信号标记**（`Bear Wick` / `Bull Wick` / 突破反转标签）
     - **进出场交易计划**（入场位、止损风险区、止盈目标区与盈亏比 `R:R`）
     同时绘制在 **AI 截屏标注图（高清 PNG）** 与 **实时交互 K 线图** 上。
   - 点击对话中的标注截屏即可进入**全屏截屏标注工作室**：支持「原始截屏 vs AI 标注图」前后对比、独立勾选图层、二次手绘箭头/直线/框选/文字备注，以及一键复制或下载高清 PNG。

4. **一键导出 TradingView Pine Script v5**
   - 将 AI 绘制的支撑阻力位、趋势线与进出场计划一键生成 Pine Script v5 脚本，可直接粘贴回真实 TradingView 图表。

## 本地运行方式

要求：Node.js `>= 20.0.0`（无需 `npm install`，零外部依赖）

```bash
cd tradingview-ai-copilot
node server.js
```

服务默认监听 `3456` 端口（可通过环境变量 `PORT=8080 node server.js` 修改）。

## 免费云端部署（任意电脑 / 手机打开网址即用）

项目已内置 [`render.yaml`](./render.yaml) 与 [`Dockerfile`](./Dockerfile)，零第三方依赖，构建时间约 10 秒：

### 推荐 A：Render 免费托管（最简单 · 一键部署）
- 👉 [点击一键部署到 Render (Deploy to Render)](https://render.com/deploy?repo=https://github.com/chenhuifdc/tradingview-ai-copilot)
1. 点击上方链接登录 [render.com](https://render.com)（可使用 GitHub 账号直接登录）。
2. Render 会自动识别仓库中的 `render.yaml`（`Free` 免费套餐，启动命令 `node server.js`，健康检查 `/api/health`）。
3. 点击 **Apply**，等待约 30 秒即可获得 `https://xxx.onrender.com` 专属公网网址。

### 推荐 B：Zeabur / Railway（支持 Docker 或 Node 自动识别）
1. 将代码推送到 GitHub 后，登录 [zeabur.com](https://zeabur.com) 或 [railway.app](https://railway.app)。
2. 选择 **Deploy from GitHub Repo**，平台会自动检测 `Dockerfile` 或 `package.json`，生成公网 HTTPS 域名后即可在任意电脑/手机打开使用。

> 安全提示：您填入的 DeepSeek / OpenAI / OpenRouter API Key 仅保存在**各自设备浏览器本地 `localStorage`**，云端服务端不保存任何密钥。


## 自动化测试与无头浏览器验证

本项目保持**零第三方 npm 依赖**，所有单元测试均基于 Node.js 内置 `node:test` 运行，无头浏览器验证脚本位于 `test/browser/`：

```bash
# 运行全部 Node.js 单元测试（安全加固、缓存/单飞、重试/熔断/降级、LWC 适配层、M2/M2.1 规则引擎）
npm test

# 运行无头 Chromium 浏览器端到端验证（XSS 防护、状态徽标与水印、Lightweight Charts 渲染与 IST 时区）
# 如环境未安装 Chromium/Chrome，脚本会输出明确提示并自动跳过（退出码 0）。
# 可通过 CHROMIUM_BIN=/path/to/chromium 指定浏览器可执行文件，或 SCREENSHOT_DIR=/path/to/dir 保存截图。
npm run test:browser
```
