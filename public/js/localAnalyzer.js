/**
 * Quantitative Technical Analysis Engine + Pine Script v5 Exporter.
 * Serves dual purposes:
 * 1) Extracts structured mathematical features (pivots, S&R clusters, trendline candidates,
 *    MACD/RSI/EMA regime) to ground BYOK LLM calls so AI drawings land on exact candle prices.
 * 2) Provides an instant zero-key Built-in Quantitative Analyzer so users can immediately test
 *    real-time AI chart screenshot annotation & live overlays before adding their API Key.
 */

import {
  detectPivots,
  calcLuxAlgoSR,
  formatPrice,
  formatTimeLabel,
  getPrecision
} from './indicators.js';
import { getLangPack } from './i18n.js';
import { runPatternRuleEngine } from './patternEngine.js';
import { buildAnnotationsFromPatternEngine } from './lwcAnnotationPrimitive.js';

/**
 * Cluster nearby pivot prices into strong Support/Resistance zones
 */
function clusterLevels(pivots, tolerancePct = 0.022) {
  const clusters = [];
  for (const p of pivots) {
    let matched = null;
    for (const c of clusters) {
      if (Math.abs(p.price - c.price) / Math.max(c.price, 0.0001) <= tolerancePct) {
        matched = c;
        break;
      }
    }
    if (matched) {
      matched.touches += 1;
      matched.price = (matched.price * (matched.touches - 1) + p.price) / matched.touches;
      matched.firstIndex = Math.min(matched.firstIndex, p.index);
      matched.lastIndex = Math.max(matched.lastIndex, p.index);
      matched.points.push(p);
    } else {
      clusters.push({
        price: p.price,
        touches: 1,
        firstIndex: p.index,
        lastIndex: p.index,
        points: [p]
      });
    }
  }
  return clusters.sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex);
}

/**
 * Extract rich quantitative chart summary for both LLM prompt grounding and local analysis
 */
export function extractChartContext(
  candles,
  indicators,
  visibleStart,
  visibleEnd,
  instrument,
  interval,
  fundamentals = null,
  activeEmaPeriods = [5, 10, 20]
) {
  const start = Math.max(0, Math.floor(visibleStart));
  const end = Math.min(candles.length - 1, Math.ceil(visibleEnd));
  const slice = candles.slice(start, end + 1);
  if (slice.length < 10) return null;

  const latest = slice[slice.length - 1];
  const prev = slice[slice.length - 2] || latest;
  const precision = getPrecision(latest.close);
  const change = latest.close - prev.close;
  const changePct = prev.close ? (change / prev.close) * 100 : 0;

  let periodHigh = -Infinity;
  let periodLow = Infinity;
  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > periodHigh) {
      periodHigh = slice[i].high;
      highIdx = i;
    }
    if (slice[i].low < periodLow) {
      periodLow = slice[i].low;
      lowIdx = i;
    }
  }

  const pivots = detectPivots(slice, 5, 5);
  const lux = calcLuxAlgoSR(slice, 7, 7);

  const resistanceClusters = clusterLevels(pivots.highs, 0.025)
    .filter((c) => c.price >= latest.close * 0.995)
    .sort((a, b) => a.price - b.price)
    .slice(0, 4);
  const supportClusters = clusterLevels(pivots.lows, 0.025)
    .filter((c) => c.price <= latest.close * 1.005)
    .sort((a, b) => b.price - a.price)
    .slice(0, 4);

  // Pull real-time indicator snapshots at the latest visible bar
  const lastGlobalIdx = end;
  const prevGlobalIdx = Math.max(0, end - 1);
  const emaAt = (p, idx = lastGlobalIdx) => indicators?.emaMap?.[p]?.[idx] ?? indicators?.[`ema${p}`]?.[idx] ?? null;
  const smaAt = (p, idx = lastGlobalIdx) => indicators?.smaMap?.[p]?.[idx] ?? null;

  const ema5 = emaAt(5);
  const ema10 = emaAt(10);
  const ema20 = emaAt(20);
  const ema30 = emaAt(30);
  const ema50 = emaAt(50);
  const ema60 = emaAt(60);
  const ema120 = emaAt(120);
  const ema200 = emaAt(200);
  const prevEma5 = emaAt(5, prevGlobalIdx);
  const prevEma10 = emaAt(10, prevGlobalIdx);

  const ma5 = smaAt(5);
  const ma10 = smaAt(10);
  const ma20 = smaAt(20);
  const ma50 = smaAt(50);
  const ma200 = smaAt(200);

  const recentVolSlice = slice.slice(-20);
  const avgVol20 = recentVolSlice.reduce((acc, c) => acc + (c.volume || 0), 0) / Math.max(1, recentVolSlice.length);
  const volRatio = avgVol20 > 0 ? latest.volume / avgVol20 : 1;

  const rsi = indicators?.rsi?.[lastGlobalIdx] ?? null;
  const atr = indicators?.atr?.[lastGlobalIdx] ?? (periodHigh - periodLow) * 0.04;
  const macdVal = indicators?.macd?.macd?.[lastGlobalIdx] ?? null;
  const macdSig = indicators?.macd?.signal?.[lastGlobalIdx] ?? null;
  const macdHist = indicators?.macd?.hist?.[lastGlobalIdx] ?? null;
  const prevHist = indicators?.macd?.hist?.[prevGlobalIdx] ?? null;

  const patternEngine = runPatternRuleEngine(candles, {
    tickSize: instrument?.market === 'in' ? 0.05 : 0.01,
    interval: interval || '1d',
    timeZone: instrument?.timezone || (instrument?.market === 'in' ? 'Asia/Kolkata' : 'Asia/Kolkata')
  });

  return {
    instrument,
    interval,
    precision,
    visibleStart: start,
    visibleEnd: end,
    visibleCount: slice.length,
    candles: slice,
    allCandles: candles,
    latest,
    change,
    changePct,
    periodHigh,
    periodLow,
    highIdx,
    lowIdx,
    pivots,
    lux,
    resistanceClusters,
    supportClusters,
    patternEngine,
    fundamentals,
    activeEmaPeriods,
    indicators: {
      ema5,
      ema10,
      ema20,
      ema30,
      ema50,
      ema60,
      ema120,
      ema200,
      prevEma5,
      prevEma10,
      ma5,
      ma10,
      ma20,
      ma50,
      ma200,
      volRatio,
      rsi,
      atr,
      macdVal,
      macdSig,
      macdHist,
      prevHist
    }
  };
}

/**
 * Fit trendlines and recognize technical patterns from visible swing pivots
 */
export function analyzeTrendlinesAndPatterns(ctx, lang = 'zh-CN') {
  const { candles, pivots, latest, precision } = ctx;
  const C = getLangPack(lang).chart;
  const N = candles.length;
  const trendlines = [];
  const patterns = [];

  const recentHighs = pivots.highs.filter((p) => p.index >= Math.floor(N * 0.18));
  const recentLows = pivots.lows.filter((p) => p.index >= Math.floor(N * 0.18));

  let upperLine = null;
  if (recentHighs.length >= 2) {
    const h2 = recentHighs[recentHighs.length - 1];
    let h1 = recentHighs[recentHighs.length - 2];
    for (let i = recentHighs.length - 2; i >= 0; i--) {
      if (h2.index - recentHighs[i].index >= 8) {
        h1 = recentHighs[i];
        break;
      }
    }
    if (h2.index > h1.index) {
      const slope = (h2.price - h1.price) / (h2.index - h1.index);
      upperLine = {
        startIndex: h1.index,
        startPrice: Number(h1.price.toFixed(precision)),
        endIndex: h2.index,
        endPrice: Number(h2.price.toFixed(precision)),
        slope
      };
      const lk = slope < 0 ? 'downtrend' : 'upperChannel';
      trendlines.push({
        id: 'tl_upper',
        type: slope < 0 ? 'downtrend' : 'channel',
        startIndex: h1.index,
        startPrice: upperLine.startPrice,
        endIndex: h2.index,
        endPrice: upperLine.endPrice,
        extendRight: true,
        labelKey: lk,
        label: C[lk]
      });
    }
  }

  let lowerLine = null;
  if (recentLows.length >= 2) {
    const l2 = recentLows[recentLows.length - 1];
    let l1 = recentLows[recentLows.length - 2];
    for (let i = recentLows.length - 2; i >= 0; i--) {
      if (l2.index - recentLows[i].index >= 8) {
        l1 = recentLows[i];
        break;
      }
    }
    if (l2.index > l1.index) {
      const slope = (l2.price - l1.price) / (l2.index - l1.index);
      lowerLine = {
        startIndex: l1.index,
        startPrice: Number(l1.price.toFixed(precision)),
        endIndex: l2.index,
        endPrice: Number(l2.price.toFixed(precision)),
        slope
      };
      const lk = slope > 0 ? 'uptrend' : 'lowerChannel';
      trendlines.push({
        id: 'tl_lower',
        type: slope > 0 ? 'uptrend' : 'channel',
        startIndex: l1.index,
        startPrice: lowerLine.startPrice,
        endIndex: l2.index,
        endPrice: lowerLine.endPrice,
        extendRight: true,
        labelKey: lk,
        label: C[lk]
      });
    }
  }

  if (upperLine && lowerLine) {
    const startIdx = Math.min(upperLine.startIndex, lowerLine.startIndex);
    const endIdx = N - 1;
    const uStart = upperLine.startPrice + upperLine.slope * (startIdx - upperLine.startIndex);
    const uEnd = upperLine.startPrice + upperLine.slope * (endIdx - upperLine.startIndex);
    const lStart = lowerLine.startPrice + lowerLine.slope * (startIdx - lowerLine.startIndex);
    const lEnd = lowerLine.startPrice + lowerLine.slope * (endIdx - lowerLine.startIndex);

    const spreadStart = Math.max(0.0001, uStart - lStart);
    const spreadEnd = uEnd - lEnd;
    const isConverging = spreadEnd > 0 && spreadEnd < spreadStart * 0.85;
    const isParallel = spreadEnd > 0 && Math.abs(spreadEnd / spreadStart - 1) <= 0.35;

    let patKey = 'patRange';
    let patternBias = 'neutral';
    let target = latest.close * 1.12;

    if (upperLine.slope < 0 && lowerLine.slope > 0 && isConverging) {
      patKey = 'patSymTri';
      patternBias = latest.close > (uEnd + lEnd) / 2 ? 'bullish' : 'neutral';
      target = uEnd + spreadStart * 0.65;
    } else if (Math.abs(upperLine.slope) < Math.abs(lowerLine.slope) * 0.35 && lowerLine.slope > 0) {
      patKey = 'patAscTri';
      patternBias = 'bullish';
      target = uEnd + spreadStart * 0.72;
    } else if (Math.abs(lowerLine.slope) < Math.abs(upperLine.slope) * 0.35 && upperLine.slope < 0) {
      patKey = 'patDescTri';
      patternBias = 'bearish';
      target = Math.max(latest.close * 0.75, lEnd - spreadStart * 0.65);
    } else if (upperLine.slope > 0 && lowerLine.slope > 0 && isParallel) {
      patKey = 'patAscCh';
      patternBias = 'bullish';
      target = uEnd + spreadStart * 0.35;
    } else if (upperLine.slope < 0 && lowerLine.slope < 0 && isParallel) {
      patKey = 'patDescCh';
      patternBias = 'bearish';
      target = Math.max(latest.close * 0.75, lEnd - spreadStart * 0.35);
    } else if (recentLows.length >= 2) {
      const a = recentLows[recentLows.length - 2];
      const b = recentLows[recentLows.length - 1];
      if (Math.abs(a.price - b.price) / a.price < 0.045) {
        patKey = 'patDblBot';
        patternBias = 'bullish';
        target = Math.max(upperLine.startPrice, upperLine.endPrice) * 1.08;
      }
    }

    const polygonPoints = [
      { index: startIdx, price: Number(uStart.toFixed(precision)) },
      { index: endIdx, price: Number(Math.max(uEnd, lEnd + latest.close * 0.02).toFixed(precision)) },
      { index: endIdx, price: Number(Math.min(lEnd, uEnd - latest.close * 0.02).toFixed(precision)) },
      { index: startIdx, price: Number(lStart.toFixed(precision)) }
    ];

    const targetStr = formatPrice(target, precision);
    const patternName = C[patKey];
    patterns.push({
      id: 'pat_main',
      name: patternName,
      labelKey: patKey,
      targetText: targetStr,
      bias: patternBias,
      points: polygonPoints,
      upperLine: {
        startIndex: startIdx,
        startPrice: polygonPoints[0].price,
        endIndex: endIdx,
        endPrice: polygonPoints[1].price
      },
      lowerLine: {
        startIndex: startIdx,
        startPrice: polygonPoints[3].price,
        endIndex: endIdx,
        endPrice: polygonPoints[2].price
      },
      breakoutTarget: Number(target.toFixed(precision)),
      label: `${patternName} · ${C.target} ${targetStr}`
    });
  }

  return { trendlines, patterns };
}

const SECTOR_ZH = {
  'Basic Materials': '基础材料与特种化工',
  'Energy': '能源与油气炼化',
  'Technology': '科技与信息技术服务',
  'Financial Services': '金融服务与银行',
  'Communication Services': '通信与数字服务',
  'Industrials': '工业制造与基建装备',
  'Consumer Defensive': '必选消费与日用品',
  'Consumer Cyclical': '可选消费与汽车制造',
  'Healthcare': '医药与生物健康',
  'Utilities': '公用事业与电力',
  'Real Estate': '房地产与园区开发'
};

function describeDynamicMAState(latestClose, ind, precision) {
  const maPairs = [
    ['MA5', ind.ma5 ?? ind.ema5],
    ['MA10', ind.ma10 ?? ind.ema10],
    ['MA20', ind.ma20 ?? ind.ema20],
    ['MA50', ind.ma50 ?? ind.ema50],
    ['MA200', ind.ma200 ?? ind.ema200]
  ].filter(([, v]) => Number.isFinite(v));

  if (!maPairs.length) return '短期均线尚在修复';

  const m5 = ind.ma5 ?? ind.ema5;
  const m10 = ind.ma10 ?? ind.ema10;
  const m20 = ind.ma20 ?? ind.ema20;
  const m50 = ind.ma50 ?? ind.ema50;
  const m200 = ind.ma200 ?? ind.ema200;

  if (Number.isFinite(m5) && Number.isFinite(m10) && Number.isFinite(m20)) {
    if (latestClose > m5 && m5 > m10 && m10 > m20) {
      return Number.isFinite(m50) && latestClose > m50
        ? `MA5(${formatPrice(m5, precision)})上穿MA10与MA20呈多头排列并站稳MA50上方`
        : `短期站上MA5(${formatPrice(m5, precision)})与MA10呈偏强发散`;
    }
    if (latestClose < m5 && m5 < m10 && m10 < m20) {
      return Number.isFinite(m50) && latestClose < m50
        ? `价格受制于MA5(${formatPrice(m5, precision)})与MA10空头排列压制并运行于MA50下方`
        : `价格承压于MA5(${formatPrice(m5, precision)})与MA10死叉下方`;
    }
    const near5 = Math.abs(latestClose - m5) / Math.max(latestClose, 1e-6) < 0.015;
    const near10 = Math.abs(latestClose - m10) / Math.max(latestClose, 1e-6) < 0.018;
    if (near5 || near10) {
      return `价格围绕MA5(${formatPrice(m5, precision)})与MA10(${formatPrice(m10, precision)})窄幅粘合博弈`;
    }
  }

  // Pick the closest significant MA dynamically rather than hardcoding MA20
  let nearest = maPairs[0];
  let bestDist = Infinity;
  for (const pair of maPairs) {
    const d = Math.abs(latestClose - pair[1]) / Math.max(latestClose, 1e-6);
    if (d < bestDist) {
      bestDist = d;
      nearest = pair;
    }
  }
  const rel = latestClose >= nearest[1] ? '上方整固' : '下方承压';
  const longRef = Number.isFinite(m200)
    ? (latestClose >= m200 ? '，中长期仍处MA200之上' : '，中长期仍受MA200压制')
    : '';
  return `股价位于${nearest[0]}(${formatPrice(nearest[1], precision)})${rel}${longRef}`;
}

function summarizeNewsTheme(fundamentals) {
  const headlines = fundamentals?.headlines || [];
  if (!headlines.length) {
    return fundamentals?.market === 'in'
      ? '印度股市整体流动性轮动与板块估值消化影响'
      : '所属行业景气周期切换与宏观利率预期波动影响';
  }
  const combined = headlines.map((h) => h.title || '').join(' ').toLowerCase();
  if (/clarif|query|exchange|egm|agm|board|split|bonus/.test(combined)) {
    return '近期交易所价格异动问询及公司治理公告引发市场短线关注';
  }
  if (/result|earning|quarter|q1|q2|q3|q4|profit|revenue|margin/.test(combined)) {
    return '最新季报业绩兑现节奏与盈利预期修正影响';
  }
  if (/dividend|payout|yield/.test(combined)) {
    return '近期分红派息节点及股权登记预期波动影响';
  }
  if (/order|contract|deal|partnership|launch|expansion|capex/.test(combined)) {
    return '近期新签订单拓展与产能布局动态催化';
  }
  if (/tariff|fed|rbi|rate|macro|inflation|rupee|oil|export/.test(combined)) {
    return '宏观货币政策预期与外部成本端扰动影响';
  }
  return '近期市场舆情升温与资金情绪轮动影响';
}

function clampSentence(text, maxLen = 148) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1).replace(/[，,、；;：:\s]+$/, '') + '。';
}

/**
 * Full Built-in Quantitative Analyzer following strict 5-part analyst report format & red lines,
 * with 100% synchronized Support/Resistance & Technical Pattern chart drawings.
 */
export function runLocalQuantitativeAnalysis(ctx, userPrompt = '', lang = 'zh-CN') {
  const { candles, instrument, precision, latest, indicators, fundamentals } = ctx;
  const C = getLangPack(lang).chart;
  const N = candles.length;

  let score = 0;
  const refShort = indicators.ema10 ?? indicators.ema20;
  const refMid = indicators.ema50 ?? indicators.ema20;
  if (refShort && latest.close > refShort) score += 1.2;
  else if (refShort) score -= 1.2;

  if (refMid && latest.close > refMid) score += 1.0;
  else if (refMid) score -= 1.0;

  if (indicators.macdVal !== null && indicators.macdSig !== null) {
    if (indicators.macdVal > indicators.macdSig) score += 1.3;
    else score -= 1.3;
    if (indicators.macdHist !== null && indicators.prevHist !== null && indicators.macdHist > indicators.prevHist) {
      score += 0.6;
    } else {
      score -= 0.5;
    }
  }

  if (indicators.rsi !== null) {
    if (indicators.rsi > 55 && indicators.rsi < 74) score += 0.7;
    else if (indicators.rsi < 45 && indicators.rsi > 26) score -= 0.7;
    else if (indicators.rsi <= 30) score += 0.5;
  }

  const bias = score >= 1.1 ? 'bullish' : score <= -1.1 ? 'bearish' : 'neutral';
  const confidence = Math.min(89, Math.max(58, Math.round(64 + Math.abs(score) * 5.8)));

  // Prefer Daily/Weekly core swing supply-demand locking zones when on intraday timeframes
  const isIntraday = ['1m', '5m', '15m', '1h', '4h'].includes(ctx.interval);
  const dailyRes = (fundamentals?.dailySR?.resistances || []).filter((p) => Number.isFinite(p) && p >= latest.close * 0.995);
  const dailySup = (fundamentals?.dailySR?.supports || []).filter((p) => Number.isFinite(p) && p <= latest.close * 1.005);

  const resList = [...ctx.resistanceClusters];
  if (isIntraday && dailyRes.length) {
    for (const dp of dailyRes) {
      if (!resList.some((r) => Math.abs(r.price - dp) / Math.max(dp, 1e-6) < 0.015)) {
        resList.unshift({ price: dp, touches: 2, firstIndex: Math.max(0, Math.floor(N * 0.25)), lastIndex: N - 1 });
      }
    }
    resList.sort((a, b) => a.price - b.price);
  }
  if (resList.length === 0) {
    resList.push({ price: ctx.periodHigh, touches: 1, firstIndex: Math.max(0, ctx.highIdx - 6), lastIndex: N - 1 });
  }

  const supList = [...ctx.supportClusters];
  if (isIntraday && dailySup.length) {
    for (const dp of dailySup) {
      if (!supList.some((s) => Math.abs(s.price - dp) / Math.max(dp, 1e-6) < 0.015)) {
        supList.unshift({ price: dp, touches: 2, firstIndex: Math.max(0, Math.floor(N * 0.25)), lastIndex: N - 1 });
      }
    }
    supList.sort((a, b) => b.price - a.price);
  }
  if (supList.length === 0) {
    supList.push({ price: ctx.periodLow, touches: 1, firstIndex: Math.max(0, ctx.lowIdx - 6), lastIndex: N - 1 });
  }

  // M3: ALL chart drawing annotations come exclusively from deterministic patternEngine candidates by score
  const currencyPrefix = instrument?.market === 'in' ? '₹' : '';
  const engineAnnotations = buildAnnotationsFromPatternEngine(ctx.patternEngine, {
    candles: ctx.allCandles || ctx.candles,
    visibleStart: ctx.visibleStart,
    visibleEnd: ctx.visibleEnd,
    indexOffset: 0,
    precision,
    lang,
    currencyPrefix
  });
  const { horizontalLevels, trendlines, patterns, signals, tradePlan } = engineAnnotations;

  const engineSupPrices = horizontalLevels
    .filter((l) => l.type === 'support')
    .map((l) => formatPrice(l.price, precision));
  const engineResPrices = horizontalLevels
    .filter((l) => l.type === 'resistance')
    .map((l) => formatPrice(l.price, precision));

  // Pre-M4 local text fallback still guarantees non-empty S&R strings even on flat/synthetic charts
  const topRes = resList.slice(0, 2);
  const topSup = supList.slice(0, 2);
  const supPriceStrs = engineSupPrices.length ? engineSupPrices : topSup.map((s) => formatPrice(s.price, precision));
  const resPriceStrs = engineResPrices.length ? engineResPrices : topRes.map((r) => formatPrice(r.price, precision));
  const s1Str = supPriceStrs[0];
  const r1Str = resPriceStrs[0];

  const stockShortName = instrument.name || instrument.displaySymbol || instrument.symbol;
  const marketTag =
    instrument.market === 'in'
      ? `印度${instrument.exchange || 'NSE'}市场`
      : instrument.market === 'kr'
        ? `韩国${instrument.exchange || 'KRX'}市场`
        : `${instrument.exchange || ''}市场`;
  const sectorZh = SECTOR_ZH[fundamentals?.sector] || (fundamentals?.industry ? `${fundamentals.industry}细分领域` : '细分行业');
  const newsTheme = summarizeNewsTheme(fundamentals);

  const high52 = fundamentals?.high52w;
  const low52 = fundamentals?.low52w;
  let posQual = '中长期经营韧性仍待后续财报验证，短期易随情绪放大波动';
  if (Number.isFinite(high52) && Number.isFinite(low52) && high52 > low52) {
    const posRatio = (latest.close - low52) / (high52 - low52);
    if (posRatio >= 0.72) posQual = '基本面整体展现较强景气韧性，但高位消化压力亦需留意';
    else if (posRatio <= 0.32) posQual = '基本面短期承压消化，估值修复节奏仍取决于业绩与公告兑现';
  }

  const part1 = clampSentence(
    `${stockShortName}是${marketTag}${sectorZh}的代表性上市公司，核心业务具备一定细分竞争力。但受${newsTheme}，公司基本面${posQual}。`,
    148
  );

  const patName = patterns[0]?.name || '波段箱体震荡结构';
  const maDesc = describeDynamicMAState(latest.close, indicators, precision);
  const macdDesc =
    indicators.macdVal !== null && indicators.macdSig !== null
      ? indicators.macdVal > indicators.macdSig
        ? (indicators.macdHist > (indicators.prevHist ?? 0) ? 'MACD金叉红柱走阔' : 'MACD偏多但动能趋缓')
        : (indicators.macdHist < (indicators.prevHist ?? 0) ? 'MACD死叉绿柱扩大' : 'MACD空头动能收敛')
      : 'MACD维持中性';
  const volDesc =
    indicators.volRatio >= 1.35
      ? '成交量明显放大'
      : indicators.volRatio <= 0.72
        ? '成交量阶段性萎缩'
        : '量能维持温和水平';
  const trendTone = bias === 'bullish' ? '整体呈震荡偏强格局' : bias === 'bearish' ? '整体呈弱势承压格局' : '整体维持多空拉锯震荡';

  const part2 = clampSentence(
    `技术面来看，当前K线呈现${patName}，${maDesc}，配合${macdDesc}且${volDesc}，${trendTone}。`,
    148
  );

  const part3And4 = `支撑位： ${supPriceStrs.join(' / ')}\n阻力位： ${resPriceStrs.join(' / ')}`;

  const part5 =
    bias === 'bullish'
      ? `操作建议：当前需重点观察价格回踩 ${s1Str} 一带时的缩量企稳信号，以及冲击 ${r1Str} 阻力区时是否伴随量能持续配合；若有效跌破 ${s1Str} 则短线强势结构将被削弱，宜将其作为核心风控观察位并警惕高位回撤带来的仓位波动风险。`
      : bias === 'bearish'
        ? `操作建议：当前走势仍处于消化承压阶段，需耐心等待股价在 ${s1Str} 附近出现放量长下影或重返短期均线上方的明确企稳信号；若收盘有效失守 ${s1Str} 需防范下探风险并严格控制仓位敞口，反弹靠近 ${r1Str} 压力区时重点警惕冲高回落风险。`
        : `操作建议：当前处于 ${s1Str} 至 ${r1Str} 区间博弈格局，方向明朗前宜保持谨慎观察；上沿重点关注能否放量有效站稳 ${r1Str} 以确认结构突破，下沿则以 ${s1Str} 作为核心止损观察线，若跌破需及时防范重心下移风险并合理控制整体仓位风险。`;

  const reportText = `${part1}\n\n${part2}\n\n${part3And4}\n\n${part5}`;

  return {
    bias,
    confidence,
    summary: `${stockShortName}｜支撑 ${s1Str} · 阻力 ${r1Str}`,
    reportText,
    analysisMarkdown: reportText,
    annotations: {
      source: 'patternEngine',
      horizontalLevels,
      trendlines,
      patterns,
      signals,
      tradePlan
    },
    engine: 'local_quant'
  };
}

/**
 * Convert AI annotations to valid TradingView Pine Script v5 code
 */
export function generatePineScript(instrument, annotations, visibleCandles) {
  const sym = instrument?.displaySymbol || 'CHART';
  const lines = [
    '//@version=5',
    `indicator("ChartCopilot AI 标注 - ${sym}", overlay=true, max_lines_count=100, max_labels_count=100)`,
    ''
  ];

  const hrs = annotations?.horizontalLevels || [];
  if (hrs.length) {
    lines.push('// === 关键支撑与阻力位 ===');
    hrs.forEach((lvl, i) => {
      const color = lvl.type === 'resistance' ? 'color.new(#ef5350, 0)' : 'color.new(#2962ff, 0)';
      const style = lvl.strength === 'strong' ? 'hline.style_solid' : 'hline.style_dashed';
      lines.push(`hline(${lvl.price}, title="${lvl.label || (lvl.type === 'resistance' ? '阻力' : '支撑')} ${i + 1}", color=${color}, linestyle=${style}, linewidth=2)`);
    });
    lines.push('');
  }

  const tls = annotations?.trendlines || [];
  if (tls.length && visibleCandles?.length) {
    lines.push('// === AI 识别趋势线 ===');
    lines.push('if barstate.islast');
    tls.forEach((tl, i) => {
      const c1 = visibleCandles[Math.max(0, Math.min(visibleCandles.length - 1, tl.startIndex))];
      const c2 = visibleCandles[Math.max(0, Math.min(visibleCandles.length - 1, tl.endIndex))];
      if (!c1 || !c2) return;
      const color = tl.type === 'uptrend' ? 'color.new(#089981, 0)' : tl.type === 'downtrend' ? 'color.new(#f23645, 0)' : 'color.new(#2962ff, 0)';
      const ext = tl.extendRight ? 'extend.right' : 'extend.none';
      lines.push(`    line.new(${c1.time * 1000}, ${tl.startPrice}, ${c2.time * 1000}, ${tl.endPrice}, xloc=xloc.bar_time, extend=${ext}, color=${color}, width=2)`);
      lines.push(`    label.new(${c2.time * 1000}, ${tl.endPrice}, "${tl.label || `趋势线 ${i + 1}`}", xloc=xloc.bar_time, style=label.style_label_left, color=${color}, textcolor=color.white, size=size.small)`);
    });
    lines.push('');
  }

  const tp = annotations?.tradePlan;
  if (tp) {
    lines.push('// === AI 交易计划（入场 / 止损 / 止盈）===');
    lines.push(`hline(${tp.entry}, title="AI 入场位", color=color.new(#2962ff, 0), linestyle=hline.style_dotted, linewidth=2)`);
    lines.push(`hline(${tp.stopLoss}, title="AI 止损位", color=color.new(#f23645, 0), linestyle=hline.style_dashed, linewidth=2)`);
    lines.push(`hline(${tp.takeProfit}, title="AI 止盈目标", color=color.new(#089981, 0), linestyle=hline.style_dashed, linewidth=2)`);
  }

  lines.push('');
  lines.push('// 生成时间: ' + formatTimeLabel(Math.floor(Date.now() / 1000), '15m', true));
  return lines.join('\n');
}
