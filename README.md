# ChartCopilot — 轻量级印度股市（NSE/BSE）实时 K 线与 BYOK AI 副驾驶

基于**零第三方 npm 依赖**的 Node.js 服务端 + **TradingView Lightweight Charts v5.2.1**（单文件置于 `public/vendor/` 并附 SHA-256 校验）构建。用户只需填入自己的云端模型 API Key（BYOK），即可拉取印度股市（默认 NSE `.NS`，自动回退 BSE `.BO`；货币 `₹`；按 IST 时区推算最新交易日）及加密货币实时 K 线，由 AI 输出严格校验的四段式研判报告与像素级精确对齐的带标注图片，并支持浏览器内批量生成打包下载。

## 核心功能

1. **多市场行情、缓存容错与实时断线恢复（M1 / M6）**
   - 印度股市默认 NSE（`.NS`），NSE 缺失自动回退 BSE（`.BO`），最新交易日按 IST（`Asia/Kolkata`）由最新 K 线时间戳推导。
   - 服务端内置 LRU+TTL 分级缓存、请求合并（single-flight）、指数退避重试与熔断器（`server/cache.js`、`server/marketService.js`）。
   - 实时流（`public/js/realtimeStream.js`）：基于 `series.update()` 增量更新；WebSocket 指数退避加随机抖动重连与 Binance 23.5 小时主动无感换连；断线/页面切回可见后自动补拉缺失区间并按时间戳合并去重；规则引擎与 AI 不随 tick 重跑。

2. **确定性技术形态引擎与原生 Series Primitive 标注（M2 / M3）**
   - `public/js/patternEngine.js` 提供纯数学候选识别（支撑/阻力位、趋势线、通道/三角形/双底双顶、震荡箱体、MACD/RSI 背离），非饱和评分并支持数据版本缓存。
   - `public/js/lwcAnnotationPrimitive.js` 基于 Lightweight Charts v5.2.1 原生 `ISeriesPrimitive` 直接绑定主图序列绘制标注（`<= 0.5px` 像素对齐），缩放/平移/主题切换自动重绘。

3. **BYOK 结构化 JSON AI 管线与安全防护（M4）**
   - `public/js/m4Pipeline.js` 组装日线+周线、真实可用均线周期、MACD/量比/ATR 与 M2 候选 ID；外部行业/新闻经清洗与定界符隔离防提示词注入。
   - 模型仅返回 JSON（`{fundamentals_sentence, technical_sentence, support_id, resistance_id, advice, annotation_ids}`），代码替换 `{SUPPORT}`/`{RESISTANCE}` 占位符并拼装严格四段式中文报告；内置禁词、字数/句号、数字溯源、均线周期、价格一致性校验与最多 2 次自动重试，失败自动回退本地确定性模板。
   - 模拟数据默认禁止 AI 分析，开启「演示模式」开关后才允许运行，声明仅显示于横幅与水印，不进入可复制文本。

4. **1600×900 @ 2× DPR 浅色导出与批量生成（M5 / M7）**
   - `public/js/screenshotAnnotator.js` 配合 `LwcChartEngine.captureExportSnapshot` 生成固定 `1600×900`（`3200×1800` 物理像素）浅色主题带标注 PNG（含股票/交易所/IST 时间/INR 口径标题栏与英文图例底栏）。
   - 浏览器内批量页面（`/batch.html`，`public/js/batchRunner.js` + `public/js/zipBuilder.js`）：支持并发/限速配置、单只容错、断点续跑、`simulated` 自动跳过，并零依赖打包下载 `PNG + 报告文本 + manifest.json` ZIP 压缩包。

## 本地运行方式

要求：Node.js `>= 20.0.0`（无需 `npm install`，零外部依赖）

```bash
cd tradingview-ai-copilot
node server.js
```

服务默认监听 `127.0.0.1:3456`（容器部署可通过 `HOST=0.0.0.0 PORT=3456` 覆盖）。打开 `http://127.0.0.1:3456/` 进入主图表，打开 `/batch.html` 进入批量生成页面。

## 自动化测试与无头浏览器验证

本项目保持**零第三方 npm 依赖**，单元测试基于 Node.js 内置 `node:test`，无头浏览器端到端验证位于 `test/browser/`：

```bash
# 串行运行全部 Node.js 单元测试与 7 项无头 Chromium 端到端验证
npm test && npm run test:browser
```

## 安全注意事项：`standalone_单文件版.html`

> **警告**：仓库中的 `standalone_单文件版.html` 来自旧版本，**未包含第 0 步的 XSS 转义与渲染安全修复**，存在已知的 XSS 缺口，且不包含服务端 SSRF 代理与缓存容错能力。在 M8 最终决定其去留（重建或废弃）之前，**请勿对外分发或在生产环境使用该单文件**。


