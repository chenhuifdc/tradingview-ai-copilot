// ============================================================================
// Deterministic Rule Engine for Technical Structure & Pattern Recognition (M2 / M2.1 / M2.2)
// Pure JavaScript (Zero dependencies, runs identically in Node.js & Browser)
// ============================================================================

import { calcATR, calcMACD } from './indicators.js';
import { normalizeAndSortCandles } from './lwcAdapter.js';

/**
 * Centralized configuration for the deterministic pattern rule engine.
 * Tuned on real NSE daily data fixtures across 5 sectors:
 * RELIANCE.NS (Energy), TCS.NS (IT), HDFCBANK.NS (Banking), SUNPHARMA.NS (Pharma), ITC.NS (FMCG).
 */
export const PATTERN_ENGINE_CONFIG = {
  tickSize: {
    defaultNse: 0.05
  },
  zigzag: {
    leftBars: 3,
    rightBars: 3,
    minSwingPct: 0.012,
    atrMultiplier: 0.6
  },
  supportResistance: {
    tolerancePct: 0.018,
    weeklyWeight: 2.0,
    dailyWeight: 1.0
  },
  trendline: {
    minBarDistance: 5,
    minTouches: 2,
    touchAtrMult: 0.35,
    touchTolerancePct: 0.005,
    // ATR-multiple tolerance for closing-price violations between startIndex and endIndex.
    // Tuned on real NSE daily bars: 0.25 * ATR(14) accommodates single-day settlement noise
    // while eliminating genuine broken trendlines.
    violationAtrMult: 0.25,
    maxAllowedViolationsInTolerance: 2
  },
  boxRange: {
    minBars: 10,
    maxBars: 65,
    minRangePct: 0.015,
    maxRangePct: 0.12,
    touchZonePct: 0.22
  },
  divergence: {
    minBarDistance: 4,
    maxBarDistance: 80
  },
  scoring: {
    // Smooth non-saturating calibration parameters (theoretical ceiling < 1.0 to avoid clamping ties)
    supportResistance: {
      touchScale: 8.0,
      distanceAtrDecay: 6.0,
      recencyHalfFraction: 0.45,
      weightDistance: 0.34,
      weightTouches: 0.26,
      weightConfluence: 0.18,
      weightRecency: 0.14,
      weightQuality: 0.06
    },
    trendline: {
      touchScale: 2.5,
      distanceAtrDecay: 6.0,
      weightTouches: 0.32,
      weightSpan: 0.22,
      weightRecency: 0.22,
      weightProximity: 0.20,
      maxViolationPenalty: 0.18
    },
    boxRange: {
      touchScale: 8.0,
      durationScale: 30.0,
      weightTouches: 0.30,
      weightTightness: 0.24,
      weightRecency: 0.22,
      weightDuration: 0.12,
      weightClean: 0.08
    },
    divergence: {
      priceMoveScale: 0.05,
      macdRatioScale: 0.55,
      weightPrice: 0.34,
      weightMacd: 0.30,
      weightRecency: 0.24,
      weightSpan: 0.08
    },
    pattern: {
      distanceAtrDecay: 6.0
    }
  },
  // Minimum score thresholds per candidate family (calibrated on 5 NSE sector daily fixtures).
  // Candidates below threshold are dropped rather than padded up to maxCandidates.
  minScores: {
    supportResistance: 0.55,
    trendline: 0.54,
    boxRange: 0.73,
    divergence: 0.42,
    pattern: 0.62
  },
  resultCache: {
    maxEntries: 24
  },
  maxCandidates: {
    supports: 5,
    resistances: 5,
    trendlines: 4,
    boxRanges: 2,
    divergences: 4,
    patterns: 4
  }
};

/**
 * Clamp and round a normalized score to [0, 1] with 4 decimal places.
 */
export function clampScore(rawScore) {
  if (!Number.isFinite(rawScore)) return 0;
  return Number(Math.min(1, Math.max(0, rawScore)).toFixed(4));
}

/**
 * Stable deterministic sort for any candidate list:
 * Primary: score descending
 * Secondary: most recent end index descending
 * Tertiary: deterministic id lexicographical ascending
 */
export function sortCandidatesDeterministically(candidates) {
  return [...candidates].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    const endA = a.endIndex ?? a.lastTouchIndex ?? a.anchorIndex ?? 0;
    const endB = b.endIndex ?? b.lastTouchIndex ?? b.anchorIndex ?? 0;
    if (endB !== endA) return endB - endA;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/**
 * Round price to market tick size (NSE default: ₹0.05 for stocks >= ₹10, ₹0.01 below).
 */
export function roundToTick(price, tickSize = PATTERN_ENGINE_CONFIG.tickSize.defaultNse) {
  if (!Number.isFinite(price)) return 0;
  const effTick = tickSize || (Math.abs(price) < 10 ? 0.01 : PATTERN_ENGINE_CONFIG.tickSize.defaultNse);
  const inv = Math.round(1 / effTick);
  if (inv > 0 && Math.abs(1 / inv - effTick) < 1e-9) {
    return Number((Math.round(price * inv) / inv).toFixed(4));
  }
  return Number((Math.round(price / effTick) * effTick).toFixed(4));
}

/**
 * Pre-normalize input candles using the exact same normalizeAndSortCandles pipeline
 * as the chart renderer so all indices and timestamps are 100% consistent.
 */
export function ensureNormalizedCandles(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  if (options._alreadyNormalized === true) return candles;
  return normalizeAndSortCandles(candles, {
    interval: options.interval || '1d',
    timeZone: options.timeZone || 'Asia/Kolkata'
  });
}

function getLatestAtrValue(atrSeries, fallbackPrice) {
  if (Array.isArray(atrSeries)) {
    for (let i = atrSeries.length - 1; i >= 0; i--) {
      if (Number.isFinite(atrSeries[i]) && atrSeries[i] > 0) {
        return atrSeries[i];
      }
    }
  }
  return Math.max(1e-6, (fallbackPrice || 100) * 0.015);
}

/**
 * Exact in-place Quickselect on a Float64Array slice [0, len) to find the k-th smallest element
 * in O(len) average time with zero heap allocations.
 */
function selectKthInPlace(buf, len, k) {
  let left = 0;
  let right = len - 1;
  while (left < right) {
    const mid = (left + right) >> 1;
    const pivot = buf[mid];
    let i = left;
    let j = right;
    while (i <= j) {
      while (buf[i] < pivot) i++;
      while (buf[j] > pivot) j--;
      if (i <= j) {
        const tmp = buf[i];
        buf[i] = buf[j];
        buf[j] = tmp;
        i++;
        j--;
      }
    }
    if (j < k) left = i;
    if (k < i) right = j;
  }
  return buf[k];
}

const tzDateFormatterCache = new Map();
function getTzDateFormatter(timeZone) {
  const tz = timeZone || 'Asia/Kolkata';
  if (!tzDateFormatterCache.has(tz)) {
    tzDateFormatterCache.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
    );
  }
  return tzDateFormatterCache.get(tz);
}

/**
 * Compute the exchange-timezone calendar date ('YYYY-MM-DD') and Monday week key ('YYYY-MM-DD')
 * for a candle timestamp.
 */
export function getExchangeWeekKey(timeInput, timeZone = 'Asia/Kolkata') {
  const ms = typeof timeInput === 'number'
    ? (timeInput < 1e11 ? timeInput * 1000 : timeInput)
    : Date.parse(String(timeInput));
  if (!Number.isFinite(ms)) return { localDate: '1970-01-01', weekKey: '1969-12-29', dayOfWeek: 0 };

  const formatter = getTzDateFormatter(timeZone);
  const parts = formatter.formatToParts(new Date(ms));
  let year = '1970';
  let month = '01';
  let day = '01';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  const localDate = `${year}-${month}-${day}`;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  // Monday = 0, Tuesday = 1, ..., Friday = 4, Saturday = 5, Sunday = 6
  const dayOfWeek = (new Date(utcMidnight).getUTCDay() + 6) % 7;
  const mondayMs = utcMidnight - dayOfWeek * 86400000;
  const weekKey = new Date(mondayMs).toISOString().slice(0, 10);
  return { localDate, weekKey, dayOfWeek };
}

/**
 * 1. ZigZag / Fractal Swing High & Swing Low Detector
 * Guarantees strictly alternating swing highs and lows with minimum amplitude / ATR filter.
 * Every returned swing point includes both { index, time, price, polarity }.
 */
export function detectZigZagSwings(rawCandles, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 5) return [];

  const leftBars = options.leftBars ?? PATTERN_ENGINE_CONFIG.zigzag.leftBars;
  const rightBars = options.rightBars ?? PATTERN_ENGINE_CONFIG.zigzag.rightBars;
  const minSwingPct = options.minSwingPct ?? PATTERN_ENGINE_CONFIG.zigzag.minSwingPct;
  const atrMultiplier = options.atrMultiplier ?? PATTERN_ENGINE_CONFIG.zigzag.atrMultiplier;
  const atrSeries = options._atrSeries || calcATR(candles, 14);

  const rawCandidates = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const curHigh = candles[i].high;
    const curLow = candles[i].low;
    let isHigh = true;
    let isLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high > curHigh) isHigh = false;
      if (candles[j].low < curLow) isLow = false;
    }

    if (isHigh) {
      rawCandidates.push({
        index: i,
        time: candles[i].time,
        price: curHigh,
        polarity: 'high'
      });
    }
    if (isLow) {
      rawCandidates.push({
        index: i,
        time: candles[i].time,
        price: curLow,
        polarity: 'low'
      });
    }
  }

  // Enforce strict alternation and minimum swing amplitude
  const swings = [];
  for (const cand of rawCandidates) {
    if (swings.length === 0) {
      swings.push({ ...cand });
      continue;
    }

    const last = swings[swings.length - 1];
    if (cand.polarity === last.polarity) {
      if (
        (cand.polarity === 'high' && cand.price >= last.price) ||
        (cand.polarity === 'low' && cand.price <= last.price)
      ) {
        swings[swings.length - 1] = { ...cand };
      }
    } else {
      const priceDelta = Math.abs(cand.price - last.price);
      const pctDelta = priceDelta / Math.max(1e-9, last.price);
      const localAtr = atrSeries[cand.index] || atrSeries[last.index] || (last.price * 0.015);
      const minDelta = Math.max(last.price * minSwingPct, localAtr * atrMultiplier);

      if (priceDelta >= minDelta || pctDelta >= minSwingPct) {
        swings.push({ ...cand });
      }
    }
  }

  // Require at least one confirmed swing leg (>= 2 alternating extrema); a lone unconfirmed pivot has no structure
  return swings.length >= 2 ? swings : [];
}

/**
 * Aggregate daily candles into exchange-timezone (IST Monday–Friday) weekly candles
 * for multi-timeframe (Daily + Weekly) confluence analysis.
 */
export function aggregateDailyToWeeklyCandles(dailyCandles, options = {}) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return [];
  const timeZone = options.timeZone || 'Asia/Kolkata';

  const indexed = dailyCandles
    .map((c, idx) => {
      const ms = typeof c.time === 'number'
        ? (c.time < 1e11 ? c.time * 1000 : c.time)
        : Date.parse(String(c.time));
      return { candle: c, originalIndex: idx, ms };
    })
    .filter((item) =>
      Number.isFinite(item.ms) &&
      Number.isFinite(Number(item.candle.open)) &&
      Number.isFinite(Number(item.candle.high)) &&
      Number.isFinite(Number(item.candle.low)) &&
      Number.isFinite(Number(item.candle.close))
    )
    .sort((a, b) => a.ms - b.ms);

  const weeksMap = new Map();
  for (let i = 0; i < indexed.length; i++) {
    const { candle } = indexed[i];
    const { localDate, weekKey } = getExchangeWeekKey(candle.time, timeZone);
    if (!weeksMap.has(weekKey)) {
      weeksMap.set(weekKey, []);
    }
    weeksMap.get(weekKey).push({
      candle,
      dailyIndex: i,
      localDate
    });
  }

  const weekly = [];
  for (const [weekKey, entries] of weeksMap.entries()) {
    let high = -Infinity;
    let low = Infinity;
    let highDailyIndex = entries[0].dailyIndex;
    let lowDailyIndex = entries[0].dailyIndex;
    let volume = 0;

    for (const entry of entries) {
      const c = entry.candle;
      if (c.high > high) {
        high = c.high;
        highDailyIndex = entry.dailyIndex;
      }
      if (c.low < low) {
        low = c.low;
        lowDailyIndex = entry.dailyIndex;
      }
      volume += Number(c.volume) || 0;
    }

    const first = entries[0];
    const last = entries[entries.length - 1];
    weekly.push({
      weekKey,
      time: first.candle.time,
      startLocalDate: first.localDate,
      endLocalDate: last.localDate,
      barCount: entries.length,
      startDailyIndex: first.dailyIndex,
      endDailyIndex: last.dailyIndex,
      highDailyIndex,
      lowDailyIndex,
      highTime: indexed[highDailyIndex].candle.time,
      lowTime: indexed[lowDailyIndex].candle.time,
      open: first.candle.open,
      high,
      low,
      close: last.candle.close,
      volume
    });
  }
  return weekly;
}

/**
 * 2. Multi-Timeframe Support & Resistance Clustering (Daily + Weekly Resonance)
 * Recalibrated non-saturating score in (0, 0.98) combining:
 * - ATR-normalized distance from current price (closer levels rank higher)
 * - Smooth asymptotic touch count (never hard-clamps to 1.0)
 * - Daily + Weekly confluence
 * - Exponential recency decay
 * - Average touch volume/quality weight
 * Strictly partitions supports (price <= currentPrice) and resistances (price > currentPrice).
 */
export function detectSupportResistanceClusters(rawCandles, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 10) {
    return { supports: [], resistances: [], allClusters: [] };
  }

  const tolerancePct = options.tolerancePct ?? PATTERN_ENGINE_CONFIG.supportResistance.tolerancePct;
  const maxSupports = options.maxLevels ?? PATTERN_ENGINE_CONFIG.maxCandidates.supports;
  const maxResistances = options.maxLevels ?? PATTERN_ENGINE_CONFIG.maxCandidates.resistances;
  const minScore = options.minScore ?? PATTERN_ENGINE_CONFIG.minScores.supportResistance;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const timeZone = options.timeZone || 'Asia/Kolkata';
  const lastIdx = candles.length - 1;
  const currentPrice = candles[lastIdx].close;
  const atrSeries = options._atrSeries || calcATR(candles, 14);
  const latestAtr = getLatestAtrValue(atrSeries, currentPrice);
  const scCfg = PATTERN_ENGINE_CONFIG.scoring.supportResistance;

  const dailySwings = options.swings || detectZigZagSwings(candles, { ...options, _alreadyNormalized: true, _atrSeries: atrSeries });
  const weeklyCandles = aggregateDailyToWeeklyCandles(candles, { timeZone });
  const weeklySwings = detectZigZagSwings(weeklyCandles, {
    leftBars: 1,
    rightBars: 1,
    minSwingPct: 0.02,
    _alreadyNormalized: true
  });

  const avgVolume = candles.reduce((s, c) => s + (Number(c.volume) || 0), 0) / candles.length || 1;

  const points = [];
  for (const s of dailySwings) {
    const vol = Number(candles[s.index]?.volume) || avgVolume;
    const volWeight = Math.min(2.0, Math.max(0.6, vol / avgVolume));
    const recencyWeight = 0.7 + 0.6 * (s.index / Math.max(1, lastIdx));
    points.push({
      price: s.price,
      index: s.index,
      time: candles[s.index].time,
      polarity: s.polarity,
      source: 'daily',
      weight: PATTERN_ENGINE_CONFIG.supportResistance.dailyWeight * volWeight * recencyWeight
    });
  }

  for (const ws of weeklySwings) {
    const wkBar = weeklyCandles[ws.index];
    const mappedDailyIndex = ws.polarity === 'high'
      ? (wkBar?.highDailyIndex ?? wkBar?.endDailyIndex ?? 0)
      : (wkBar?.lowDailyIndex ?? wkBar?.endDailyIndex ?? 0);
    const safeDailyIndex = Math.min(lastIdx, Math.max(0, mappedDailyIndex));
    points.push({
      price: ws.price,
      index: safeDailyIndex,
      time: candles[safeDailyIndex].time,
      polarity: ws.polarity,
      source: 'weekly',
      weight: PATTERN_ENGINE_CONFIG.supportResistance.weeklyWeight
    });
  }

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const pt of sorted) {
    const lastCluster = clusters[clusters.length - 1];
    if (
      lastCluster &&
      Math.abs(pt.price - lastCluster.meanPrice) / Math.max(1e-9, lastCluster.meanPrice) <= tolerancePct
    ) {
      lastCluster.points.push(pt);
      const totalWeight = lastCluster.points.reduce((s, p) => s + p.weight, 0);
      lastCluster.meanPrice = lastCluster.points.reduce((s, p) => s + p.price * p.weight, 0) / totalWeight;
    } else {
      clusters.push({
        meanPrice: pt.price,
        points: [pt]
      });
    }
  }

  const recencyScaleBars = Math.max(20, candles.length * scCfg.recencyHalfFraction);

  const scored = clusters.map((c) => {
    const prices = c.points.map((p) => p.price);
    const dailyTouches = c.points.filter((p) => p.source === 'daily').length;
    const weeklyTouches = c.points.filter((p) => p.source === 'weekly').length;
    const hasConfluence = dailyTouches > 0 && weeklyTouches > 0;
    const totalWeight = c.points.reduce((s, p) => s + p.weight, 0);
    const roundedCenter = roundToTick(c.meanPrice, tickSize);
    const role = roundedCenter <= currentPrice ? 'support' : 'resistance';

    const sortedByIndex = [...c.points].sort(
      (a, b) => a.index - b.index || String(a.time).localeCompare(String(b.time))
    );
    const firstPt = sortedByIndex[0];
    const lastPt = sortedByIndex[sortedByIndex.length - 1];

    // Smooth non-saturating sub-scores (theoretical ceiling = 0.98 < 1.0)
    const distanceAtr = Math.abs(currentPrice - roundedCenter) / Math.max(1e-9, latestAtr);
    const distanceSub = Math.exp(-distanceAtr / scCfg.distanceAtrDecay);
    const touchSub = 1 - Math.exp(-c.points.length / scCfg.touchScale);
    const confluenceSub = hasConfluence ? 1.0 : (weeklyTouches > 0 ? 0.55 : 0.0);
    const recencySub = Math.exp(-(lastIdx - lastPt.index) / recencyScaleBars);
    const avgTouchWeight = totalWeight / Math.max(1, c.points.length);
    const qualitySub = 1 - Math.exp(-avgTouchWeight / 1.5);

    const rawScore =
      scCfg.weightDistance * distanceSub +
      scCfg.weightTouches * touchSub +
      scCfg.weightConfluence * confluenceSub +
      scCfg.weightRecency * recencySub +
      scCfg.weightQuality * qualitySub;
    const score = clampScore(rawScore);

    const startAnchor = {
      index: firstPt.index,
      time: candles[firstPt.index].time,
      price: roundedCenter
    };
    const endAnchor = {
      index: lastPt.index,
      time: candles[lastPt.index].time,
      price: roundedCenter
    };
    const anchors = sortedByIndex.map((p) => ({
      index: p.index,
      time: candles[p.index].time,
      price: roundToTick(p.price, tickSize),
      source: p.source,
      polarity: p.polarity
    }));

    const id = `sr_${role}_${roundedCenter.toFixed(2)}_${startAnchor.index}_${startAnchor.time}_${endAnchor.index}_${endAnchor.time}`;

    return {
      id,
      type: 'support_resistance',
      role,
      price: roundedCenter,
      bandLow: roundToTick(Math.min(...prices), tickSize),
      bandHigh: roundToTick(Math.max(...prices), tickSize),
      distanceAtr: Number(distanceAtr.toFixed(3)),
      touches: c.points.length,
      dailyTouches,
      weeklyTouches,
      confluence: hasConfluence,
      score,
      rawWeightScore: Number((totalWeight * (hasConfluence ? 1.35 : 1.0)).toFixed(3)),
      firstTouchIndex: startAnchor.index,
      firstTouchTime: startAnchor.time,
      lastTouchIndex: endAnchor.index,
      lastTouchTime: endAnchor.time,
      startIndex: startAnchor.index,
      startTime: startAnchor.time,
      endIndex: endAnchor.index,
      endTime: endAnchor.time,
      startAnchor,
      endAnchor,
      anchors
    };
  });

  const allSorted = sortCandidatesDeterministically(scored);

  // Supports ranked strictly below/at currentPrice by recalibrated score (ATR distance + touches + confluence + recency)
  const supports = allSorted
    .filter((c) => c.role === 'support' && c.price <= currentPrice && c.score >= minScore)
    .slice(0, maxSupports);

  // Resistances ranked strictly above currentPrice by recalibrated score
  const resistances = allSorted
    .filter((c) => c.role === 'resistance' && c.price > currentPrice && c.score >= minScore)
    .slice(0, maxResistances);

  return {
    supports,
    resistances,
    allClusters: allSorted
  };
}

/**
 * 3. Deterministic Trendline Detector with ATR-Multiple Closing-Price Violation Tolerance (M2.1 / M2.2)
 */
export function detectTrendlines(rawCandles, swingsInput, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 10) return [];
  const atrSeries = options._atrSeries || calcATR(candles, 14);
  const swings = Array.isArray(swingsInput)
    ? swingsInput
    : detectZigZagSwings(candles, { ...options, _alreadyNormalized: true, _atrSeries: atrSeries });
  if (swings.length < 2) return [];

  const minBarDistance = options.minBarDistance ?? PATTERN_ENGINE_CONFIG.trendline.minBarDistance;
  const minTouches = options.minTouches ?? PATTERN_ENGINE_CONFIG.trendline.minTouches;
  const maxLines = options.maxLines ?? PATTERN_ENGINE_CONFIG.maxCandidates.trendlines;
  const minScore = options.minScore ?? PATTERN_ENGINE_CONFIG.minScores.trendline;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const touchAtrMult = options.touchAtrMult ?? PATTERN_ENGINE_CONFIG.trendline.touchAtrMult;
  const touchTolerancePct = options.touchTolerancePct ?? PATTERN_ENGINE_CONFIG.trendline.touchTolerancePct;
  const violationAtrMult = options.violationAtrMult ?? PATTERN_ENGINE_CONFIG.trendline.violationAtrMult;
  const maxAllowedViolations =
    options.maxAllowedViolationsInTolerance ?? PATTERN_ENGINE_CONFIG.trendline.maxAllowedViolationsInTolerance;

  const lastIdx = candles.length - 1;
  const currentPrice = candles[lastIdx].close;
  const latestAtr = getLatestAtrValue(atrSeries, currentPrice);
  const fallbackAtr = (currentPrice || 100) * 0.015;
  const scCfg = PATTERN_ENGINE_CONFIG.scoring.trendline;
  const spanScale = Math.max(10, candles.length * 0.28);
  const recencyScale = Math.max(20, candles.length * 0.40);

  const lows = swings.filter((s) => s.polarity === 'low');
  const highs = swings.filter((s) => s.polarity === 'high');
  const candidates = [];

  function evaluatePairs(points, role) {
    for (let a = 0; a < points.length - 1; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const p1 = points[a];
        const p2 = points[b];
        const dx = p2.index - p1.index;
        if (dx < minBarDistance) continue;

        const slope = (p2.price - p1.price) / dx;
        if (role === 'support' && slope < -1e-6) continue;
        if (role === 'resistance' && slope > 1e-6) continue;

        let closingViolations = 0;
        let maxViolationPrice = 0;
        let maxViolationAtrRatio = 0;
        let exceededTolerance = false;

        for (let idx = p1.index + 1; idx < p2.index; idx++) {
          const linePrice = p1.price + slope * (idx - p1.index);
          const closePrice = candles[idx].close;
          const barAtr = atrSeries[idx] || atrSeries[p2.index] || fallbackAtr;
          const maxAllowedDist = barAtr * violationAtrMult;

          if (role === 'support' && closePrice < linePrice - 1e-9) {
            const violationDist = linePrice - closePrice;
            const atrRatio = violationDist / Math.max(1e-9, barAtr);
            closingViolations++;
            if (violationDist > maxViolationPrice) maxViolationPrice = violationDist;
            if (atrRatio > maxViolationAtrRatio) maxViolationAtrRatio = atrRatio;
            if (violationDist > maxAllowedDist + 1e-9 || closingViolations > maxAllowedViolations) {
              exceededTolerance = true;
              break;
            }
          }

          if (role === 'resistance' && closePrice > linePrice + 1e-9) {
            const violationDist = closePrice - linePrice;
            const atrRatio = violationDist / Math.max(1e-9, barAtr);
            closingViolations++;
            if (violationDist > maxViolationPrice) maxViolationPrice = violationDist;
            if (atrRatio > maxViolationAtrRatio) maxViolationAtrRatio = atrRatio;
            if (violationDist > maxAllowedDist + 1e-9 || closingViolations > maxAllowedViolations) {
              exceededTolerance = true;
              break;
            }
          }
        }

        if (exceededTolerance) continue;

        const touchedPoints = [];
        for (const pt of points) {
          if (pt.index < p1.index || pt.index > p2.index) continue;
          const linePrice = p1.price + slope * (pt.index - p1.index);
          const localAtr = atrSeries[pt.index] || fallbackAtr;
          const tol = Math.max(localAtr * touchAtrMult, linePrice * touchTolerancePct);
          if (Math.abs(pt.price - linePrice) <= tol) {
            touchedPoints.push({
              index: pt.index,
              time: candles[pt.index].time,
              price: roundToTick(pt.price, tickSize),
              linePrice: roundToTick(linePrice, tickSize),
              polarity: pt.polarity
            });
          }
        }

        if (touchedPoints.length < minTouches) continue;

        const projectedCurrentPrice = p1.price + slope * (lastIdx - p1.index);
        const distanceAtr = Math.abs(currentPrice - projectedCurrentPrice) / Math.max(1e-9, latestAtr);

        const startAnchor = {
          index: p1.index,
          time: candles[p1.index].time,
          price: roundToTick(p1.price, tickSize),
          polarity: p1.polarity
        };
        const endAnchor = {
          index: p2.index,
          time: candles[p2.index].time,
          price: roundToTick(p2.price, tickSize),
          polarity: p2.polarity
        };

        // Smooth non-saturating trendline score (theoretical max = 0.96)
        const touchSub = 1 - Math.exp(-(touchedPoints.length - 1) / scCfg.touchScale);
        const spanSub = 1 - Math.exp(-dx / spanScale);
        const recencySub = Math.exp(-(lastIdx - p2.index) / recencyScale);
        const proximitySub = Math.exp(-distanceAtr / scCfg.distanceAtrDecay);
        const violationPenalty = closingViolations > 0
          ? Math.min(scCfg.maxViolationPenalty, 0.04 * closingViolations + 0.12 * maxViolationAtrRatio)
          : 0;
        const score = clampScore(
          scCfg.weightTouches * touchSub +
          scCfg.weightSpan * spanSub +
          scCfg.weightRecency * recencySub +
          scCfg.weightProximity * proximitySub -
          violationPenalty
        );

        const id = `tl_${role}_${startAnchor.index}_${startAnchor.time}_${endAnchor.index}_${endAnchor.time}`;

        candidates.push({
          id,
          type: 'trendline',
          role,
          startIndex: startAnchor.index,
          startTime: startAnchor.time,
          startPrice: startAnchor.price,
          endIndex: endAnchor.index,
          endTime: endAnchor.time,
          endPrice: endAnchor.price,
          startAnchor,
          endAnchor,
          anchors: [startAnchor, endAnchor],
          touchAnchors: touchedPoints,
          slope: Number(slope.toFixed(6)),
          touches: touchedPoints.length,
          spanBars: dx,
          projectedCurrentPrice: roundToTick(projectedCurrentPrice, tickSize),
          distanceAtr: Number(distanceAtr.toFixed(3)),
          closingViolations,
          maxViolationPrice: roundToTick(maxViolationPrice, tickSize),
          maxViolationAtrRatio: Number(maxViolationAtrRatio.toFixed(4)),
          withinTolerance: true,
          violationAtrMult,
          score
        });
      }
    }
  }

  evaluatePairs(lows, 'support');
  evaluatePairs(highs, 'resistance');

  return sortCandidatesDeterministically(candidates)
    .filter((c) => c.score >= minScore)
    .slice(0, maxLines);
}

/**
 * 4. Consolidation Box (Range) Detector
 * Optimized via pre-extracted Float64Arrays + reusable scratch buffers + O(len) Quickselect
 * (profile-driven fix: eliminates ~28,000 per-window array allocations & sorts on 1500 bars).
 */
export function detectBoxRanges(rawCandles, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  const minBars = options.minBars ?? PATTERN_ENGINE_CONFIG.boxRange.minBars;
  const maxBars = options.maxBars ?? PATTERN_ENGINE_CONFIG.boxRange.maxBars;
  const minRangePct = options.minRangePct ?? PATTERN_ENGINE_CONFIG.boxRange.minRangePct;
  const maxRangePct = options.maxRangePct ?? PATTERN_ENGINE_CONFIG.boxRange.maxRangePct;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const maxBoxes = options.maxBoxes ?? PATTERN_ENGINE_CONFIG.maxCandidates.boxRanges;
  const minScore = options.minScore ?? PATTERN_ENGINE_CONFIG.minScores.boxRange;

  const n = candles.length;
  if (n < minBars) return [];

  const effMaxLen = Math.min(maxBars, n);
  const highsArr = new Float64Array(n);
  const lowsArr = new Float64Array(n);
  const closesArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    highsArr[i] = candles[i].high;
    lowsArr[i] = candles[i].low;
    closesArr[i] = candles[i].close;
  }

  const tmpHighs = new Float64Array(effMaxLen);
  const tmpLows = new Float64Array(effMaxLen);

  const boxes = [];
  const step = Math.max(2, Math.floor(minBars / 3));
  const lastIdx = n - 1;
  const recencyScale = Math.max(20, n * 0.40);
  const scCfg = PATTERN_ENGINE_CONFIG.scoring.boxRange;

  for (let len = minBars; len <= effMaxLen; len += step) {
    const kUpper = Math.floor(len * 0.9);
    const kLower = Math.floor(len * 0.1);
    const maxOutside = Math.floor(len * 0.1);

    for (let start = n - len; start >= 0; start -= step) {
      const end = start + len - 1;

      for (let k = 0; k < len; k++) {
        tmpHighs[k] = highsArr[start + k];
        tmpLows[k] = lowsArr[start + k];
      }

      const upper = selectKthInPlace(tmpHighs, len, kUpper);
      const lower = selectKthInPlace(tmpLows, len, kLower);
      const mid = (upper + lower) * 0.5;
      const heightPct = (upper - lower) / Math.max(1e-9, mid);

      if (heightPct < minRangePct || heightPct > maxRangePct) continue;

      const touchBand = (upper - lower) * PATTERN_ENGINE_CONFIG.boxRange.touchZonePct;
      const upperThresh = upper - touchBand;
      const lowerThresh = lower + touchBand;
      const closeMax = upper + touchBand;
      const closeMin = lower - touchBand;

      let upperTouches = 0;
      let lowerTouches = 0;
      let firstUpperTouchIndex = -1;
      let firstLowerTouchIndex = -1;
      let upperTouchIndex = start;
      let lowerTouchIndex = start;
      let outsideCloses = 0;

      for (let idx = start; idx <= end; idx++) {
        if (highsArr[idx] >= upperThresh) {
          if (firstUpperTouchIndex === -1) firstUpperTouchIndex = idx;
          upperTouches++;
          upperTouchIndex = idx;
        }
        if (lowsArr[idx] <= lowerThresh) {
          if (firstLowerTouchIndex === -1) firstLowerTouchIndex = idx;
          lowerTouches++;
          lowerTouchIndex = idx;
        }
        const cl = closesArr[idx];
        if (cl > closeMax || cl < closeMin) {
          outsideCloses++;
          if (outsideCloses > maxOutside) break;
        }
      }

      const hasHorizontalOscillation =
        firstUpperTouchIndex !== -1 &&
        firstLowerTouchIndex !== -1 &&
        firstUpperTouchIndex < lowerTouchIndex &&
        firstLowerTouchIndex < upperTouchIndex;

      if (upperTouches >= 2 && lowerTouches >= 2 && outsideCloses <= maxOutside && hasHorizontalOscillation) {
        const roundedUpper = roundToTick(upper, tickSize);
        const roundedLower = roundToTick(lower, tickSize);
        const startAnchor = {
          index: start,
          time: candles[start].time,
          price: roundedLower
        };
        const endAnchor = {
          index: end,
          time: candles[end].time,
          price: roundedUpper
        };
        const upperAnchor = {
          index: upperTouchIndex,
          time: candles[upperTouchIndex].time,
          price: roundedUpper,
          polarity: 'high'
        };
        const lowerAnchor = {
          index: lowerTouchIndex,
          time: candles[lowerTouchIndex].time,
          price: roundedLower,
          polarity: 'low'
        };

        // Smooth non-saturating box score (theoretical max = 0.96)
        const touchSub = 1 - Math.exp(-(upperTouches + lowerTouches) / scCfg.touchScale);
        const tightnessSub = Math.max(0, 1 - heightPct / maxRangePct);
        const recencySub = Math.exp(-(lastIdx - end) / recencyScale);
        const durationSub = 1 - Math.exp(-len / scCfg.durationScale);
        const cleanSub = Math.max(0, 1 - outsideCloses / Math.max(1, len * 0.12));
        const score = clampScore(
          scCfg.weightTouches * touchSub +
          scCfg.weightTightness * tightnessSub +
          scCfg.weightRecency * recencySub +
          scCfg.weightDuration * durationSub +
          scCfg.weightClean * cleanSub
        );
        const id = `box_${start}_${candles[start].time}_${end}_${candles[end].time}`;

        boxes.push({
          id,
          type: 'box_range',
          startIndex: start,
          endIndex: end,
          startTime: candles[start].time,
          endTime: candles[end].time,
          startAnchor,
          endAnchor,
          upperAnchor,
          lowerAnchor,
          anchors: [startAnchor, endAnchor, upperAnchor, lowerAnchor],
          upperBound: roundedUpper,
          lowerBound: roundedLower,
          midPrice: roundToTick(mid, tickSize),
          heightPct: Number((heightPct * 100).toFixed(2)),
          upperTouches,
          lowerTouches,
          barCount: len,
          score
        });
      }
    }
  }

  // Filter below-threshold boxes before deduplicating overlapping ranges
  const sorted = sortCandidatesDeterministically(boxes).filter((b) => b.score >= minScore);
  const selected = [];
  for (const box of sorted) {
    const overlaps = selected.some(
      (b) => Math.max(b.startIndex, box.startIndex) <= Math.min(b.endIndex, box.endIndex)
    );
    if (!overlaps) {
      selected.push(box);
      if (selected.length >= maxBoxes) break;
    }
  }
  return sortCandidatesDeterministically(selected);
}

/**
 * 5. MACD Divergence Detector (Regular Bullish & Bearish Divergences)
 */
export function detectMacdDivergences(rawCandles, swingsInput, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 30) return [];

  const swings = Array.isArray(swingsInput)
    ? swingsInput
    : detectZigZagSwings(candles, { ...options, _alreadyNormalized: true });
  const { macd, hist } = calcMACD(candles, 10, 21, 9);
  const histogram = hist || [];
  const minBarDistance = options.minBarDistance ?? PATTERN_ENGINE_CONFIG.divergence.minBarDistance;
  const maxBarDistance = options.maxBarDistance ?? PATTERN_ENGINE_CONFIG.divergence.maxBarDistance;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const maxDivergences = options.maxDivergences ?? PATTERN_ENGINE_CONFIG.maxCandidates.divergences;
  const minScore = options.minScore ?? PATTERN_ENGINE_CONFIG.minScores.divergence;

  const lastIdx = candles.length - 1;
  const recencyScale = Math.max(20, candles.length * 0.35);
  const scCfg = PATTERN_ENGINE_CONFIG.scoring.divergence;

  const lows = swings.filter((s) => s.polarity === 'low');
  const highs = swings.filter((s) => s.polarity === 'high');
  const divergences = [];

  // Bullish divergences on swing lows
  for (let i = 0; i < lows.length - 1; i++) {
    const p1 = lows[i];
    const p2 = lows[i + 1];
    const dist = p2.index - p1.index;
    if (dist < minBarDistance || dist > maxBarDistance) continue;

    const m1 = macd[p1.index];
    const m2 = macd[p2.index];
    const h1 = histogram[p1.index];
    const h2 = histogram[p2.index];
    if (m1 == null || m2 == null) continue;

    const priceLowerLow = p2.price < p1.price * 0.998;
    const macdHigherLow = m2 > m1 || (h1 != null && h2 != null && h2 > h1 && m2 >= m1 * 0.98);

    if (priceLowerLow && macdHigherLow) {
      const startAnchor = {
        index: p1.index,
        time: candles[p1.index].time,
        price: roundToTick(p1.price, tickSize),
        macd: Number(m1.toFixed(4)),
        polarity: 'low'
      };
      const endAnchor = {
        index: p2.index,
        time: candles[p2.index].time,
        price: roundToTick(p2.price, tickSize),
        macd: Number(m2.toFixed(4)),
        polarity: 'low'
      };
      const priceDropPct = (p1.price - p2.price) / Math.max(1e-9, p1.price);
      const macdRise = Math.abs(m2 - m1) / Math.max(1e-4, Math.abs(m1));
      const priceSub = 1 - Math.exp(-priceDropPct / scCfg.priceMoveScale);
      const macdSub = 1 - Math.exp(-macdRise / scCfg.macdRatioScale);
      const recencySub = Math.exp(-(lastIdx - p2.index) / recencyScale);
      const spanSub = Math.exp(-Math.abs(dist - 20) / 35);
      const score = clampScore(
        scCfg.weightPrice * priceSub +
        scCfg.weightMacd * macdSub +
        scCfg.weightRecency * recencySub +
        scCfg.weightSpan * spanSub
      );
      const id = `div_bullish_${startAnchor.index}_${startAnchor.time}_${endAnchor.index}_${endAnchor.time}`;

      divergences.push({
        id,
        type: 'macd_divergence',
        bias: 'bullish',
        label: 'MACD 底背离 (Bullish Divergence)',
        startIndex: startAnchor.index,
        startTime: startAnchor.time,
        endIndex: endAnchor.index,
        endTime: endAnchor.time,
        anchorIndex: endAnchor.index,
        anchorTime: endAnchor.time,
        anchorPrice: endAnchor.price,
        startAnchor,
        endAnchor,
        anchors: [startAnchor, endAnchor],
        score
      });
    }
  }

  // Bearish divergences on swing highs
  for (let i = 0; i < highs.length - 1; i++) {
    const p1 = highs[i];
    const p2 = highs[i + 1];
    const dist = p2.index - p1.index;
    if (dist < minBarDistance || dist > maxBarDistance) continue;

    const m1 = macd[p1.index];
    const m2 = macd[p2.index];
    const h1 = histogram[p1.index];
    const h2 = histogram[p2.index];
    if (m1 == null || m2 == null) continue;

    const priceHigherHigh = p2.price > p1.price * 1.002;
    const macdLowerHigh = m2 < m1 || (h1 != null && h2 != null && h2 < h1 && m2 <= m1 * 1.02);

    if (priceHigherHigh && macdLowerHigh) {
      const startAnchor = {
        index: p1.index,
        time: candles[p1.index].time,
        price: roundToTick(p1.price, tickSize),
        macd: Number(m1.toFixed(4)),
        polarity: 'high'
      };
      const endAnchor = {
        index: p2.index,
        time: candles[p2.index].time,
        price: roundToTick(p2.price, tickSize),
        macd: Number(m2.toFixed(4)),
        polarity: 'high'
      };
      const priceRisePct = (p2.price - p1.price) / Math.max(1e-9, p1.price);
      const macdDrop = Math.abs(m1 - m2) / Math.max(1e-4, Math.abs(m1));
      const priceSub = 1 - Math.exp(-priceRisePct / scCfg.priceMoveScale);
      const macdSub = 1 - Math.exp(-macdDrop / scCfg.macdRatioScale);
      const recencySub = Math.exp(-(lastIdx - p2.index) / recencyScale);
      const spanSub = Math.exp(-Math.abs(dist - 20) / 35);
      const score = clampScore(
        scCfg.weightPrice * priceSub +
        scCfg.weightMacd * macdSub +
        scCfg.weightRecency * recencySub +
        scCfg.weightSpan * spanSub
      );
      const id = `div_bearish_${startAnchor.index}_${startAnchor.time}_${endAnchor.index}_${endAnchor.time}`;

      divergences.push({
        id,
        type: 'macd_divergence',
        bias: 'bearish',
        label: 'MACD 顶背离 (Bearish Divergence)',
        startIndex: startAnchor.index,
        startTime: startAnchor.time,
        endIndex: endAnchor.index,
        endTime: endAnchor.time,
        anchorIndex: endAnchor.index,
        anchorTime: endAnchor.time,
        anchorPrice: endAnchor.price,
        startAnchor,
        endAnchor,
        anchors: [startAnchor, endAnchor],
        score
      });
    }
  }

  return sortCandidatesDeterministically(divergences)
    .filter((c) => c.score >= minScore)
    .slice(0, maxDivergences);
}

/**
 * 6. Classic Geometric Chart Pattern Detector
 */
export function detectChartPatterns(rawCandles, swingsInput, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 15) return [];

  const atrSeries = options._atrSeries || calcATR(candles, 14);
  const swings = Array.isArray(swingsInput)
    ? swingsInput
    : detectZigZagSwings(candles, { ...options, _alreadyNormalized: true, _atrSeries: atrSeries });
  if (swings.length < 3) return [];

  const tolerancePct = options.tolerancePct ?? 0.022;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const maxPatterns = options.maxPatterns ?? PATTERN_ENGINE_CONFIG.maxCandidates.patterns;
  const minScore = options.minScore ?? PATTERN_ENGINE_CONFIG.minScores.pattern;
  const lastIdx = candles.length - 1;
  const currentPrice = candles[lastIdx].close;
  const latestAtr = getLatestAtrValue(atrSeries, currentPrice);
  const recencyScale = Math.max(20, candles.length * 0.40);
  const proxDecay = PATTERN_ENGINE_CONFIG.scoring.pattern.distanceAtrDecay;
  const patterns = [];

  function makePoint(role, swingPt) {
    return {
      role,
      index: swingPt.index,
      time: candles[swingPt.index].time,
      price: roundToTick(swingPt.price, tickSize)
    };
  }

  // 6a. Double Bottom (L1 - H1 - L2) & Double Top (H1 - L1 - H2)
  for (let i = 0; i <= swings.length - 3; i++) {
    const s1 = swings[i];
    const s2 = swings[i + 1];
    const s3 = swings[i + 2];

    if (s1.polarity === 'low' && s2.polarity === 'high' && s3.polarity === 'low') {
      const diffPct = Math.abs(s1.price - s3.price) / Math.max(1e-9, s1.price);
      const bouncePct = (s2.price - Math.max(s1.price, s3.price)) / Math.max(1e-9, s1.price);
      if (diffPct <= tolerancePct && bouncePct >= 0.025) {
        const points = [
          makePoint('left_bottom', s1),
          makePoint('neckline', s2),
          makePoint('right_bottom', s3)
        ];
        const symmetrySub = Math.exp(-diffPct / (tolerancePct * 0.65));
        const amplitudeSub = 1 - Math.exp(-bouncePct / 0.08);
        const recencySub = Math.exp(-(lastIdx - s3.index) / recencyScale);
        const proxSub = Math.exp(-Math.abs(currentPrice - s2.price) / Math.max(1e-9, latestAtr * proxDecay));
        const score = clampScore(0.30 * symmetrySub + 0.26 * amplitudeSub + 0.24 * recencySub + 0.16 * proxSub);
        const id = `pat_double_bottom_${s1.index}_${candles[s1.index].time}_${s3.index}_${candles[s3.index].time}`;

        patterns.push({
          id,
          type: 'double_bottom',
          bias: 'bullish',
          label: '双底 (W底 / Double Bottom)',
          necklinePrice: roundToTick(s2.price, tickSize),
          targetPrice: roundToTick(s2.price + (s2.price - (s1.price + s3.price) / 2), tickSize),
          startIndex: s1.index,
          endIndex: s3.index,
          startTime: candles[s1.index].time,
          endTime: candles[s3.index].time,
          startAnchor: points[0],
          endAnchor: points[2],
          points,
          anchors: points,
          score
        });
      }
    }

    if (s1.polarity === 'high' && s2.polarity === 'low' && s3.polarity === 'high') {
      const diffPct = Math.abs(s1.price - s3.price) / Math.max(1e-9, s1.price);
      const dropPct = (Math.min(s1.price, s3.price) - s2.price) / Math.max(1e-9, s2.price);
      if (diffPct <= tolerancePct && dropPct >= 0.025) {
        const points = [
          makePoint('left_top', s1),
          makePoint('neckline', s2),
          makePoint('right_top', s3)
        ];
        const symmetrySub = Math.exp(-diffPct / (tolerancePct * 0.65));
        const amplitudeSub = 1 - Math.exp(-dropPct / 0.08);
        const recencySub = Math.exp(-(lastIdx - s3.index) / recencyScale);
        const proxSub = Math.exp(-Math.abs(currentPrice - s2.price) / Math.max(1e-9, latestAtr * proxDecay));
        const score = clampScore(0.30 * symmetrySub + 0.26 * amplitudeSub + 0.24 * recencySub + 0.16 * proxSub);
        const id = `pat_double_top_${s1.index}_${candles[s1.index].time}_${s3.index}_${candles[s3.index].time}`;

        patterns.push({
          id,
          type: 'double_top',
          bias: 'bearish',
          label: '双顶 (M顶 / Double Top)',
          necklinePrice: roundToTick(s2.price, tickSize),
          targetPrice: roundToTick(s2.price - ((s1.price + s3.price) / 2 - s2.price), tickSize),
          startIndex: s1.index,
          endIndex: s3.index,
          startTime: candles[s1.index].time,
          endTime: candles[s3.index].time,
          startAnchor: points[0],
          endAnchor: points[2],
          points,
          anchors: points,
          score
        });
      }
    }
  }

  // 6b. Head and Shoulders (5 consecutive swings)
  for (let i = 0; i <= swings.length - 5; i++) {
    const [s1, s2, s3, s4, s5] = swings.slice(i, i + 5);

    if (s1.polarity === 'high' && s3.polarity === 'high' && s5.polarity === 'high') {
      const shoulderDiff = Math.abs(s1.price - s5.price) / Math.max(1e-9, s1.price);
      const headProminence = (s3.price - Math.max(s1.price, s5.price)) / Math.max(1e-9, s1.price);
      if (s3.price > s1.price && s3.price > s5.price && shoulderDiff <= tolerancePct * 1.5 && headProminence >= 0.015) {
        const neckline = (s2.price + s4.price) / 2;
        const points = [
          makePoint('left_shoulder', s1),
          makePoint('neckline_left', s2),
          makePoint('head', s3),
          makePoint('neckline_right', s4),
          makePoint('right_shoulder', s5)
        ];
        const symmetrySub = Math.exp(-shoulderDiff / (tolerancePct * 0.9));
        const prominenceSub = 1 - Math.exp(-headProminence / 0.06);
        const recencySub = Math.exp(-(lastIdx - s5.index) / recencyScale);
        const proxSub = Math.exp(-Math.abs(currentPrice - neckline) / Math.max(1e-9, latestAtr * proxDecay));
        const score = clampScore(0.28 * symmetrySub + 0.28 * prominenceSub + 0.24 * recencySub + 0.16 * proxSub);
        const id = `pat_head_and_shoulders_top_${s1.index}_${candles[s1.index].time}_${s5.index}_${candles[s5.index].time}`;

        patterns.push({
          id,
          type: 'head_and_shoulders_top',
          bias: 'bearish',
          label: '头肩顶 (Head & Shoulders Top)',
          necklinePrice: roundToTick(neckline, tickSize),
          targetPrice: roundToTick(neckline - (s3.price - neckline), tickSize),
          startIndex: s1.index,
          endIndex: s5.index,
          startTime: candles[s1.index].time,
          endTime: candles[s5.index].time,
          startAnchor: points[0],
          endAnchor: points[4],
          points,
          anchors: points,
          score
        });
      }
    }

    if (s1.polarity === 'low' && s3.polarity === 'low' && s5.polarity === 'low') {
      const shoulderDiff = Math.abs(s1.price - s5.price) / Math.max(1e-9, s1.price);
      const headProminence = (Math.min(s1.price, s5.price) - s3.price) / Math.max(1e-9, s3.price);
      if (s3.price < s1.price && s3.price < s5.price && shoulderDiff <= tolerancePct * 1.5 && headProminence >= 0.015) {
        const neckline = (s2.price + s4.price) / 2;
        const points = [
          makePoint('left_shoulder', s1),
          makePoint('neckline_left', s2),
          makePoint('head', s3),
          makePoint('neckline_right', s4),
          makePoint('right_shoulder', s5)
        ];
        const symmetrySub = Math.exp(-shoulderDiff / (tolerancePct * 0.9));
        const prominenceSub = 1 - Math.exp(-headProminence / 0.06);
        const recencySub = Math.exp(-(lastIdx - s5.index) / recencyScale);
        const proxSub = Math.exp(-Math.abs(currentPrice - neckline) / Math.max(1e-9, latestAtr * proxDecay));
        const score = clampScore(0.28 * symmetrySub + 0.28 * prominenceSub + 0.24 * recencySub + 0.16 * proxSub);
        const id = `pat_head_and_shoulders_bottom_${s1.index}_${candles[s1.index].time}_${s5.index}_${candles[s5.index].time}`;

        patterns.push({
          id,
          type: 'head_and_shoulders_bottom',
          bias: 'bullish',
          label: '头肩底 (Inverse Head & Shoulders)',
          necklinePrice: roundToTick(neckline, tickSize),
          targetPrice: roundToTick(neckline + (neckline - s3.price), tickSize),
          startIndex: s1.index,
          endIndex: s5.index,
          startTime: candles[s1.index].time,
          endTime: candles[s5.index].time,
          startAnchor: points[0],
          endAnchor: points[4],
          points,
          anchors: points,
          score
        });
      }
    }
  }

  // 6c. Converging Triangle (4 consecutive swings: H1-L1-H2-L2 or L1-H1-L2-H2)
  for (let i = 0; i <= swings.length - 4; i++) {
    const windowSwings = swings.slice(i, i + 4);
    const highs = windowSwings.filter((s) => s.polarity === 'high');
    const lows = windowSwings.filter((s) => s.polarity === 'low');
    if (highs.length === 2 && lows.length === 2) {
      const [h1, h2] = highs;
      const [l1, l2] = lows;
      const highSlope = (h2.price - h1.price) / Math.max(1, h2.index - h1.index);
      const lowSlope = (l2.price - l1.price) / Math.max(1, l2.index - l1.index);

      if (highSlope <= 0.001 * h1.price && lowSlope >= -0.001 * l1.price && highSlope < lowSlope) {
        const initialSpan = h1.price - l1.price;
        const finalSpan = h2.price - l2.price;
        if (initialSpan > 0 && finalSpan > 0 && finalSpan < initialSpan * 0.85) {
          const isAscending = Math.abs(highSlope) / h1.price < 0.0005 && lowSlope > 0;
          const isDescending = Math.abs(lowSlope) / l1.price < 0.0005 && highSlope < 0;
          const subtype = isAscending
            ? 'ascending_triangle'
            : isDescending
              ? 'descending_triangle'
              : 'symmetrical_triangle';
          const bias = isAscending ? 'bullish' : isDescending ? 'bearish' : 'neutral';
          const startIdx = Math.min(h1.index, l1.index);
          const endIdx = Math.max(h2.index, l2.index);
          const points = [
            makePoint('upper_start', h1),
            makePoint('upper_end', h2),
            makePoint('lower_start', l1),
            makePoint('lower_end', l2)
          ];
          const convergenceRatio = 1 - finalSpan / initialSpan;
          const midPrice = (h2.price + l2.price) * 0.5;
          const convSub = 1 - Math.exp(-convergenceRatio / 0.45);
          const recencySub = Math.exp(-(lastIdx - endIdx) / recencyScale);
          const spanSub = 1 - Math.exp(-(endIdx - startIdx) / 35);
          const proxSub = Math.exp(-Math.abs(currentPrice - midPrice) / Math.max(1e-9, latestAtr * proxDecay));
          const score = clampScore(0.32 * convSub + 0.28 * recencySub + 0.18 * spanSub + 0.18 * proxSub);
          const id = `pat_${subtype}_${startIdx}_${candles[startIdx].time}_${endIdx}_${candles[endIdx].time}`;

          patterns.push({
            id,
            type: subtype,
            bias,
            label:
              subtype === 'ascending_triangle'
                ? '上升三角形 (Ascending Triangle)'
                : subtype === 'descending_triangle'
                  ? '下降三角形 (Descending Triangle)'
                  : '收敛三角形 (Symmetrical Triangle)',
            startIndex: startIdx,
            endIndex: endIdx,
            startTime: candles[startIdx].time,
            endTime: candles[endIdx].time,
            startAnchor: {
              index: startIdx,
              time: candles[startIdx].time,
              price: roundToTick(candles[startIdx].close, tickSize)
            },
            endAnchor: {
              index: endIdx,
              time: candles[endIdx].time,
              price: roundToTick(candles[endIdx].close, tickSize)
            },
            points,
            anchors: points,
            score
          });
        }
      }
    }
  }

  return sortCandidatesDeterministically(patterns)
    .filter((c) => c.score >= minScore)
    .slice(0, maxPatterns);
}

// ============================================================================
// Data-Version Result Cache (prevents redundant recomputation on identical bar sets)
// ============================================================================
const engineResultCache = new Map();
const engineCacheStats = { hits: 0, misses: 0 };

function cloneEngineResult(val) {
  if (typeof structuredClone === 'function') {
    return structuredClone(val);
  }
  return JSON.parse(JSON.stringify(val));
}

export function computeCandlesVersionKey(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return 'empty';
  let h1 = 2166136261 >>> 0;
  let h2 = 0x811c9dc5 >>> 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    if (typeof c.time === 'number') {
      h1 = Math.imul(h1 ^ (Math.floor(c.time) >>> 0), 16777619) >>> 0;
    } else if (typeof c.time === 'string') {
      for (let j = 0; j < c.time.length; j++) {
        h1 = Math.imul(h1 ^ c.time.charCodeAt(j), 16777619) >>> 0;
      }
    }
    const o = Math.round((Number(c.open) || 0) * 100);
    const h = Math.round((Number(c.high) || 0) * 100);
    const l = Math.round((Number(c.low) || 0) * 100);
    const cl = Math.round((Number(c.close) || 0) * 100);
    h1 = Math.imul(h1 ^ (cl >>> 0), 16777619) >>> 0;
    h1 = Math.imul(h1 ^ (o >>> 0), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (h >>> 0), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (l >>> 0), 16777619) >>> 0;
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  const optKeys = Object.keys(options || {})
    .filter((k) => k !== 'useCache' && !k.startsWith('_') && options[k] !== undefined)
    .sort();
  const optSig = optKeys.map((k) => `${k}=${String(options[k])}`).join('&');
  return `${candles.length}|${first?.time}|${last?.time}|${last?.close}|${h1.toString(16)}_${h2.toString(16)}|${optSig}`;
}

export function getPatternEngineCacheStats() {
  return {
    hits: engineCacheStats.hits,
    misses: engineCacheStats.misses,
    size: engineResultCache.size
  };
}

export function clearPatternEngineCache() {
  engineResultCache.clear();
  engineCacheStats.hits = 0;
  engineCacheStats.misses = 0;
}

/**
 * Master entry point: Run the entire deterministic pattern rule engine on daily candles.
 * Supports deterministic data-version result caching (`useCache: true` by default; pass
 * `{ useCache: false }` for raw compute benchmarks). Cached entries are isolated via deep clone
 * so caller mutations can never pollute cached results.
 */
export function runPatternRuleEngine(rawCandles, options = {}) {
  const useCache = options.useCache !== false;
  const cacheKey = useCache ? computeCandlesVersionKey(rawCandles, options) : null;

  if (useCache && cacheKey && engineResultCache.has(cacheKey)) {
    const cached = engineResultCache.get(cacheKey);
    // Refresh LRU order
    engineResultCache.delete(cacheKey);
    engineResultCache.set(cacheKey, cached);
    engineCacheStats.hits += 1;
    return cloneEngineResult(cached);
  }

  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length === 0) {
    return {
      candles: [],
      swings: [],
      supportResistance: { supports: [], resistances: [], allClusters: [] },
      trendlines: [],
      boxRanges: [],
      divergences: [],
      patterns: [],
      config: cloneEngineResult(PATTERN_ENGINE_CONFIG)
    };
  }

  const atrSeries = calcATR(candles, 14);
  const normalizedOpts = { ...options, _alreadyNormalized: true, _atrSeries: atrSeries };
  const swings = detectZigZagSwings(candles, normalizedOpts);
  const supportResistance = detectSupportResistanceClusters(candles, { ...normalizedOpts, swings });
  const trendlines = detectTrendlines(candles, swings, normalizedOpts);
  const boxRanges = detectBoxRanges(candles, normalizedOpts);
  const divergences = detectMacdDivergences(candles, swings, normalizedOpts);
  const patterns = detectChartPatterns(candles, swings, normalizedOpts);

  const result = {
    candles,
    swings,
    supportResistance,
    trendlines,
    boxRanges,
    divergences,
    patterns,
    config: PATTERN_ENGINE_CONFIG
  };

  if (useCache && cacheKey) {
    engineCacheStats.misses += 1;
    const maxEntries = PATTERN_ENGINE_CONFIG.resultCache.maxEntries;
    if (engineResultCache.size >= maxEntries) {
      const oldestKey = engineResultCache.keys().next().value;
      if (oldestKey !== undefined) engineResultCache.delete(oldestKey);
    }
    engineResultCache.set(cacheKey, result);
    return cloneEngineResult(result);
  }

  return result;
}
