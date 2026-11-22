/**
 * Pure Data Adapter for TradingView Lightweight Charts v5.2.x.
 * Converts ChartCopilot OHLCV candles and technical indicator arrays
 * into strictly sorted, deduplicated Lightweight Charts series data structures,
 * and provides exchange-timezone-accurate tickMarkFormatter & crosshair timeFormatter.
 */

const DEFAULT_PALETTE = {
  volBull: 'rgba(8, 153, 129, 0.34)',
  volBear: 'rgba(242, 54, 69, 0.34)',
  histUpStrong: '#26a69a',
  histUpWeak: '#b2dfdb',
  histDownStrong: '#ef5350',
  histDownWeak: '#ffcdd2'
};

export function resolveExchangeTimezone(ctx = {}) {
  if (ctx.timeZone) {
    const tz = String(ctx.timeZone);
    const abbr = ctx.tzAbbr || (tz === 'Asia/Kolkata' ? 'IST' : tz === 'Asia/Seoul' ? 'KST' : tz === 'Asia/Hong_Kong' ? 'HKT' : tz === 'Asia/Shanghai' ? 'CST' : tz === 'UTC' ? 'UTC' : 'ET');
    return { timeZone: tz, tzAbbr: abbr, market: 'custom' };
  }

  const metaTz = ctx.dataMeta?.exchangeTimezone;
  const metaAbbr = ctx.dataMeta?.timezone;
  if (metaTz) {
    return {
      timeZone: metaTz,
      tzAbbr: metaAbbr || (metaTz === 'Asia/Kolkata' ? 'IST' : metaTz === 'UTC' ? 'UTC' : 'LOCAL'),
      market: ctx.instrument?.market || 'in'
    };
  }

  const sym = String(ctx.symbol || ctx.instrument?.symbol || '').toUpperCase();
  const ex = String(ctx.instrument?.exchange || '').toUpperCase();
  const mkt = String(ctx.instrument?.market || '').toLowerCase();

  if (mkt === 'crypto' || sym.endsWith('USDT') || sym.endsWith('BUSD') || sym.endsWith('USDC') || ex.includes('BINANCE')) {
    return { timeZone: 'UTC', tzAbbr: 'UTC', market: 'crypto' };
  }
  if (
    mkt === 'in' ||
    sym.endsWith('.NS') ||
    sym.endsWith('.BO') ||
    sym === '^NSEI' ||
    sym === '^BSESN' ||
    sym === '^NSEBANK' ||
    ex.includes('NSE') ||
    ex.includes('BSE') ||
    ex.includes('NSI')
  ) {
    return { timeZone: 'Asia/Kolkata', tzAbbr: 'IST', market: 'in' };
  }
  if (mkt === 'kr' || sym.endsWith('.KS') || sym.endsWith('.KQ') || sym === '^KS11' || sym === '^KQ11' || ex.includes('KOSPI') || ex.includes('KOSDAQ') || ex.includes('KRX')) {
    return { timeZone: 'Asia/Seoul', tzAbbr: 'KST', market: 'kr' };
  }
  if (mkt === 'hk' || sym.endsWith('.HK') || ex.includes('HKEX') || ex.includes('HKG')) {
    return { timeZone: 'Asia/Hong_Kong', tzAbbr: 'HKT', market: 'hk' };
  }
  if (mkt === 'cn' || sym.endsWith('.SS') || sym.endsWith('.SZ') || ex.includes('SHH') || ex.includes('SHZ')) {
    return { timeZone: 'Asia/Shanghai', tzAbbr: 'CST', market: 'cn' };
  }
  if (mkt === 'us' || ex.includes('NASDAQ') || ex.includes('NYSE') || ex.includes('AMEX') || ex === 'US') {
    return { timeZone: 'America/New_York', tzAbbr: 'ET', market: 'us' };
  }

  return { timeZone: 'Asia/Kolkata', tzAbbr: 'IST', market: 'in' };
}

export function extractTimeZoneParts(epochSec, timeZone = 'Asia/Kolkata') {
  const ms = Number(epochSec) * 1000;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false
    }).formatToParts(new Date(ms));

    const map = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const hour = map.hour === '24' ? '00' : (map.hour || '00');
    const year = map.year || '1970';
    const month = map.month || '01';
    const day = map.day || '01';
    const minute = map.minute || '00';
    const second = map.second || '00';
    const weekday = map.weekday || 'Mon';
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday,
      dateStr: `${year}-${month}-${day}`,
      timeStr: `${hour}:${minute}`
    };
  } catch {
    const iso = new Date(ms).toISOString();
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19),
      weekday: 'Mon',
      dateStr: iso.slice(0, 10),
      timeStr: iso.slice(11, 16)
    };
  }
}

export function normalizeLwcTime(rawTime, options = {}) {
  if (rawTime === null || rawTime === undefined) return null;

  let baseSec = null;

  if (typeof rawTime === 'number') {
    if (!Number.isFinite(rawTime) || rawTime <= 0) return null;
    baseSec = rawTime >= 1e11 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
  } else if (rawTime instanceof Date) {
    const ms = rawTime.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    baseSec = Math.floor(ms / 1000);
  } else if (typeof rawTime === 'object' && Number.isFinite(rawTime.year)) {
    const y = Number(rawTime.year);
    const m = Number(rawTime.month || 1) - 1;
    const d = Number(rawTime.day || 1);
    const ms = Date.UTC(y, m, d, 0, 0, 0);
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
  } else if (typeof rawTime === 'string') {
    const trimmed = rawTime.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return normalizeLwcTime(Number(trimmed), options);
    }
    const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      const ms = Date.UTC(
        Number(dateOnlyMatch[1]),
        Number(dateOnlyMatch[2]) - 1,
        Number(dateOnlyMatch[3]),
        0,
        0,
        0
      );
      return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
    }
    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs) && parsedMs > 0) {
      baseSec = Math.floor(parsedMs / 1000);
    }
  }

  if (baseSec === null) return null;

  const interval = options?.interval;
  if (interval === '1d' || interval === '1w') {
    if (baseSec % 86400 !== 0) {
      const tz = options?.timeZone || 'Asia/Kolkata';
      const parts = extractTimeZoneParts(baseSec, tz);
      const canonicalMs = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        0,
        0,
        0
      );
      if (Number.isFinite(canonicalMs) && canonicalMs > 0) {
        return Math.floor(canonicalMs / 1000);
      }
    }
  }

  return baseSec;
}

export function formatLwcTickMark(time, tickMarkType, options = {}) {
  const interval = options.interval || '1d';
  const timeZone = options.timeZone || 'Asia/Kolkata';
  const isDailyOrWeekly = interval === '1d' || interval === '1w';

  const sec = normalizeLwcTime(time, { interval, timeZone });
  if (sec === null) return '';

  const parts = isDailyOrWeekly
    ? extractTimeZoneParts(sec, 'UTC')
    : extractTimeZoneParts(sec, timeZone);

  switch (tickMarkType) {
    case 0:
      return parts.year;
    case 1:
      return `${parts.year}-${parts.month}`;
    case 2:
      return `${parts.month}-${parts.day}`;
    case 3:
      return isDailyOrWeekly ? `${parts.month}-${parts.day}` : `${parts.hour}:${parts.minute}`;
    case 4:
      return isDailyOrWeekly
        ? `${parts.month}-${parts.day}`
        : `${parts.hour}:${parts.minute}:${parts.second}`;
    default:
      return isDailyOrWeekly ? `${parts.month}-${parts.day}` : `${parts.hour}:${parts.minute}`;
  }
}

export function formatLwcCrosshairTime(time, options = {}) {
  const interval = options.interval || '1d';
  const timeZone = options.timeZone || 'Asia/Kolkata';
  const tzAbbr = options.tzAbbr || (timeZone === 'Asia/Kolkata' ? 'IST' : timeZone === 'UTC' ? 'UTC' : '');
  const isDailyOrWeekly = interval === '1d' || interval === '1w';

  const sec = normalizeLwcTime(time, { interval, timeZone });
  if (sec === null) return '';

  if (isDailyOrWeekly) {
    const parts = extractTimeZoneParts(sec, 'UTC');
    return parts.dateStr;
  }

  const parts = extractTimeZoneParts(sec, timeZone);
  return tzAbbr ? `${parts.dateStr} ${parts.timeStr} ${tzAbbr}` : `${parts.dateStr} ${parts.timeStr}`;
}

export function normalizeAndSortCandles(rawCandles, options = {}) {
  if (!Array.isArray(rawCandles) || !rawCandles.length) return [];

  const byTime = new Map();
  for (let i = 0; i < rawCandles.length; i++) {
    const c = rawCandles[i];
    if (!c || typeof c !== 'object') continue;
    const time = normalizeLwcTime(c.time, options);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Number.isFinite(Number(c.volume)) ? Math.max(0, Number(c.volume)) : 0;

    if (
      time === null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    byTime.set(time, {
      time,
      open,
      high: Math.max(high, open, close, low),
      low: Math.min(low, open, close, high),
      close,
      volume,
      originalIndex: i
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function toLwcCandlestickData(candles, options = {}) {
  const normalized = normalizeAndSortCandles(candles, options);
  return normalized.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
}

export function toLwcVolumeData(candles, options = {}) {
  const upColor = options.upColor || DEFAULT_PALETTE.volBull;
  const downColor = options.downColor || DEFAULT_PALETTE.volBear;
  const normalized = normalizeAndSortCandles(candles, options);

  return normalized.map((c) => ({
    time: c.time,
    value: c.volume,
    color: c.close >= c.open ? upColor : downColor
  }));
}

export function toLwcLineData(candles, values, options = {}) {
  if (!Array.isArray(candles) || !Array.isArray(values) || !candles.length) return [];

  const byTime = new Map();
  const len = Math.min(candles.length, values.length);
  for (let i = 0; i < len; i++) {
    const c = candles[i];
    const v = values[i];
    if (!c || v === null || v === undefined || !Number.isFinite(Number(v))) continue;
    const time = normalizeLwcTime(c.time, options);
    if (time === null) continue;
    byTime.set(time, { time, value: Number(v) });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function toLwcBollingerData(candles, boll, options = {}) {
  if (!boll || typeof boll !== 'object') {
    return { upper: [], middle: [], lower: [] };
  }
  return {
    upper: toLwcLineData(candles, boll.upper || [], options),
    middle: toLwcLineData(candles, boll.mid || [], options),
    lower: toLwcLineData(candles, boll.lower || [], options)
  };
}

export function toLwcMacdData(candles, macdObj, palette = {}, options = {}) {
  if (!Array.isArray(candles) || !macdObj || typeof macdObj !== 'object') {
    return { macdLine: [], signalLine: [], histogram: [] };
  }

  const colors = { ...DEFAULT_PALETTE, ...palette };
  const macdLine = toLwcLineData(candles, macdObj.macd || [], options);
  const signalLine = toLwcLineData(candles, macdObj.signal || [], options);

  const histArr = Array.isArray(macdObj.hist) ? macdObj.hist : [];
  const histByTime = new Map();
  const len = Math.min(candles.length, histArr.length);
  let prevHist = 0;

  for (let i = 0; i < len; i++) {
    const c = candles[i];
    const h = histArr[i];
    if (!c || h === null || h === undefined || !Number.isFinite(Number(h))) continue;
    const time = normalizeLwcTime(c.time, options);
    if (time === null) continue;
    const val = Number(h);
    let color;
    if (val >= 0) {
      color = val >= prevHist ? colors.histUpStrong : colors.histUpWeak;
    } else {
      color = val <= prevHist ? colors.histDownStrong : colors.histDownWeak;
    }
    prevHist = val;
    histByTime.set(time, { time, value: val, color });
  }

  const histogram = Array.from(histByTime.values()).sort((a, b) => a.time - b.time);
  return { macdLine, signalLine, histogram };
}

export function toLwcRealtimeUpdate(candle, options = {}) {
  if (!candle || typeof candle !== 'object') return null;
  const normalized = normalizeAndSortCandles([candle], options);
  if (!normalized.length) return null;
  const c = normalized[0];
  const upColor = options.upColor || DEFAULT_PALETTE.volBull;
  const downColor = options.downColor || DEFAULT_PALETTE.volBear;

  return {
    candleBar: {
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    },
    volumeBar: {
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? upColor : downColor
    }
  };
}
