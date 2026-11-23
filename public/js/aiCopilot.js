/**
 * BYOK AI Copilot Engine.
 * - Supports DeepSeek, OpenAI, OpenRouter, SiliconFlow, Ollama/LM Studio, and any OpenAI-compatible API.
 * - API keys are stored strictly in the user's browser localStorage.
 * - Combines quantitative OHLCV + Pivot + Indicator grounding with optional Vision chart screenshot input.
 * - Maps returned annotations to global candle coordinates and triggers both live chart drawing
 *   and annotated PNG screenshot rendering.
 */

import { formatPrice, formatTimeLabel } from './indicators.js';
import {
  extractChartContext,
  runLocalQuantitativeAnalysis
} from './localAnalyzer.js';
import { buildAnnotationsFromPatternEngine } from './lwcAnnotationPrimitive.js';
import { renderAnnotatedScreenshot, downloadDataUrl } from './screenshotAnnotator.js';
import { getLangPack, getLangMeta } from './i18n.js';
import { escapeHtml, sanitizeImageDataUrl, renderSafeMarkdown } from './sanitize.js';
import { runM4Pipeline } from './m4Pipeline.js';

const STORAGE_KEY = 'chartcopilot_ai_settings_v1';

export const PROVIDER_PRESETS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultVision: false,
    allowLocal: false,
    note: 'DeepSeek V3/R1 官方接口，性价比极高（纯文本模型请保持“视觉识图”关闭，系统将自动发送精准 K 线数据并在截屏上自动画线）'
  },
  openai: {
    id: 'openai',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    defaultVision: true,
    allowLocal: false,
    note: '支持多模态视觉识图（GPT-4o 可同时读取 K 线截屏图片与精确 OHLCV 数据）'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter 聚合',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat-v3-0324',
    models: [
      'deepseek/deepseek-chat-v3-0324',
      'openai/gpt-4o',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.5-pro-preview'
    ],
    defaultVision: false,
    allowLocal: false,
    note: '一个 Key 调用 DeepSeek / GPT-4o / Claude / Gemini 全部主流模型'
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-VL-72B-Instruct'
    ],
    defaultVision: false,
    allowLocal: false,
    note: '国内高速直连 DeepSeek V3/R1 与通义千问 Qwen2.5-VL 视觉模型'
  },
  ollama: {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:14b',
    models: ['qwen2.5:14b', 'deepseek-r1:14b', 'llama3.2-vision'],
    defaultVision: false,
    allowLocal: true,
    note: '仅允许连接本地回环地址 (127.0.0.1 / localhost) 的 Ollama 或 LM Studio 服务'
  },
  custom: {
    id: 'custom',
    name: '自定义 HTTPS',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'gpt-4o', 'claude-3-7-sonnet'],
    defaultVision: false,
    allowLocal: false,
    note: '兼容任意公网 HTTPS OpenAI 格式接口（出于安全限制禁止访问内网地址）'
  }
};

export function loadAISettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        provider: parsed.provider || 'deepseek',
        apiKey: parsed.apiKey || '',
        baseUrl: parsed.baseUrl || PROVIDER_PRESETS.deepseek.baseUrl,
        model: parsed.model || PROVIDER_PRESETS.deepseek.defaultModel,
        enableVision: Boolean(parsed.enableVision),
        demoMode: Boolean(parsed.demoMode)
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    model: PROVIDER_PRESETS.deepseek.defaultModel,
    enableVision: false,
    demoMode: false
  };
}

export function saveAISettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

export function formatAgeDelay(ageMs = 0) {
  const sec = Math.max(0, Math.round(Number(ageMs || 0) / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}分${remSec}秒` : `${min}分钟`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}小时${remMin}分` : `${hr}小时`;
}

export function formatCutoffTimestamp(meta, fallbackTimeSec = null) {
  const tz = meta?.exchangeTimezone || 'Asia/Kolkata';
  const tzLabel = meta?.timezone || (tz === 'Asia/Kolkata' ? 'IST' : 'UTC');
  const rawMs = Number.isFinite(meta?.latestBarTime) && meta.latestBarTime > 0
    ? meta.latestBarTime * 1000
    : Number.isFinite(fallbackTimeSec) && fallbackTimeSec > 0
      ? fallbackTimeSec * 1000
      : Number.isFinite(meta?.fetchedAt) && meta.fetchedAt > 0
        ? meta.fetchedAt
        : Date.now();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(new Date(rawMs));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} ${tzLabel}`;
  } catch {
    return `${new Date(rawMs).toISOString().replace('T', ' ').slice(0, 19)} ${tzLabel}`;
  }
}

export function formatShortCutoffTime(meta) {
  const full = formatCutoffTimestamp(meta);
  const m = full.match(/^\d{4}-(\d{2}-\d{2})\s+(\d{2}:\d{2}):\d{2}\s+(.+)$/);
  if (m) return `${m[2]} ${m[3]}`;
  return full;
}

export function formatFeedStatusDisplay(meta, fallbackSource = 'live', feedName = '') {
  const source = meta?.source || fallbackSource || 'live';
  const stale = Boolean(meta?.stale);
  const provider = meta?.provider || feedName || source;
  const exchange = meta?.exchange || '';
  const resolvedSym = meta?.resolvedSymbol || '';
  const exchangeFallback = Boolean(meta?.exchangeFallback);
  const exBadgeSuffix = exchange
    ? (exchangeFallback ? ` · ${exchange}(回退)` : ` · ${exchange}`)
    : '';

  if (source === 'simulated') {
    return {
      source: 'simulated',
      stale: false,
      exchange,
      resolvedSymbol: resolvedSym,
      badgeClass: 'live-badge status-sim',
      hudClass: 'hud-data-status status-sim',
      badgeText: '模拟数据',
      hudText: '模拟演示数据 (非真实行情)',
      tooltip: `当前为离线模拟演示数据 (${provider})`,
      showSimWatermark: true
    };
  }

  if (source === 'cache' || stale) {
    const shortTime = formatShortCutoffTime(meta);
    const fullCutoff = formatCutoffTimestamp(meta);
    const ageStr = formatAgeDelay(meta?.ageMs || 0);
    const tag = stale ? '缓存(陈旧)' : '缓存';
    const hudTag = stale ? '缓存降级(陈旧)' : '缓存行情';
    return {
      source: 'cache',
      stale,
      exchange,
      resolvedSymbol: resolvedSym,
      badgeClass: stale ? 'live-badge status-cache-stale' : 'live-badge status-cache',
      hudClass: stale ? 'hud-data-status status-cache-stale' : 'hud-data-status status-cache',
      badgeText: `${tag}${exBadgeSuffix} · ${shortTime} (延迟 ${ageStr})`,
      hudText: `${hudTag}${exBadgeSuffix} · 数据时间 ${shortTime} · 延迟 ${ageStr}`,
      tooltip: `${hudTag}${exBadgeSuffix}${resolvedSym ? ` (${resolvedSym})` : ''} | 数据截至: ${fullCutoff} | 延迟: ${ageStr} | 来源: ${provider}`,
      showSimWatermark: false
    };
  }

  const shortTime = formatShortCutoffTime(meta);
  const fullCutoff = formatCutoffTimestamp(meta);
  return {
    source: 'live',
    stale: false,
    exchange,
    resolvedSymbol: resolvedSym,
    badgeClass: 'live-badge status-live',
    hudClass: 'hud-data-status status-live',
    badgeText: exchangeFallback ? `实时行情 · ${exchange}(回退)` : (exchange ? `实时行情 · ${exchange}` : '实时行情'),
    hudText: `实时${exBadgeSuffix} · ${shortTime}`,
    tooltip: `实时行情${exBadgeSuffix}${resolvedSym ? ` (${resolvedSym})` : ''} | 数据时间: ${fullCutoff} | 来源: ${provider}`,
    showSimWatermark: false
  };
}

export function buildDataStatusPromptSection(meta, interval = '1d', fallbackTimeSec = null) {
  const source = meta?.source || 'live';
  const stale = Boolean(meta?.stale);
  const cutoffStr = formatCutoffTimestamp(meta, fallbackTimeSec);
  const ageStr = formatAgeDelay(meta?.ageMs || 0);
  const exchange = meta?.exchange || '';
  const resolvedSym = meta?.resolvedSymbol || '';
  const exInfo = exchange
    ? ` ｜ 实际交易所：${exchange}${resolvedSym ? ` (${resolvedSym})` : ''}${meta?.exchangeFallback ? ' [由 NSE 自动回退]' : ''}`
    : '';

  if (source === 'simulated') {
    return `【行情数据状态提示】当前行情为离线模拟演示数据（source=simulated${exInfo} ｜ 周期：${interval} ｜ 生成时间：${cutoffStr}）。`;
  }
  if (source === 'cache' || stale) {
    return `【行情数据状态提示】当前行情来自${stale ? '已陈旧缓存降级' : '缓存'}（source=cache, stale=${stale}${exInfo} ｜ 数据截至时间：${cutoffStr} ｜ 周期：${interval} ｜ 缓存延迟：${ageStr}）。请务必基于该数据截至时间（${cutoffStr}）与周期（${interval}）进行客观研判。`;
  }
  return `【行情数据状态提示】当前行情为实时数据（source=live${exInfo} ｜ 数据截至时间：${cutoffStr} ｜ 周期：${interval}）。`;
}

export function applyDataStatusToReport(reportText, meta, interval = '1d', fallbackTimeSec = null) {
  const clean = String(reportText || '').trim();
  if (!meta) return clean;
  const source = meta.source || 'live';
  const stale = Boolean(meta.stale);
  const exchange = meta.exchange || '';
  const resolvedSym = meta.resolvedSymbol || '';
  const exText = exchange
    ? `（交易所：${exchange}${resolvedSym ? ` / ${resolvedSym}` : ''}${meta.exchangeFallback ? '，由 NSE 自动回退' : ''}）`
    : '';

  if (source === 'simulated') {
    return clean;
  }

  if (source === 'cache' || stale) {
    const cutoffStr = formatCutoffTimestamp(meta, fallbackTimeSec);
    const ageStr = formatAgeDelay(meta.ageMs || 0);
    const label = stale ? '已陈旧缓存' : '缓存';
    const cacheHeader = `【数据状态提示：当前基于${label}数据${exText}，数据截至时间 ${cutoffStr}，周期 ${interval}，延迟 ${ageStr}】`;
    if (clean.startsWith('【数据状态提示：')) return clean;
    return `${cacheHeader}\n\n${clean}`;
  }

  if (meta.exchangeFallback && exchange) {
    const fallbackHeader = `【数据状态提示：NSE 未找到该标的，当前已自动回退至 ${exchange} 交易所（${resolvedSym || exchange}）】`;
    if (clean.startsWith('【数据状态提示：')) return clean;
    return `${fallbackHeader}\n\n${clean}`;
  }

  return clean;
}

export function buildLLMMessages(ctx, userPrompt, cleanScreenshotDataUrl, enableVision, chartLang = 'zh-CN', dataMeta = null) {
  const { candles, instrument, interval, precision, latest, indicators, fundamentals } = ctx;
  const effectiveMeta = dataMeta || ctx.dataMeta || fundamentals?.meta || null;
  const N = candles.length;
  const targetLangName = getLangMeta(chartLang).llmName;

  // Compact OHLCV table (keep up to last 100 bars for token efficiency & precision)
  const stride = N > 105 ? 2 : 1;
  const rows = [];
  for (let i = 0; i < N; i += stride) {
    const c = candles[i];
    rows.push(
      `${i}|${formatTimeLabel(c.time, interval, true)}|O:${formatPrice(c.open, precision)} H:${formatPrice(c.high, precision)} L:${formatPrice(c.low, precision)} C:${formatPrice(c.close, precision)} V:${Math.round(c.volume)}`
    );
  }
  if ((N - 1) % stride !== 0) {
    const c = candles[N - 1];
    rows.push(
      `${N - 1}|${formatTimeLabel(c.time, interval, true)}|O:${formatPrice(c.open, precision)} H:${formatPrice(c.high, precision)} L:${formatPrice(c.low, precision)} C:${formatPrice(c.close, precision)} V:${Math.round(c.volume)}`
    );
  }

  const pivotHighStr = ctx.pivots.highs
    .slice(-8)
    .map((p) => `[idx:${p.index}, price:${formatPrice(p.price, precision)}]`)
    .join(', ');
  const pivotLowStr = ctx.pivots.lows
    .slice(-8)
    .map((p) => `[idx:${p.index}, price:${formatPrice(p.price, precision)}]`)
    .join(', ');

  const newsLines = (fundamentals?.headlines || [])
    .map((h) => `- ${h.pubDate ? `[${h.pubDate}] ` : ''}${h.title}`)
    .join('\n');
  const dailyResStr = (fundamentals?.dailySR?.resistances || []).map((v) => formatPrice(v, precision)).join(', ');
  const dailySupStr = (fundamentals?.dailySR?.supports || []).map((v) => formatPrice(v, precision)).join(', ');

  const systemPrompt = `# 角色定位
你是一位顶级且务实的金融分析师，精通印度股市（NSE/BSE）及全球主要市场的个股基本面、最新消息面与技术面综合研判。你能用极度精简、毫无废话的专业语言，提供直接可复制的高质量分析报告，并同步输出精准的走势图画线坐标。

# 核心任务
根据当前输入的个股代码或公司名字，进行多维度综合评估：
1. 在 JSON 字段 "reportText" 中，严格按照下方【工作流与输出格式】生成可直接复制的分析报告；
2. 在 JSON 字段 "annotations" 中，精确输出与分析报告完全对应的支撑位、压力位（阻力位）、趋势线与技术形态坐标，系统将在实时 K 线走势图与截屏图上自动画出。

# 绝对刚性红线（若有违反，直接判定为失败）
1. 严禁输出搜索痕迹：你必须充分利用下方提供的最新交易日基本面、消息面、股价、支撑阻力位及均线指标状态进行综合研判；但是，严格禁止将任何联网搜索过程、思考路径、原生数据、抓取链接、URL 或系统提示字符输出在 "reportText" 中。
2. 字数硬熔断："reportText" 中【基本面与消息面】和【技术面】两部分，必须各自仅用一句话完成输出，且每部分的字数严格 <= 150 字。严禁使用长难句拼凑字数。
3. 禁止给出买卖指令：操作建议必须保持绝对的客观与中立，只给出切实可行的风险提示、企稳信号、止损观察点或仓位调整警示，绝对禁止出现任何明确的“买入”、“卖出”、“建仓”、“建立仓位”、“做多”、“做空”、“抄底”等直白投资建议；且 "tradePlan" 必须返回 null。
4. 绝对禁止在 "reportText" 中输出任何多余的系统提示、横杠（---）、列表符号（- / * / #）、Markdown 粗体或前后寒暄，输出结果必须干净整洁，直接可供复制。

# 动态分析指标约束
1. 均线与指标解耦：技术面分析时，必须根据下方该个股当前真实的、最显著的均线交织状态（如 MA5 / MA10 / MA20 / MA50 / MA200 或 EMA5 / EMA10 / EMA20 / EMA50 / EMA200）和真实形态进行动态描述，严禁盲目、僵硬地套用范例中的“MA20”或“下降通道”。
2. 支撑阻力位时效：给出的支撑位与阻力位数字，必须是基于当前最新交易日的【日线或周线级别（Daily/Weekly）】最核心的波段供求锁定区价格。
3. 图文 100% 严格对应："annotations.horizontalLevels" 中画出的支撑位与阻力位价格必须与 "reportText" 中“支撑位：”和“阻力位：”给出的数字完全一致；"annotations.patterns" 与 "annotations.trendlines" 必须准确画出 "reportText" 技术面分析中提到的技术形态！

# "reportText" 严格五部分输出格式
每部分之间【有且仅有一行空行】（即 \\n\\n），其中“支撑位：”与“阻力位：”紧邻换行，严禁产生其他多余空行。下方 [股票简称] 必须替换为当前个股简称：

[股票简称]是[简述行业地位与核心财务状况]。但受[点出当前相关重要消息面或宏观经济公告的影响]，公司基本面[简述韧性或短期消息面定性]。

技术面来看，[描述当前K线图的主要形态、均线、MACD、成交量等指标的综合趋势走向，一句话150字内简短说明]。

支撑位： [输出具体价格数字]
阻力位： [输出具体价格数字]

操作建议：[根据以上信息提出详细合理切实的风险观察建议。重点阐述企稳信号、止损观察点或仓位调整警示，不给买卖指令]。

# 返回 JSON Schema（只返回一个合法 JSON 对象，图表标签语言使用 ${targetLangName}）
{
  "bias": "bullish" | "bearish" | "neutral",
  "confidence": 0-100 的整数,
  "summary": "简明一句话摘要（如：碱金属有限公司｜支撑 73.98 · 阻力 89.60）",
  "reportText": "严格遵守上述五部分格式与全部刚性红线的纯文本报告（无任何Markdown符号、无链接、无搜索痕迹）",
  "annotations": {
    "horizontalLevels": [
      {
        "id": "sr1",
        "type": "support" | "resistance",
        "price": 与 reportText 中支撑位/阻力位完全一致的数值,
        "startIndex": 整数（0 到 ${N - 1}）,
        "endIndex": ${N - 1},
        "strength": "strong" | "medium",
        "label": "支撑位 / 阻力位（使用 ${targetLangName}）"
      }
    ],
    "trendlines": [
      {
        "id": "tl1",
        "type": "uptrend" | "downtrend" | "channel",
        "startIndex": 整数（0 到 ${N - 1}）,
        "startPrice": 数值（精确锚定起点波段高点或低点）,
        "endIndex": 整数（必须大于 startIndex）,
        "endPrice": 数值（精确锚定第二个波段高点或低点）,
        "extendRight": true,
        "label": "趋势线名称（使用 ${targetLangName}）"
      }
    ],
    "patterns": [
      {
        "id": "pat1",
        "name": "与 reportText 技术面一致的形态名称（如：双底结构 / 下降通道 / 上升通道 / 对称三角形 / 箱体震荡 / 下降楔形）",
        "bias": "bullish" | "bearish" | "neutral",
        "points": [
          { "index": 整数, "price": 数值 },
          { "index": 整数, "price": 数值 },
          { "index": 整数, "price": 数值 },
          { "index": 整数, "price": 数值 }
        ],
        "upperLine": { "startIndex": 整数, "startPrice": 数值, "endIndex": 整数, "endPrice": 数值 },
        "lowerLine": { "startIndex": 整数, "startPrice": 数值, "endIndex": 整数, "endPrice": 数值 },
        "breakoutTarget": 关键观察目标价数值,
        "label": "形态名称（与 reportText 保持一致）"
      }
    ],
    "signals": [
      {
        "id": "sig1",
        "index": 整数（0 到 ${N - 1}）,
        "price": 数值,
        "kind": "bull_wick" | "bear_wick" | "breakout" | "breakdown" | "reversal",
        "label": "简短信号标签（使用 ${targetLangName}）"
      }
    ],
    "tradePlan": null
  }
}`;

  const statusPromptLine = buildDataStatusPromptSection(effectiveMeta, interval, latest?.time);

  const dataContext = `${statusPromptLine}

【当前分析标的（仅供内部分析，严禁原样输出原始抓取信息或链接）】
股票简称：${instrument.name}（代码：${instrument.symbol} ｜ 交易所：${effectiveMeta?.exchange || instrument.exchange} ｜ 币种：${instrument.currency || fundamentals?.currency || ''}）
英文名：${fundamentals?.enName || instrument.enName || instrument.displaySymbol}
行业板块：${fundamentals?.sector || '未知'} / ${fundamentals?.industry || '未知'}
最新交易日：${effectiveMeta?.latestTradingDay || fundamentals?.latestDate || formatTimeLabel(latest.time, interval, true)} ｜ 当前图表周期：${interval}
最新收盘价：${formatPrice(latest.close, precision)}（涨跌 ${ctx.changePct >= 0 ? '+' : ''}${ctx.changePct.toFixed(2)}%）
52周区间：低 ${formatPrice(fundamentals?.low52w, precision)} — 高 ${formatPrice(fundamentals?.high52w, precision)}
可见区间：低 ${formatPrice(ctx.periodLow, precision)} (idx=${ctx.lowIdx}) — 高 ${formatPrice(ctx.periodHigh, precision)} (idx=${ctx.highIdx})

【最新资讯与公告标题参考（严禁在回复中泄露抓取痕迹、来源名或网址）】
${newsLines || '暂无特别重大突发公告，请结合其所属行业景气周期、市场流动性与近期价格走势客观研判。'}

【日线级别核心供求参考位 (Daily S&R)】
- 日线支撑参考区：${dailySupStr || '参考下方波段低点'}
- 日线阻力参考区：${dailyResStr || '参考下方波段高点'}

【当前实时均线与动量指标（请据此动态选择最显著均线描述，禁止僵硬套用）】
- MA5: ${formatPrice(indicators.ma5, precision)} | MA10: ${formatPrice(indicators.ma10, precision)} | MA20: ${formatPrice(indicators.ma20, precision)} | MA50: ${formatPrice(indicators.ma50, precision)} | MA200: ${formatPrice(indicators.ma200, precision)}
- EMA5: ${formatPrice(indicators.ema5, precision)} | EMA10: ${formatPrice(indicators.ema10, precision)} | EMA20: ${formatPrice(indicators.ema20, precision)} | EMA50: ${formatPrice(indicators.ema50, precision)} | EMA200: ${formatPrice(indicators.ema200, precision)}
- 当前图表面板勾选的 EMA 周期：${(ctx.activeEmaPeriods || [5, 10, 20]).join(', ')}
- MACD(10,21,9): DIF=${indicators.macdVal?.toFixed(3) ?? 'N/A'}, DEA=${indicators.macdSig?.toFixed(3) ?? 'N/A'}, Hist=${indicators.macdHist?.toFixed(3) ?? 'N/A'}（前一根 Hist=${indicators.prevHist?.toFixed(3) ?? 'N/A'}）
- RSI(14): ${indicators.rsi?.toFixed(1) ?? 'N/A'} | 成交量相对20日均量比：${(indicators.volRatio || 1).toFixed(2)}x | ATR(14): ${formatPrice(indicators.atr, precision)}

【算法预检测的波段高低点参考（局部索引 0..${N - 1}）】
- 波段高点 (Swing Highs): ${pivotHighStr || '无'}
- 波段低点 (Swing Lows): ${pivotLowStr || '无'}

【可见 K 线 OHLCV 序列 (idx|时间|O H L C V)】
${rows.join('\n')}

【用户附加指令】
${userPrompt}`;

  if (enableVision && cleanScreenshotDataUrl) {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: dataContext },
          {
            type: 'image_url',
            image_url: { url: cleanScreenshotDataUrl, detail: 'high' }
          }
        ]
      }
    ];
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: dataContext }
  ];
}

/**
 * Strip accidental markdown symbols, URLs, search traces, and extra blank lines
 * so the final 5-part report is strictly clean and copy-ready.
 */
function sanitizeStrictReportText(rawText) {
  const txt = String(rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();

  const cleanedLines = txt
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*[-*•]\s+/, '')
        .replace(/^\s*[-_=*]{3,}\s*$/, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim()
    );

  const out = [];
  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i];
    if (!line) {
      const prev = out[out.length - 1] || '';
      const next = cleanedLines.slice(i + 1).find((l) => l.length > 0) || '';
      if (/^支撑位[：:]/.test(prev) && /^阻力位[：:]/.test(next)) continue;
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}

function extractNumbersFromLine(line, minBound, maxBound) {
  const nums = [];
  const clean = String(line || '').replace(/,/g, '');
  const matches = clean.match(/\d+(?:\.\d+)?/g) || [];
  for (const m of matches) {
    const v = parseFloat(m);
    if (Number.isFinite(v) && v >= minBound && v <= maxBound) {
      nums.push(v);
    }
  }
  return [...new Set(nums)];
}

function detectPatternNameFromText(text) {
  const patterns = [
    '上升通道', '下降通道', '下降楔形', '上升楔形',
    '对称三角形', '上升三角形', '下降三角形', '收敛三角形', '三角形整理',
    '双底结构', '双底', 'W底', '双顶结构', '双顶', 'M头',
    '头肩底', '头肩顶', '箱体震荡', '箱体整理', '矩形整理',
    '圆弧底', '杯柄形态', '旗形整理', '突破回踩'
  ];
  for (const name of patterns) {
    if (String(text || '').includes(name)) return name;
  }
  return null;
}

/**
 * Guarantee 100% synchronization between the prices/pattern written in reportText
 * and the horizontalLevels / patterns / trendlines drawn on the live chart & screenshot!
 */
function syncAnnotationsWithReport(rawAnn, reportText, ctx, chartLang = 'zh-CN') {
  const { precision, periodLow, periodHigh, visibleCount } = ctx;
  const N = visibleCount;
  const span = Math.max(periodHigh - periodLow, ctx.latest.close * 0.08);
  const minAllowed = Math.max(0.0001, periodLow - span * 0.9);
  const maxAllowed = periodHigh + span * 0.9;
  const C = getLangPack(chartLang).chart;

  const ann = rawAnn && typeof rawAnn === 'object'
    ? {
        horizontalLevels: Array.isArray(rawAnn.horizontalLevels) ? [...rawAnn.horizontalLevels] : [],
        trendlines: Array.isArray(rawAnn.trendlines) ? [...rawAnn.trendlines] : [],
        patterns: Array.isArray(rawAnn.patterns) ? [...rawAnn.patterns] : [],
        signals: Array.isArray(rawAnn.signals) ? [...rawAnn.signals] : [],
        tradePlan: null
      }
    : { horizontalLevels: [], trendlines: [], patterns: [], signals: [], tradePlan: null };

  // 1) Parse exact 支撑位 & 阻力位 prices directly from reportText
  const supLine = (reportText.match(/支撑位[：:]\s*([^\n]+)/) || [])[1] || '';
  const resLine = (reportText.match(/阻力位[：:]\s*([^\n]+)/) || [])[1] || '';
  const parsedSupports = extractNumbersFromLine(supLine, minAllowed, maxAllowed);
  const parsedResistances = extractNumbersFromLine(resLine, minAllowed, maxAllowed);

  if (parsedSupports.length || parsedResistances.length) {
    const syncedLevels = [];
    parsedResistances.slice(0, 3).forEach((px, idx) => {
      const existing = ann.horizontalLevels.find(
        (l) => l.type === 'resistance' && Math.abs(Number(l.price) - px) / Math.max(px, 1e-6) < 0.01
      );
      syncedLevels.push({
        id: existing?.id || `rep_res_${idx + 1}`,
        type: 'resistance',
        price: Number(px.toFixed(precision)),
        startIndex: Number.isFinite(Number(existing?.startIndex)) ? Number(existing.startIndex) : Math.max(0, Math.floor(N * 0.25)),
        endIndex: N - 1,
        strength: idx === 0 ? 'strong' : 'medium',
        label: idx === 0 ? C.resistance : C.secRes
      });
    });
    parsedSupports.slice(0, 3).forEach((px, idx) => {
      const existing = ann.horizontalLevels.find(
        (l) => l.type === 'support' && Math.abs(Number(l.price) - px) / Math.max(px, 1e-6) < 0.01
      );
      syncedLevels.push({
        id: existing?.id || `rep_sup_${idx + 1}`,
        type: 'support',
        price: Number(px.toFixed(precision)),
        startIndex: Number.isFinite(Number(existing?.startIndex)) ? Number(existing.startIndex) : Math.max(0, Math.floor(N * 0.25)),
        endIndex: N - 1,
        strength: idx === 0 ? 'strong' : 'medium',
        label: idx === 0 ? C.support : C.defSup
      });
    });
    ann.horizontalLevels = syncedLevels;
  }

  // 2) Source trendlines & patterns exclusively from deterministic patternEngine candidates
  if (!ann.patterns.length || !ann.trendlines.length) {
    const engineAnn = buildAnnotationsFromPatternEngine(ctx.patternEngine, {
      candles: ctx.candles,
      indexOffset: 0,
      precision,
      lang: chartLang,
      currencyPrefix: ctx.instrument?.market === 'in' ? '₹' : ''
    });
    if (!ann.trendlines.length) ann.trendlines = engineAnn.trendlines;
    if (!ann.patterns.length) ann.patterns = engineAnn.patterns;
  }

  return ann;
}

/**
 * Robustly extract JSON object from LLM text (handles markdown code fences & <think> reasoning tags)
 */
function parseLLMResponse(rawText) {
  let cleaned = (rawText || '').trim();
  let embeddedReasoning = '';

  const thinkMatch = cleaned.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    embeddedReasoning = thinkMatch[1].trim();
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenceMatch) candidates.push(fenceMatch[1].trim());
  candidates.push(cleaned);

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj === 'object') {
        return { parsed: obj, embeddedReasoning };
      }
    } catch {
      // try next candidate
    }
  }

  // Graceful fallback: model replied directly in the strict 5-part report prose without JSON
  return {
    parsed: {
      bias: 'neutral',
      confidence: 72,
      summary: 'AI 综合分析已完成',
      reportText: cleaned || '模型未返回内容。',
      analysisMarkdown: cleaned || '模型未返回内容。',
      annotations: null
    },
    embeddedReasoning
  };
}

/**
 * Convert local visible indices (0..N-1) into global candle indices (visibleStart..visibleEnd)
 * and sanitize prices/geometry so drawings NEVER drift or break off-chart.
 */
function normalizeAnnotationsToGlobal(rawAnn, ctx) {
  if (!rawAnn || typeof rawAnn !== 'object') {
    return {
      horizontalLevels: [],
      trendlines: [],
      patterns: [],
      signals: [],
      tradePlan: null
    };
  }

  const offset = ctx.visibleStart;
  const maxLocal = ctx.visibleCount - 1;
  const minValidPrice = ctx.periodLow * 0.55;
  const maxValidPrice = ctx.periodHigh * 1.65;

  const toGlobalIdx = (localIdx, fallbackLocal = 0) => {
    const n = Number(localIdx);
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(maxLocal, Math.round(n))) : fallbackLocal;
    return offset + clamped;
  };

  const validPrice = (p) => {
    const n = Number(p);
    return Number.isFinite(n) && n >= minValidPrice && n <= maxValidPrice ? n : null;
  };

  const horizontalLevels = (Array.isArray(rawAnn.horizontalLevels) ? rawAnn.horizontalLevels : [])
    .map((lvl, idx) => {
      const price = validPrice(lvl?.price);
      if (price === null) return null;
      return {
        id: lvl.id || `sr_${idx + 1}`,
        type: lvl.type === 'resistance' ? 'resistance' : 'support',
        price,
        startIndex: toGlobalIdx(lvl.startIndex, Math.floor(maxLocal * 0.15)),
        endIndex: toGlobalIdx(lvl.endIndex, maxLocal),
        strength: lvl.strength === 'medium' ? 'medium' : 'strong',
        labelKey: lvl.labelKey || null,
        labelCount: lvl.labelCount ?? null,
        label: String(lvl.label || (lvl.type === 'resistance' ? 'Resistance' : 'Support')).slice(0, 32)
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  const trendlines = (Array.isArray(rawAnn.trendlines) ? rawAnn.trendlines : [])
    .map((tl, idx) => {
      const sp = validPrice(tl?.startPrice);
      const ep = validPrice(tl?.endPrice);
      if (sp === null || ep === null) return null;
      let sIdx = toGlobalIdx(tl.startIndex, Math.floor(maxLocal * 0.2));
      let eIdx = toGlobalIdx(tl.endIndex, Math.floor(maxLocal * 0.85));
      if (eIdx <= sIdx) eIdx = Math.min(offset + maxLocal, sIdx + 8);
      return {
        id: tl.id || `tl_${idx + 1}`,
        type: tl.type === 'uptrend' || tl.type === 'downtrend' ? tl.type : 'channel',
        startIndex: sIdx,
        startPrice: sp,
        endIndex: eIdx,
        endPrice: ep,
        extendRight: tl.extendRight !== false,
        labelKey: tl.labelKey || null,
        label: String(tl.label || 'Trendline').slice(0, 32)
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  const patterns = (Array.isArray(rawAnn.patterns) ? rawAnn.patterns : [])
    .map((pat, idx) => {
      if (!pat) return null;
      const pts = (Array.isArray(pat.points) ? pat.points : [])
        .map((pt) => {
          const p = validPrice(pt?.price);
          if (p === null) return null;
          return { index: toGlobalIdx(pt.index, 0), price: p };
        })
        .filter(Boolean);

      const mapLine = (ln) => {
        if (!ln) return null;
        const sp = validPrice(ln.startPrice);
        const ep = validPrice(ln.endPrice);
        if (sp === null || ep === null) return null;
        return {
          startIndex: toGlobalIdx(ln.startIndex, Math.floor(maxLocal * 0.3)),
          startPrice: sp,
          endIndex: toGlobalIdx(ln.endIndex, maxLocal),
          endPrice: ep
        };
      };

      const upperLine = mapLine(pat.upperLine);
      const lowerLine = mapLine(pat.lowerLine);
      if (pts.length < 3 && !upperLine && !lowerLine) return null;

      return {
        id: pat.id || `pat_${idx + 1}`,
        name: String(pat.name || 'Pattern').slice(0, 34),
        labelKey: pat.labelKey || null,
        targetText: pat.targetText || null,
        bias: pat.bias === 'bullish' || pat.bias === 'bearish' ? pat.bias : 'neutral',
        points: pts,
        upperLine,
        lowerLine,
        breakoutTarget: validPrice(pat.breakoutTarget),
        label: String(pat.label || pat.name || 'Pattern').slice(0, 42)
      };
    })
    .filter(Boolean)
    .slice(0, 2);

  const signals = (Array.isArray(rawAnn.signals) ? rawAnn.signals : [])
    .map((sig, idx) => {
      const localIdx = Math.max(0, Math.min(maxLocal, Math.round(Number(sig?.index))));
      if (!Number.isFinite(localIdx)) return null;
      const candle = ctx.candles[localIdx];
      const isBear = sig.kind === 'bear_wick' || sig.kind === 'breakdown';
      const snappedPrice = candle ? (isBear ? candle.high : candle.low) : validPrice(sig?.price);
      if (!Number.isFinite(snappedPrice)) return null;
      return {
        id: sig.id || `sig_${idx + 1}`,
        index: offset + localIdx,
        price: snappedPrice,
        kind: sig.kind || 'bull_wick',
        labelKey: sig.labelKey || null,
        label: String(sig.label || (isBear ? 'Bear Wick' : 'Bull Wick')).slice(0, 24)
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  let tradePlan = null;
  if (rawAnn.tradePlan && typeof rawAnn.tradePlan === 'object') {
    const tp = rawAnn.tradePlan;
    const entry = validPrice(tp.entry);
    const sl = validPrice(tp.stopLoss);
    const target = validPrice(tp.takeProfit);
    if (entry !== null && sl !== null && target !== null && sl !== entry && target !== entry) {
      const dir = tp.direction === 'short' ? 'short' : 'long';
      const validDir = dir === 'long' ? (sl < entry && target > entry) : (sl > entry && target < entry);
      if (validDir) {
        tradePlan = {
          direction: dir,
          entry,
          stopLoss: sl,
          takeProfit: target,
          startIndex: toGlobalIdx(tp.startIndex, Math.max(0, maxLocal - 12)),
          rationale: String(tp.rationale || '').slice(0, 140)
        };
      }
    }
  }

  return { horizontalLevels, trendlines, patterns, signals, tradePlan };
}

/**
 * Lightweight, safe Markdown-to-HTML renderer delegated to strict whitelist sanitizer
 */
export function renderAnalysisMarkdown(mdText) {
  return renderSafeMarkdown(mdText);
}

/**
 * Main AI Copilot Controller
 */
export class AICopilotController {
  constructor({
    chartEngine,
    screenshotStudio,
    chatFeedEl,
    welcomeEl,
    onAnnotationsApplied,
    onOpenSettings,
    onExportPine
  }) {
    this.chart = chartEngine;
    this.studio = screenshotStudio;
    this.chatFeed = chatFeedEl;
    this.welcomeEl = welcomeEl;
    this.onAnnotationsApplied = onAnnotationsApplied || (() => {});
    this.onOpenSettings = onOpenSettings || (() => {});
    this.onExportPine = onExportPine || (() => {});

    this.settings = loadAISettings();
    this.uiLang = 'zh-CN';
    this.chartLang = 'zh-CN';
    this.isBusy = false;
    this.dataMeta = null;
    this.demoMode = Boolean(this.settings?.demoMode);
    this.lastResult = null;
    this.lastScreenshotImgEl = null;
  }

  setDataMeta(meta) {
    this.dataMeta = meta || null;
  }

  setDemoMode(enabled) {
    this.demoMode = Boolean(enabled);
    this.updateSettings({ demoMode: this.demoMode });
  }

  setLanguages(uiLang, chartLang) {
    if (uiLang) this.uiLang = uiLang;
    if (chartLang) this.chartLang = chartLang;
  }

  async refreshLatestScreenshot(chartLang = this.chartLang) {
    if (!this.lastResult?.snapshot || !this.lastScreenshotImgEl) return;
    const url = await renderAnnotatedScreenshot(
      this.lastResult.snapshot,
      this.lastResult.annotations,
      this.lastResult.meta,
      { showAnnotations: Boolean(this.lastResult.annotations), lang: chartLang }
    );
    this.lastResult.annotatedImageUrl = url;
    this.lastScreenshotImgEl.src = url;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (newSettings.demoMode !== undefined) {
      this.demoMode = Boolean(newSettings.demoMode);
    }
    saveAISettings(this.settings);
  }

  hasApiKey() {
    if (PROVIDER_PRESETS[this.settings.provider]?.allowLocal) {
      return Boolean((this.settings.baseUrl || '').trim());
    }
    return Boolean(this.settings.apiKey && this.settings.apiKey.trim().length >= 6);
  }

  getActiveModelLabel() {
    if (!this.hasApiKey()) {
      return getLangPack(this.uiLang).ui.demoEngine;
    }
    return this.settings.model || 'deepseek-chat';
  }

  clearChat() {
    this.chatFeed.textContent = '';
    this.welcomeEl.style.display = 'flex';
  }

  async ask(userPrompt, { autoDraw = true, captureScreenshot = true, blockOnSimulated, demoMode } = {}) {
    if (this.isBusy || !userPrompt?.trim()) return;
    if (!this.chart.candles.length) return;

    const activeDataMeta = this.dataMeta || this.chart?.dataMeta || null;
    const isDemoAllowed = demoMode !== undefined
      ? Boolean(demoMode)
      : blockOnSimulated !== undefined
        ? !blockOnSimulated
        : Boolean(this.demoMode || this.settings?.demoMode);

    if (activeDataMeta?.source === 'simulated' && !isDemoAllowed) {
      this.welcomeEl.style.display = 'none';
      this._appendUserMessage(userPrompt.trim());
      this._appendErrorMessage('当前行情为模拟数据，AI 分析默认已禁用。如需在模拟数据下体验分析，请先开启下方「演示模式」开关。');
      return { blocked: true, reason: 'simulated' };
    }

    this.isBusy = true;
    this.welcomeEl.style.display = 'none';
    const U = getLangPack(this.uiLang).ui;

    this._appendUserMessage(userPrompt.trim());

    const loadingCard = this._appendLoadingMessage(
      this.hasApiKey()
        ? `${U.loadingAI} (${this.settings.model})`
        : U.loadingAI
    );

    const snapshot = this.chart.captureSnapshot({ includeCurrentAI: false });

    let fundamentals = null;
    try {
      const sym = this.chart.instrument?.symbol || '';
      if (sym) {
        const fResp = await fetch(`/api/fundamentals?symbol=${encodeURIComponent(sym)}`);
        if (fResp.ok) fundamentals = await fResp.json();
      }
    } catch {
      // proceed with chart OHLCV & indicator grounding
    }

    const effectiveMeta = activeDataMeta || fundamentals?.meta || null;
    const ctx = extractChartContext(
      this.chart.candles,
      this.chart.indicators,
      snapshot.visibleStart,
      snapshot.visibleEnd,
      this.chart.instrument,
      this.chart.interval,
      fundamentals,
      this.chart.emaPeriods
    );
    ctx.dataMeta = effectiveMeta;

    try {
      let analysisResult;
      let modelLabel = U.demoEngine;
      let fallbackNotice = '';

      const allowLocal = Boolean(PROVIDER_PRESETS[this.settings.provider]?.allowLocal);
      const hasKey = this.hasApiKey();
      if (hasKey) {
        modelLabel = this.settings.model;
      }

      const callModelFn = hasKey
        ? async (messages) => {
            const payloadMessages = messages.map((m, idx) => {
              if (idx === messages.length - 1 && m.role === 'user' && this.settings.enableVision && snapshot.cleanDataUrl) {
                return {
                  role: 'user',
                  content: [
                    { type: 'text', text: m.content },
                    { type: 'image_url', image_url: { url: snapshot.cleanDataUrl } }
                  ]
                };
              }
              return m;
            });
            const resp = await fetch('/api/ai/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiKey: this.settings.apiKey,
                baseUrl: this.settings.baseUrl,
                model: this.settings.model,
                allowLocal,
                messages: payloadMessages,
                temperature: 0.2,
                maxTokens: 1600
              })
            });
            const data = await resp.json();
            if (!resp.ok || data.error) {
              throw new Error(data.error || `HTTP ${resp.status}`);
            }
            return { content: data.content, latencyMs: data.latencyMs };
          }
        : null;

      if (!hasKey) {
        await new Promise((r) => setTimeout(r, 120));
      }

      const m4Out = await runM4Pipeline({
        ctx,
        userPrompt: userPrompt.trim(),
        dataMeta: effectiveMeta,
        callModelFn,
        chartLang: this.chartLang
      });

      if (hasKey && m4Out.usedFallback) {
        fallbackNotice = `模型输出未通过 M4 严格校验，已自动回退本地模板（原因：${m4Out.fallbackReason}）`;
        modelLabel = U.demoEngine;
      }

      analysisResult = {
        bias: m4Out.bias,
        confidence: m4Out.confidence,
        summary: m4Out.summary,
        reportText: m4Out.reportText,
        analysisMarkdown: m4Out.reportText,
        annotations: m4Out.annotations,
        latencyMs: m4Out.latencyMs,
        engine: hasKey && !m4Out.usedFallback ? 'byok_llm' : 'm4_local_template',
        fundamentalsSufficient: m4Out.fundamentalsSufficient,
        fundamentalsBadge: m4Out.fundamentalsBadge,
        usedFallback: m4Out.usedFallback,
        fallbackReason: m4Out.fallbackReason,
        droppedIds: m4Out.droppedIds,
        selectedSupport: m4Out.selectedSupport,
        selectedResistance: m4Out.selectedResistance,
        inputDigest: m4Out.inputDigest,
        cacheHit: m4Out.cacheHit
      };

      const statusAwareReport = applyDataStatusToReport(
        analysisResult.reportText,
        effectiveMeta,
        this.chart.interval,
        ctx.latest?.time
      );
      analysisResult.reportText = statusAwareReport;
      analysisResult.analysisMarkdown = statusAwareReport;
      analysisResult.dataMeta = effectiveMeta;

      const globalAnnotations = autoDraw
        ? (m4Out.annotations || buildAnnotationsFromPatternEngine(ctx.patternEngine, {
            indexOffset: 0,
            candles: this.chart.candles,
            visibleStart: ctx.visibleStart,
            visibleEnd: ctx.visibleEnd,
            precision: ctx.precision,
            lang: this.chartLang,
            currencyPrefix: ctx.instrument?.market === 'in' ? '₹' : ''
          }))
        : null;

      let annotatedImageUrl = null;
      if (captureScreenshot) {
        annotatedImageUrl = await renderAnnotatedScreenshot(
          snapshot,
          globalAnnotations,
          {
            bias: analysisResult.bias,
            confidence: analysisResult.confidence,
            modelLabel
          },
          { showAnnotations: Boolean(globalAnnotations), lang: this.chartLang }
        );
      }

      if (autoDraw && globalAnnotations) {
        this.chart.setAIAnnotations(globalAnnotations);
        this.onAnnotationsApplied(globalAnnotations, ctx);
      }

      this.lastResult = {
        snapshot,
        annotations: globalAnnotations,
        meta: { bias: analysisResult.bias, confidence: analysisResult.confidence, modelLabel },
        annotatedImageUrl,
        analysisResult
      };

      loadingCard.remove();
      const cardEl = this._appendAssistantMessage({
        analysisResult,
        annotations: globalAnnotations,
        snapshot,
        annotatedImageUrl,
        modelLabel,
        fallbackNotice,
        usedDemoMode: !this.hasApiKey(),
        isSimulatedData: effectiveMeta?.source === 'simulated'
      });
      this.lastScreenshotImgEl = cardEl.querySelector('.screenshot-preview-img');
      requestAnimationFrame(() => {
        cardEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (err) {
      loadingCard.remove();
      this._appendErrorMessage(err.message || 'Analysis failed.');
    } finally {
      this.isBusy = false;
    }
  }

  _appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble-user';
    bubble.textContent = String(text ?? '');
    el.appendChild(bubble);
    this.chatFeed.appendChild(el);
    this._scrollToBottom();
  }

  _appendLoadingMessage(label) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-ai';
    const box = document.createElement('div');
    box.className = 'chat-loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const textSpan = document.createElement('span');
    textSpan.textContent = String(label ?? '');
    box.append(spinner, textSpan);
    el.appendChild(box);
    this.chatFeed.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  _appendErrorMessage(msg) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-ai';
    const box = document.createElement('div');
    box.className = 'chat-error-box';
    box.textContent = `⚠️ ${String(msg ?? '')}`;
    el.appendChild(box);
    this.chatFeed.appendChild(el);
    this._scrollToBottom();
  }

  _appendAssistantMessage({
    analysisResult,
    annotations,
    snapshot,
    annotatedImageUrl,
    modelLabel,
    fallbackNotice,
    usedDemoMode,
    isSimulatedData = false
  }) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-ai';

    const U = getLangPack(this.uiLang).ui;
    const C = getLangPack(this.uiLang).chart;
    const bias = analysisResult.bias || 'neutral';
    const biasText = bias === 'bullish' ? C.biasBull : bias === 'bearish' ? C.biasBear : C.biasNeu;
    const biasClass = bias === 'bullish' ? 'badge-bull' : bias === 'bearish' ? 'badge-bear' : 'badge-neutral';
    const safeConfidence = Number.isFinite(Number(analysisResult.confidence))
      ? Math.round(Number(analysisResult.confidence))
      : 72;

    const srCount = annotations?.horizontalLevels?.length || 0;
    const tlCount = annotations?.trendlines?.length || 0;
    const patCount = annotations?.patterns?.length || 0;

    const summaryStats = [];
    if (srCount) summaryStats.push(`${U.layerSR} ${srCount}`);
    if (tlCount) summaryStats.push(`${U.layerTrend} ${tlCount}`);
    if (patCount) summaryStats.push(`${U.layerPattern} ${patCount}`);

    const cleanReportText = String(analysisResult.reportText || analysisResult.analysisMarkdown || '');
    const safeShotUrl = sanitizeImageDataUrl(annotatedImageUrl);

    const card = document.createElement('div');
    card.className = 'ai-card';

    const header = document.createElement('div');
    header.className = 'ai-card-header';
    const badges = document.createElement('div');
    badges.className = 'ai-card-badges';

    const biasBadge = document.createElement('span');
    biasBadge.className = `bias-badge ${biasClass}`;
    biasBadge.textContent = `${biasText} · ${safeConfidence}%`;

    const modelTag = document.createElement('span');
    modelTag.className = 'model-tag';
    const latencySuffix = Number.isFinite(Number(analysisResult.latencyMs)) && Number(analysisResult.latencyMs) > 0
      ? ` · ${(Number(analysisResult.latencyMs) / 1000).toFixed(1)}s`
      : '';
    modelTag.textContent = `${String(modelLabel ?? '')}${latencySuffix}`;

    badges.append(biasBadge, modelTag);
    if (analysisResult.fundamentalsBadge) {
      const fundBadge = document.createElement('span');
      fundBadge.className = 'model-tag fundamentals-badge';
      fundBadge.textContent = String(analysisResult.fundamentalsBadge);
      badges.appendChild(fundBadge);
    }

    const summaryEl = document.createElement('div');
    summaryEl.className = 'ai-card-summary';
    summaryEl.textContent = String(analysisResult.summary || '');

    header.append(badges, summaryEl);
    card.appendChild(header);

    if (isSimulatedData || analysisResult?.dataMeta?.source === 'simulated') {
      const simBanner = document.createElement('div');
      simBanner.className = 'ai-notice ai-notice-sim';
      simBanner.textContent = '⚠️ 基于模拟数据，仅供演示（此声明仅在界面横幅与图上水印展示，不进入下方可复制报告文本）';
      card.appendChild(simBanner);
    }

    if (fallbackNotice) {
      const warnEl = document.createElement('div');
      warnEl.className = 'ai-notice ai-notice-warn';
      warnEl.textContent = String(fallbackNotice);
      card.appendChild(warnEl);
    }

    if (usedDemoMode) {
      const infoEl = document.createElement('div');
      infoEl.className = 'ai-notice ai-notice-info';
      const infoSpan = document.createElement('span');
      infoSpan.textContent = String(U.demoNotice || '');
      const cfgBtn = document.createElement('button');
      cfgBtn.type = 'button';
      cfgBtn.className = 'link-btn js-open-settings';
      cfgBtn.textContent = String(U.configKey || '');
      infoEl.append(infoSpan, cfgBtn);
      card.appendChild(infoEl);
    }

    const reportWrap = document.createElement('div');
    reportWrap.className = 'strict-report-wrap';
    const reportHead = document.createElement('div');
    reportHead.className = 'strict-report-head';
    const reportTitle = document.createElement('span');
    reportTitle.textContent = '综合研判报告（纯文本可直接复制）';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'strict-report-copy-btn js-copy-report';
    copyBtn.textContent = '一键复制报告';
    reportHead.append(reportTitle, copyBtn);

    const reportPre = document.createElement('pre');
    reportPre.className = 'strict-report-body';
    reportPre.textContent = cleanReportText;

    reportWrap.append(reportHead, reportPre);
    card.appendChild(reportWrap);

    if (safeShotUrl) {
      const shotCard = document.createElement('div');
      shotCard.className = 'screenshot-card';

      const shotHead = document.createElement('div');
      shotHead.className = 'screenshot-card-head';
      const shotBadge = document.createElement('span');
      shotBadge.className = 'screenshot-badge';
      shotBadge.textContent = String(U.shotCardTitle || '');
      const shotStats = document.createElement('span');
      shotStats.className = 'screenshot-stats';
      shotStats.textContent = summaryStats.join(' · ');
      shotHead.append(shotBadge, shotStats);

      const previewWrap = document.createElement('div');
      previewWrap.className = 'screenshot-preview-wrap js-open-studio';
      previewWrap.title = String(U.shotHoverHint || '');
      const img = document.createElement('img');
      img.src = safeShotUrl;
      img.alt = 'AI Annotated Snapshot';
      img.className = 'screenshot-preview-img';
      const hoverHint = document.createElement('div');
      hoverHint.className = 'screenshot-hover-hint';
      hoverHint.textContent = String(U.shotHoverHint || '');
      previewWrap.append(img, hoverHint);

      const actions = document.createElement('div');
      actions.className = 'screenshot-actions';
      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'mini-action-btn js-open-studio';
      zoomBtn.textContent = String(U.shotZoomEdit || '');
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'mini-action-btn js-download-shot';
      dlBtn.textContent = String(U.shotDownload || '');
      const syncBtn = document.createElement('button');
      syncBtn.type = 'button';
      syncBtn.className = 'mini-action-btn js-sync-live';
      syncBtn.textContent = String(U.shotSync || '');
      actions.append(zoomBtn, dlBtn, syncBtn);

      shotCard.append(shotHead, previewWrap, actions);
      card.appendChild(shotCard);
    }

    if (annotations) {
      const footer = document.createElement('div');
      footer.className = 'ai-card-footer';
      const pineBtn = document.createElement('button');
      pineBtn.type = 'button';
      pineBtn.className = 'footer-chip-btn js-export-pine';
      pineBtn.textContent = String(U.exportPine || '');
      footer.appendChild(pineBtn);
      card.appendChild(footer);
    }

    el.appendChild(card);

    el.querySelector('.js-copy-report')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(cleanReportText);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = cleanReportText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const orig = btn.textContent;
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = orig; }, 1600);
    });

    el.querySelectorAll('.js-open-studio').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.studio.open(
          snapshot,
          annotations,
          { bias, confidence: safeConfidence, modelLabel },
          this.chartLang
        );
      });
    });

    el.querySelector('.js-download-shot')?.addEventListener('click', () => {
      const sym = (snapshot.instrument?.displaySymbol || 'chart').replace(/[^a-zA-Z0-9_-]/g, '_');
      const liveSrc = sanitizeImageDataUrl(el.querySelector('.screenshot-preview-img')?.src || safeShotUrl);
      if (liveSrc) {
        downloadDataUrl(liveSrc, `${sym}_AI_${this.chartLang}.png`);
      }
    });

    el.querySelector('.js-sync-live')?.addEventListener('click', (e) => {
      if (annotations) {
        this.chart.setAIAnnotations(annotations);
        this.onAnnotationsApplied(annotations);
        e.currentTarget.textContent = U.shotSynced;
        setTimeout(() => { e.currentTarget.textContent = U.shotSync; }, 1800);
      }
    });

    el.querySelector('.js-open-settings')?.addEventListener('click', () => {
      this.onOpenSettings();
    });

    el.querySelector('.js-export-pine')?.addEventListener('click', () => {
      this.onExportPine(annotations);
    });

    this.chatFeed.appendChild(el);
    return el;
  }

  _escape(s) {
    return escapeHtml(s);
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
    });
  }
}
