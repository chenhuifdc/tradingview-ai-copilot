/**
 * Technical indicators & quantitative pattern primitives for ChartCopilot.
 * Includes EMA, Bollinger Bands, MACD (10,21,9), RSI (14), ATR (14),
 * Swing Pivots, and LuxAlgo-style Support/Resistance + Wick rejection detection.
 */

export function getPrecision(price) {
  if (!Number.isFinite(price)) return 2;
  const abs = Math.abs(price);
  if (abs >= 100000) return 0;
  if (abs >= 1000) return 2;
  if (abs >= 10) return 2;
  if (abs >= 1) return 3;
  return 4;
}

export function formatPrice(val, precision) {
  if (!Number.isFinite(val)) return '—';
  const p = typeof precision === 'number' ? precision : getPrecision(val);
  return val.toFixed(p);
}

export function formatVolume(vol) {
  if (!Number.isFinite(vol)) return '0';
  if (vol >= 1e9) return (vol / 1e9).toFixed(2) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(2) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(2) + 'K';
  return Math.round(vol).toString();
}

export function formatTimeLabel(tsSec, interval, full = false, timeZone = 'Asia/Kolkata') {
  const isDailyOrWeekly = interval === '1d' || interval === '1w';
  const effectiveTz = isDailyOrWeekly && tsSec % 86400 === 0 ? 'UTC' : (timeZone || 'Asia/Kolkata');

  let Y, M, D, hh, mm;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: effectiveTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(tsSec * 1000));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    Y = Number(map.year);
    M = Number(map.month);
    D = Number(map.day);
    hh = map.hour === '24' ? '00' : (map.hour || '00');
    mm = map.minute || '00';
  } catch {
    const d = new Date(tsSec * 1000);
    Y = d.getUTCFullYear();
    M = d.getUTCMonth() + 1;
    D = d.getUTCDate();
    hh = String(d.getUTCHours()).padStart(2, '0');
    mm = String(d.getUTCMinutes()).padStart(2, '0');
  }

  if (full) {
    if (isDailyOrWeekly) {
      return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
    }
    return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')} ${hh}:${mm}`;
  }

  if (interval === '1m' || interval === '5m' || interval === '15m') {
    return `${M}/${D} ${hh}:${mm}`;
  }
  if (interval === '1h' || interval === '4h') {
    return `${M}月${D}日 ${hh}:00`;
  }
  if (D <= 4 && M === 1) return `${Y}`;
  return `${M}月${D}日`;
}

export function calcEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function calcBollinger(candles, period = 20, mult = 2) {
  const upper = new Array(candles.length).fill(null);
  const mid = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  if (candles.length < period) return { upper, mid, lower };

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j].close - mean;
      sq += diff * diff;
    }
    const std = Math.sqrt(sq / period);
    mid[i] = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, mid, lower };
}

export function calcMACD(candles, fast = 10, slow = 21, signalLen = 9) {
  const closes = candles.map((c) => c.close);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);

  const macd = new Array(candles.length).fill(null);
  const validMacd = [];
  const validIndices = [];

  for (let i = 0; i < candles.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      const val = emaFast[i] - emaSlow[i];
      macd[i] = val;
      validMacd.push(val);
      validIndices.push(i);
    }
  }

  const signalVals = calcEMA(validMacd, signalLen);
  const signal = new Array(candles.length).fill(null);
  const hist = new Array(candles.length).fill(null);

  for (let k = 0; k < validIndices.length; k++) {
    const idx = validIndices[k];
    if (signalVals[k] !== null) {
      signal[idx] = signalVals[k];
      hist[idx] = macd[idx] - signalVals[k];
    }
  }

  return { macd, signal, hist, params: { fast, slow, signalLen } };
}

export function calcRSI(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function calcATR(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let atr = sum / period;
  out[period - 1] = atr;
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * Detect Swing Highs & Swing Lows (Pivot Points)
 */
export function detectPivots(candles, left = 5, right = 5) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      highs.push({ index: i, time: candles[i].time, price: candles[i].high, volume: candles[i].volume });
    }
    if (isLow) {
      lows.push({ index: i, time: candles[i].time, price: candles[i].low, volume: candles[i].volume });
    }
  }
  return { highs, lows };
}

/**
 * LuxAlgo-inspired Support & Resistance with Breaks + Bear/Bull Wick detection
 * Mirrors the classic stepped red resistance & blue support shelves in TradingView.
 */
export function calcLuxAlgoSR(candles, left = 8, right = 8) {
  const segments = [];
  const wicks = [];
  if (candles.length < left + right + 5) return { segments, wicks, currentResistance: null, currentSupport: null };

  const { highs, lows } = detectPivots(candles, left, right);

  // Build stepped resistance segments
  for (let i = 0; i < highs.length; i++) {
    const startIdx = highs[i].index;
    const endIdx = i < highs.length - 1 ? highs[i + 1].index : candles.length - 1;
    segments.push({
      type: 'resistance',
      price: highs[i].price,
      startIndex: startIdx,
      endIndex: endIdx
    });
  }

  // Build stepped support segments
  for (let i = 0; i < lows.length; i++) {
    const startIdx = lows[i].index;
    const endIdx = i < lows.length - 1 ? lows[i + 1].index : candles.length - 1;
    segments.push({
      type: 'support',
      price: lows[i].price,
      startIndex: startIdx,
      endIndex: endIdx
    });
  }

  // Detect Bear Wick & Bull Wick rejection candles near recent pivots or high volume
  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / Math.max(1, candles.length);
  let lastWickIdx = -12;
  for (let i = 10; i < candles.length - 2; i++) {
    if (i - lastWickIdx < 12) continue;
    const c = candles[i];
    const body = Math.max(Math.abs(c.close - c.open), c.close * 0.002);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const range = c.high - c.low;
    if (range <= 0) continue;

    if (upperWick > body * 1.65 && upperWick / range > 0.48 && c.volume > avgVol * 0.85) {
      wicks.push({ index: i, time: c.time, price: c.high, kind: 'bear_wick', label: 'Bear Wick' });
      lastWickIdx = i;
    } else if (lowerWick > body * 1.65 && lowerWick / range > 0.48 && c.volume > avgVol * 0.85) {
      wicks.push({ index: i, time: c.time, price: c.low, kind: 'bull_wick', label: 'Bull Wick' });
      lastWickIdx = i;
    }
  }

  return {
    segments,
    wicks: wicks.slice(-6),
    currentResistance: highs.length ? highs[highs.length - 1].price : null,
    currentSupport: lows.length ? lows[lows.length - 1].price : null
  };
}

export const PRESET_EMA_PERIODS = [5, 10, 20, 30, 50, 60, 120, 200];

export const EMA_COLOR_MAP = {
  5: '#f59e0b',
  10: '#06b6d4',
  20: '#2962ff',
  30: '#ec4899',
  50: '#ff6d00',
  60: '#10b981',
  120: '#8b5cf6',
  200: '#a855f7'
};

const CUSTOM_EMA_COLORS = ['#e11d48', '#0284c7', '#16a34a', '#d97706', '#7c3aed', '#0d9488', '#db2777', '#4f46e5'];

export function getEmaColor(period) {
  const p = Number(period);
  if (EMA_COLOR_MAP[p]) return EMA_COLOR_MAP[p];
  return CUSTOM_EMA_COLORS[Math.abs(p) % CUSTOM_EMA_COLORS.length];
}

export function calcSMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < period || period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function computeAllIndicators(candles, emaPeriods = [5, 10, 20]) {
  const closes = candles.map((c) => c.close);
  const periodSet = new Set([5, 10, 20, 30, 50, 60, 120, 200]);
  if (Array.isArray(emaPeriods)) {
    for (const raw of emaPeriods) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 2 && n <= 500) periodSet.add(n);
    }
  }
  const emaMap = {};
  for (const p of [...periodSet].sort((a, b) => a - b)) {
    emaMap[p] = calcEMA(closes, p);
  }
  const smaMap = {
    5: calcSMA(closes, 5),
    10: calcSMA(closes, 10),
    20: calcSMA(closes, 20),
    50: calcSMA(closes, 50),
    200: calcSMA(closes, 200)
  };
  return {
    emaMap,
    smaMap,
    ema5: emaMap[5],
    ema10: emaMap[10],
    ema20: emaMap[20],
    ema30: emaMap[30],
    ema50: emaMap[50],
    ema60: emaMap[60],
    ema120: emaMap[120],
    ema200: emaMap[200],
    boll: calcBollinger(candles, 20, 2),
    macd: calcMACD(candles, 10, 21, 9),
    rsi: calcRSI(candles, 14),
    atr: calcATR(candles, 14),
    luxSR: calcLuxAlgoSR(candles, 9, 9)
  };
}
