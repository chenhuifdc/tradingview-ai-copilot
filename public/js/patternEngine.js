// ============================================================================
// Deterministic Rule Engine for Technical Structure & Pattern Recognition (M2 & M2.1)
// Pure JavaScript (Zero dependencies, runs identically in Node.js & Browser)
// ============================================================================

import { calcATR, calcMACD } from './indicators.js';
import { normalizeAndSortCandles } from './lwcAdapter.js';

/**
 * Centralized configuration for the M2/M2.1 pattern rule engine.
 * Tuned on real NSE daily data fixtures (RELIANCE.NS, TCS.NS).
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
    // Tuned on real NSE daily bars (RELIANCE.NS & TCS.NS, 496 bars each):
    // 0.25 * ATR(14) (~0.35% of price on typical large-cap Indian equities) accommodates
    // single-day settlement noise / wick-close overshoot while eliminating genuine broken trendlines.
    violationAtrMult: 0.25,
    maxAllowedViolationsInTolerance: 2
  },
  boxRange: {
    minBars: 10,
    maxBars: 65,
    maxRangePct: 0.12,
    touchZonePct: 0.22
  },
  divergence: {
    minBarDistance: 4,
    maxBarDistance: 80
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
  const atrSeries = calcATR(candles, 14);

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

  return swings;
}

/**
 * Aggregate daily candles into exchange-timezone (IST Monday–Friday) weekly candles
 * for multi-timeframe (Daily + Weekly) confluence analysis.
 * Does NOT normalize timestamps early to UTC midnight before extracting the exchange-timezone
 * calendar date, so raw timestamps crossing UTC midnight (e.g. 18:30 UTC previous day = 00:00 IST)
 * are assigned to their exact IST trading day and Monday–Friday week.
 */
export function aggregateDailyToWeeklyCandles(dailyCandles, options = {}) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length === 0) return [];
  const timeZone = options.timeZone || 'Asia/Kolkata';

  // Sort ascending by parsed epoch without stripping intra-day UTC offset before week grouping
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
 * Clusters swing highs/lows within tolerance, merges close levels, and weights by:
 * - Touch count
 * - Weekly confluence (daily + weekly resonance)
 * - Volume at touch bars
 * - Recency
 * Returns normalized score in [0, 1], deterministic id, and complete { index, time } anchors.
 */
export function detectSupportResistanceClusters(rawCandles, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 10) {
    return { supports: [], resistances: [], allClusters: [] };
  }

  const tolerancePct = options.tolerancePct ?? PATTERN_ENGINE_CONFIG.supportResistance.tolerancePct;
  const maxLevels = options.maxLevels ?? PATTERN_ENGINE_CONFIG.maxCandidates.supports;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const timeZone = options.timeZone || 'Asia/Kolkata';
  const currentPrice = candles[candles.length - 1].close;

  const dailySwings = options.swings || detectZigZagSwings(candles, { ...options, _alreadyNormalized: true });
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
    const recencyWeight = 0.7 + 0.6 * (s.index / Math.max(1, candles.length - 1));
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
    const safeDailyIndex = Math.min(candles.length - 1, Math.max(0, mappedDailyIndex));
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

    // Normalized score in [0, 1] based on touch count, daily+weekly confluence, weight, and recency
    const touchScore = Math.min(1, c.points.length / 6);
    const confluenceBonus = hasConfluence ? 0.25 : 0;
    const weightScore = Math.min(1, totalWeight / 8);
    const recencyScore = lastPt.index / Math.max(1, candles.length - 1);
    const rawScore = 0.35 * touchScore + 0.30 * weightScore + 0.15 * recencyScore + confluenceBonus;
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

  const supports = sortCandidatesDeterministically(
    allSorted
      .filter((c) => c.role === 'support')
      .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price) || b.score - a.score)
      .slice(0, maxLevels)
  );

  const resistances = sortCandidatesDeterministically(
    allSorted
      .filter((c) => c.role === 'resistance')
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice) || b.score - a.score)
      .slice(0, maxLevels)
  );

  return {
    supports,
    resistances,
    allClusters: allSorted
  };
}

/**
 * 3. Deterministic Trendline Detector with ATR-Multiple Closing-Price Violation Tolerance (M2.1)
 * Connects pairs of swing lows (ascending support trendline) or swing highs (descending resistance trendline).
 * Counts intermediate closing-price violations:
 * - Any single violation exceeding `violationAtrMult * ATR(14)` or total violations exceeding
 *   `maxAllowedViolationsInTolerance` eliminates the candidate.
 * - Violations within tolerance are retained and reported via `closingViolations`, `maxViolationPrice`,
 *   `maxViolationAtrRatio`, and `withinTolerance: true`.
 */
export function detectTrendlines(rawCandles, swingsInput, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 10) return [];
  const swings = Array.isArray(swingsInput)
    ? swingsInput
    : detectZigZagSwings(candles, { ...options, _alreadyNormalized: true });
  if (swings.length < 2) return [];

  const minBarDistance = options.minBarDistance ?? PATTERN_ENGINE_CONFIG.trendline.minBarDistance;
  const minTouches = options.minTouches ?? PATTERN_ENGINE_CONFIG.trendline.minTouches;
  const maxLines = options.maxLines ?? PATTERN_ENGINE_CONFIG.maxCandidates.trendlines;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const touchAtrMult = options.touchAtrMult ?? PATTERN_ENGINE_CONFIG.trendline.touchAtrMult;
  const touchTolerancePct = options.touchTolerancePct ?? PATTERN_ENGINE_CONFIG.trendline.touchTolerancePct;
  const violationAtrMult = options.violationAtrMult ?? PATTERN_ENGINE_CONFIG.trendline.violationAtrMult;
  const maxAllowedViolations =
    options.maxAllowedViolationsInTolerance ?? PATTERN_ENGINE_CONFIG.trendline.maxAllowedViolationsInTolerance;

  const atrSeries = calcATR(candles, 14);
  const fallbackAtr = (candles[candles.length - 1]?.close || 100) * 0.015;

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
        // Support trendline must be ascending or flat; resistance trendline descending or flat
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

        // Count swing points touching this line within ATR / percentage tolerance
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

        const lastIdx = candles.length - 1;
        const projectedCurrentPrice = p1.price + slope * (lastIdx - p1.index);

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

        // Normalized score in [0, 1]: touch count + span + recency - minor violation penalty
        const touchScore = Math.min(1, touchedPoints.length / 4);
        const spanScore = Math.min(1, dx / Math.max(20, candles.length * 0.5));
        const recencyScore = p2.index / Math.max(1, lastIdx);
        const violationPenalty = closingViolations > 0 ? Math.min(0.2, 0.1 * maxViolationAtrRatio) : 0;
        const score = clampScore(0.45 * touchScore + 0.30 * spanScore + 0.25 * recencyScore - violationPenalty);

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

  return sortCandidatesDeterministically(candidates).slice(0, maxLines);
}

/**
 * 4. Consolidation Box (Range) Detector
 * Identifies horizontal channels where price oscillates between bounded high/low walls
 * with multiple alternating touches and tight range height.
 */
export function detectBoxRanges(rawCandles, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  const minBars = options.minBars ?? PATTERN_ENGINE_CONFIG.boxRange.minBars;
  const maxBars = options.maxBars ?? PATTERN_ENGINE_CONFIG.boxRange.maxBars;
  const maxRangePct = options.maxRangePct ?? PATTERN_ENGINE_CONFIG.boxRange.maxRangePct;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const maxBoxes = options.maxBoxes ?? PATTERN_ENGINE_CONFIG.maxCandidates.boxRanges;

  if (candles.length < minBars) return [];

  const boxes = [];
  const step = Math.max(2, Math.floor(minBars / 3));

  for (let len = minBars; len <= Math.min(maxBars, candles.length); len += step) {
    for (let start = candles.length - len; start >= 0; start -= step) {
      const end = start + len - 1;
      const slice = candles.slice(start, end + 1);
      const highs = slice.map((c) => c.high).sort((a, b) => a - b);
      const lows = slice.map((c) => c.low).sort((a, b) => a - b);

      const upper = highs[Math.floor(highs.length * 0.9)];
      const lower = lows[Math.floor(lows.length * 0.1)];
      const mid = (upper + lower) / 2;
      const heightPct = (upper - lower) / Math.max(1e-9, mid);

      if (heightPct <= 0 || heightPct > maxRangePct) continue;

      const touchBand = (upper - lower) * PATTERN_ENGINE_CONFIG.boxRange.touchZonePct;
      let upperTouches = 0;
      let lowerTouches = 0;
      let upperTouchIndex = start;
      let lowerTouchIndex = start;
      let outsideCloses = 0;

      for (let k = 0; k < slice.length; k++) {
        const c = slice[k];
        const absIdx = start + k;
        if (c.high >= upper - touchBand) {
          upperTouches++;
          upperTouchIndex = absIdx;
        }
        if (c.low <= lower + touchBand) {
          lowerTouches++;
          lowerTouchIndex = absIdx;
        }
        if (c.close > upper + touchBand || c.close < lower - touchBand) outsideCloses++;
      }

      if (upperTouches >= 2 && lowerTouches >= 2 && outsideCloses <= Math.floor(len * 0.1)) {
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

        const touchScore = Math.min(1, (upperTouches + lowerTouches) / 10);
        const tightnessScore = Math.max(0, 1 - heightPct / maxRangePct);
        const recencyScore = end / Math.max(1, candles.length - 1);
        const score = clampScore(0.45 * touchScore + 0.35 * tightnessScore + 0.20 * recencyScore);
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

  // Deduplicate overlapping boxes keeping highest score
  const sorted = sortCandidatesDeterministically(boxes);
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
 * - Bullish Divergence: Price makes Lower Low (LL), MACD line or Histogram makes Higher Low (HL).
 * - Bearish Divergence: Price makes Higher High (HH), MACD line or Histogram makes Lower High (LH).
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
      const recency = p2.index / Math.max(1, candles.length - 1);
      const score = clampScore(
        0.40 * Math.min(1, priceDropPct / 0.06) +
        0.35 * Math.min(1, macdRise / 0.5) +
        0.25 * recency
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
      const recency = p2.index / Math.max(1, candles.length - 1);
      const score = clampScore(
        0.40 * Math.min(1, priceRisePct / 0.06) +
        0.35 * Math.min(1, macdDrop / 0.5) +
        0.25 * recency
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

  return sortCandidatesDeterministically(divergences).slice(0, maxDivergences);
}

/**
 * 6. Classic Geometric Chart Pattern Detector
 * Detects:
 * - Double Bottom (W-Bottom) & Double Top (M-Top)
 * - Head and Shoulders Top & Inverse Head and Shoulders Bottom
 * - Converging Triangle / Wedge (Ascending / Descending / Symmetrical)
 * Every anchor in `points` / `anchors` / `startAnchor` / `endAnchor` includes { index, time, price }.
 */
export function detectChartPatterns(rawCandles, swingsInput, options = {}) {
  const candles = ensureNormalizedCandles(rawCandles, options);
  if (candles.length < 15) return [];

  const swings = Array.isArray(swingsInput)
    ? swingsInput
    : detectZigZagSwings(candles, { ...options, _alreadyNormalized: true });
  if (swings.length < 3) return [];

  const tolerancePct = options.tolerancePct ?? 0.022;
  const tickSize = options.tickSize ?? PATTERN_ENGINE_CONFIG.tickSize.defaultNse;
  const maxPatterns = options.maxPatterns ?? PATTERN_ENGINE_CONFIG.maxCandidates.patterns;
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
        const symmetryScore = Math.max(0, 1 - diffPct / tolerancePct);
        const amplitudeScore = Math.min(1, bouncePct / 0.08);
        const recencyScore = s3.index / Math.max(1, candles.length - 1);
        const score = clampScore(0.45 * symmetryScore + 0.35 * amplitudeScore + 0.20 * recencyScore);
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
        const symmetryScore = Math.max(0, 1 - diffPct / tolerancePct);
        const amplitudeScore = Math.min(1, dropPct / 0.08);
        const recencyScore = s3.index / Math.max(1, candles.length - 1);
        const score = clampScore(0.45 * symmetryScore + 0.35 * amplitudeScore + 0.20 * recencyScore);
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

    // Head and Shoulders Top: H1 - L1 - H2(Head) - L2 - H3
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
        const symmetryScore = Math.max(0, 1 - shoulderDiff / (tolerancePct * 1.5));
        const prominenceScore = Math.min(1, headProminence / 0.06);
        const recencyScore = s5.index / Math.max(1, candles.length - 1);
        const score = clampScore(0.45 * symmetryScore + 0.35 * prominenceScore + 0.20 * recencyScore);
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

    // Inverse Head and Shoulders Bottom: L1 - H1 - L2(Head) - H2 - L3
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
        const symmetryScore = Math.max(0, 1 - shoulderDiff / (tolerancePct * 1.5));
        const prominenceScore = Math.min(1, headProminence / 0.06);
        const recencyScore = s5.index / Math.max(1, candles.length - 1);
        const score = clampScore(0.45 * symmetryScore + 0.35 * prominenceScore + 0.20 * recencyScore);
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

      // Converging: upper boundary flat or falling, lower boundary flat or rising, and narrowing
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
          const recencyScore = endIdx / Math.max(1, candles.length - 1);
          const score = clampScore(0.65 * Math.min(1, convergenceRatio / 0.5) + 0.35 * recencyScore);
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

  return sortCandidatesDeterministically(patterns).slice(0, maxPatterns);
}

/**
 * Master entry point: Run the entire M2/M2.1 deterministic pattern rule engine on daily candles.
 * Pre-normalizes input via `normalizeAndSortCandles` so that every candidate's `index` and `time`
 * align 100% with the chart rendering layer's normalized candle array.
 */
export function runPatternRuleEngine(rawCandles, options = {}) {
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
      config: PATTERN_ENGINE_CONFIG
    };
  }

  const normalizedOpts = { ...options, _alreadyNormalized: true };
  const swings = detectZigZagSwings(candles, normalizedOpts);
  const supportResistance = detectSupportResistanceClusters(candles, { ...normalizedOpts, swings });
  const trendlines = detectTrendlines(candles, swings, normalizedOpts);
  const boxRanges = detectBoxRanges(candles, normalizedOpts);
  const divergences = detectMacdDivergences(candles, swings, normalizedOpts);
  const patterns = detectChartPatterns(candles, swings, normalizedOpts);

  return {
    candles,
    swings,
    supportResistance,
    trendlines,
    boxRanges,
    divergences,
    patterns,
    config: PATTERN_ENGINE_CONFIG
  };
}
