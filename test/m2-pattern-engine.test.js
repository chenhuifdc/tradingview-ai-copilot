const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function generateSeriesFromWaypoints(waypoints, totalBars, baseNoise = 4) {
  const candles = [];
  const startMs = Date.parse('2025-06-02T00:00:00Z');

  for (let i = 0; i < totalBars; i++) {
    let segStart = waypoints[0];
    let segEnd = waypoints[waypoints.length - 1];
    for (let w = 0; w < waypoints.length - 1; w++) {
      if (i >= waypoints[w].index && i <= waypoints[w + 1].index) {
        segStart = waypoints[w];
        segEnd = waypoints[w + 1];
        break;
      }
    }
    const span = Math.max(1, segEnd.index - segStart.index);
    const t = Math.max(0, Math.min(1, (i - segStart.index) / span));
    const mid = segStart.price + (segEnd.price - segStart.price) * t;
    const isWaypoint = waypoints.some((wp) => wp.index === i);
    const spread = isWaypoint ? baseNoise * 0.5 : baseNoise;

    const high = isWaypoint && segEnd.index === i && segEnd.price > segStart.price
      ? segEnd.price
      : mid + spread;
    const low = isWaypoint && segEnd.index === i && segEnd.price < segStart.price
      ? segEnd.price
      : mid - spread;
    const open = mid - (t > 0.5 ? 1 : -1);
    const close = mid + (t > 0.5 ? 1 : -1);

    candles.push({
      time: Math.floor((startMs + i * 86400000) / 1000),
      open: Number(open.toFixed(2)),
      high: Number(Math.max(high, open, close).toFixed(2)),
      low: Number(Math.min(low, open, close).toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1000000 + (isWaypoint ? 800000 : 100000)
    });
  }

  for (const wp of waypoints) {
    if (candles[wp.index]) {
      if (wp.polarity === 'high') {
        candles[wp.index].high = wp.price;
        candles[wp.index].close = wp.price - 2;
        candles[wp.index].open = wp.price - 3;
      } else if (wp.polarity === 'low') {
        candles[wp.index].low = wp.price;
        candles[wp.index].close = wp.price + 2;
        candles[wp.index].open = wp.price + 3;
      }
    }
  }

  return candles;
}

test('M2.1 roundToTick snaps prices to NSE ₹0.05 tick size', async () => {
  const { roundToTick } = await import('../public/js/patternEngine.js');
  assert.equal(roundToTick(2845.126, 0.05), 2845.15);
  assert.equal(roundToTick(2845.111, 0.05), 2845.10);
  assert.equal(roundToTick(1200.024, 0.05), 1200.00);
});

test('M2.2 detectZigZagSwings produces strictly alternating swing highs and lows with exact {index, time, price}', async () => {
  const { detectZigZagSwings } = await import('../public/js/patternEngine.js');
  const waypoints = [
    { index: 0, price: 1000, polarity: 'low' },
    { index: 8, price: 1120, polarity: 'high' },
    { index: 16, price: 1010, polarity: 'low' },
    { index: 24, price: 1150, polarity: 'high' },
    { index: 32, price: 1020, polarity: 'low' },
    { index: 40, price: 1180, polarity: 'high' }
  ];
  const candles = generateSeriesFromWaypoints(waypoints, 46);
  const swings = detectZigZagSwings(candles, { leftBars: 2, rightBars: 2, minSwingPct: 0.03 });

  assert.ok(swings.length >= 4, 'Should detect multiple swing pivots');
  for (let i = 0; i < swings.length; i++) {
    const s = swings[i];
    if (i > 0) {
      assert.notEqual(s.polarity, swings[i - 1].polarity, 'Consecutive swings must strictly alternate polarity');
    }
    assert.equal(s.time, candles[s.index].time, 'Swing time must equal candle[index].time');
    if (s.polarity === 'high') {
      assert.equal(s.price, candles[s.index].high, 'Swing high price must match candle.high');
    } else {
      assert.equal(s.price, candles[s.index].low, 'Swing low price must match candle.low');
    }
  }
});

test('M2.3 detectSupportResistanceClusters identifies horizontal S&R zones with daily + weekly resonance', async () => {
  const { detectSupportResistanceClusters } = await import('../public/js/patternEngine.js');
  const waypoints = [
    { index: 0, price: 2050, polarity: 'high' },
    { index: 6, price: 1900, polarity: 'low' },
    { index: 12, price: 2100, polarity: 'high' },
    { index: 18, price: 1902, polarity: 'low' },
    { index: 24, price: 2098, polarity: 'high' },
    { index: 30, price: 1898, polarity: 'low' },
    { index: 36, price: 2102, polarity: 'high' },
    { index: 42, price: 1995, polarity: 'low' }
  ];
  const candles = generateSeriesFromWaypoints(waypoints, 45);
  const sr = detectSupportResistanceClusters(candles, { leftBars: 2, rightBars: 2 });

  assert.ok(sr.supports.length >= 1, 'Should detect support near 1900');
  assert.ok(sr.resistances.length >= 1, 'Should detect resistance near 2100');

  const keySup = sr.supports.find((s) => Math.abs(s.price - 1900) <= 15);
  const keyRes = sr.resistances.find((r) => Math.abs(r.price - 2100) <= 15);
  assert.ok(keySup, 'Support cluster near 1900 must exist');
  assert.ok(keyRes, 'Resistance cluster near 2100 must exist');
  assert.ok(keySup.touches >= 3, 'Support near 1900 should record >= 3 touches');
  assert.ok(keyRes.touches >= 3, 'Resistance near 2100 should record >= 3 touches');
  assert.ok(keySup.score >= 0 && keySup.score <= 1, 'Support score must be normalized in [0, 1]');
  assert.ok(keyRes.score >= 0 && keyRes.score <= 1, 'Resistance score must be normalized in [0, 1]');
});

test('M2.4 detectTrendlines fits ascending support trendline and eliminates lines with deep closing-price violations', async () => {
  const { detectZigZagSwings, detectTrendlines } = await import('../public/js/patternEngine.js');
  const waypoints = [
    { index: 0, price: 1050, polarity: 'high' },
    { index: 5, price: 1000, polarity: 'low' },
    { index: 11, price: 1120, polarity: 'high' },
    { index: 17, price: 1060, polarity: 'low' },
    { index: 23, price: 1180, polarity: 'high' },
    { index: 29, price: 1120, polarity: 'low' },
    { index: 35, price: 1240, polarity: 'high' }
  ];
  const candles = generateSeriesFromWaypoints(waypoints, 40);
  const swings = detectZigZagSwings(candles, { leftBars: 2, rightBars: 2 });
  const trendlines = detectTrendlines(candles, swings, { minTouches: 3 });

  const supLine = trendlines.find((tl) => tl.role === 'support');
  assert.ok(supLine, 'Should detect ascending support trendline across 3 collinear swing lows');
  assert.equal(supLine.touches, 3);
  assert.equal(supLine.closingViolations, 0);
  assert.equal(supLine.withinTolerance, true);
  assert.ok(supLine.slope > 0);

  // Inject a deep closing-price breakdown well beyond ATR tolerance at bar 14
  const brokenCandles = candles.map((c, idx) =>
    idx === 14 ? { ...c, low: 920, close: 930 } : { ...c }
  );
  const brokenLines = detectTrendlines(brokenCandles, swings, { minTouches: 3 });
  const spanningBroken = brokenLines.find(
    (tl) => tl.role === 'support' && tl.startIndex === 5 && tl.endIndex === 29
  );
  assert.equal(spanningBroken, undefined, 'Trendline with deep closing-price breakdown must be eliminated');
});

test('M2.5 detectBoxRanges detects horizontal consolidation boxes', async () => {
  const { detectBoxRanges } = await import('../public/js/patternEngine.js');
  const candles = [];
  const startMs = Date.parse('2025-07-01T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    const phase = i % 4;
    const close = phase === 0 ? 1545 : phase === 1 ? 1505 : phase === 2 ? 1542 : 1508;
    candles.push({
      time: new Date(startMs + i * 86400000).toISOString(),
      open: 1525,
      high: phase === 0 || phase === 2 ? 1550 : 1535,
      low: phase === 1 || phase === 3 ? 1500 : 1515,
      close,
      volume: 1000000
    });
  }

  const boxes = detectBoxRanges(candles, { minBars: 12, maxRangePct: 0.08 });
  assert.ok(boxes.length >= 1, 'Should detect consolidation box range');
  assert.ok(boxes[0].upperBound > boxes[0].lowerBound);
  assert.ok(boxes[0].upperTouches >= 2);
  assert.ok(boxes[0].lowerTouches >= 2);
  assert.ok(boxes[0].score >= 0 && boxes[0].score <= 1);
});

test('M2.6 detectMacdDivergences detects bullish divergence when price makes lower low and MACD makes higher low', async () => {
  const { detectMacdDivergences } = await import('../public/js/patternEngine.js');
  // Note: calcMACD(candles, 10, 21, 9) requires 21 bars for the slow EMA warmup (indices 0..19 are null).
  // Placing swing low #1 at index 26 (>= 20) and swing low #2 at index 42 ensures both swings have valid MACD values.
  const waypoints = [
    { index: 0, price: 1300, polarity: 'high' },
    { index: 14, price: 1280, polarity: 'high' },
    { index: 26, price: 1000, polarity: 'low' },
    { index: 34, price: 1140, polarity: 'high' },
    { index: 42, price: 985, polarity: 'low' },
    { index: 48, price: 1120, polarity: 'high' }
  ];
  const candles = generateSeriesFromWaypoints(waypoints, 50);
  const swings = [
    { index: 14, time: candles[14].time, price: candles[14].high, polarity: 'high' },
    { index: 26, time: candles[26].time, price: candles[26].low, polarity: 'low' },
    { index: 34, time: candles[34].time, price: candles[34].high, polarity: 'high' },
    { index: 42, time: candles[42].time, price: candles[42].low, polarity: 'low' }
  ];

  const divs = detectMacdDivergences(candles, swings);
  const bullDiv = divs.find((d) => d.bias === 'bullish');
  assert.ok(bullDiv, 'Should detect bullish MACD divergence');
  assert.equal(bullDiv.anchorIndex, 42);
  assert.equal(bullDiv.startAnchor.index, 26);
  assert.equal(bullDiv.endAnchor.index, 42);
  assert.ok(bullDiv.endAnchor.price < bullDiv.startAnchor.price, 'Second low must be lower in price');
  assert.ok(bullDiv.endAnchor.macd > bullDiv.startAnchor.macd, 'Second low must be higher in MACD');
});

test('M2.7 detectChartPatterns & runPatternRuleEngine recognize Double Bottom (W-Bottom) and Head & Shoulders Top', async () => {
  const { detectChartPatterns, runPatternRuleEngine } = await import('../public/js/patternEngine.js');

  const wWaypoints = [
    { index: 2, price: 1200, polarity: 'high' },
    { index: 10, price: 1000, polarity: 'low' },
    { index: 18, price: 1120, polarity: 'high' },
    { index: 26, price: 1004, polarity: 'low' },
    { index: 34, price: 1160, polarity: 'high' }
  ];
  const wCandles = generateSeriesFromWaypoints(wWaypoints, 38);
  const engineOut = runPatternRuleEngine(wCandles, { leftBars: 2, rightBars: 2 });
  assert.ok(
    engineOut.patterns.some((p) => p.type === 'double_bottom'),
    'runPatternRuleEngine must detect double_bottom pattern'
  );

  const hsWaypoints = [
    { index: 2, price: 1000, polarity: 'low' },
    { index: 8, price: 1150, polarity: 'high' },
    { index: 14, price: 1040, polarity: 'low' },
    { index: 20, price: 1220, polarity: 'high' },
    { index: 26, price: 1045, polarity: 'low' },
    { index: 32, price: 1148, polarity: 'high' },
    { index: 38, price: 990, polarity: 'low' }
  ];
  const hsCandles = generateSeriesFromWaypoints(hsWaypoints, 42);
  const hsSwings = hsWaypoints.map((wp) => ({
    index: wp.index,
    time: hsCandles[wp.index].time,
    price: wp.price,
    polarity: wp.polarity
  }));
  const hsPatterns = detectChartPatterns(hsCandles, hsSwings);
  assert.ok(
    hsPatterns.some((p) => p.type === 'head_and_shoulders_top'),
    'detectChartPatterns must detect head_and_shoulders_top pattern'
  );
});

test('M2.8 (M2.1 Item 2) Trendline ATR-multiple closing-price violation tolerance: retains within tolerance, rejects beyond tolerance', async () => {
  const { detectZigZagSwings, detectTrendlines, PATTERN_ENGINE_CONFIG } = await import('../public/js/patternEngine.js');
  const { calcATR } = await import('../public/js/indicators.js');

  assert.equal(typeof PATTERN_ENGINE_CONFIG.trendline.violationAtrMult, 'number');
  assert.ok(PATTERN_ENGINE_CONFIG.trendline.violationAtrMult > 0);

  const waypoints = [
    { index: 0, price: 1050, polarity: 'high' },
    { index: 5, price: 1000, polarity: 'low' },
    { index: 11, price: 1120, polarity: 'high' },
    { index: 17, price: 1060, polarity: 'low' },
    { index: 23, price: 1180, polarity: 'high' },
    { index: 29, price: 1120, polarity: 'low' },
    { index: 35, price: 1240, polarity: 'high' }
  ];
  const baseCandles = generateSeriesFromWaypoints(waypoints, 40);
  const swings = detectZigZagSwings(baseCandles, { leftBars: 2, rightBars: 2 });
  const atrSeries = calcATR(baseCandles, 14);

  // At index 20, the ascending line from (index=5, price=1000) to (index=29, price=1120) has slope = 5/bar -> linePrice(20) = 1075.
  const targetIdx = 20;
  const linePriceAt20 = 1000 + 5 * (targetIdx - 5); // 1075
  const barAtr = atrSeries[targetIdx];
  assert.ok(barAtr > 0, 'ATR(14) at index 20 must be positive');

  // Case A: Minor close violation equal to 0.12 * ATR (well within default violationAtrMult = 0.25 * ATR)
  const minorViolationDist = barAtr * 0.12;
  const withinTolCandles = baseCandles.map((c, idx) =>
    idx === targetIdx
      ? {
          ...c,
          low: Number((linePriceAt20 - minorViolationDist - 1).toFixed(2)),
          close: Number((linePriceAt20 - minorViolationDist).toFixed(2))
        }
      : { ...c }
  );

  const retainedLines = detectTrendlines(withinTolCandles, swings, { minTouches: 3 });
  const retainedSup = retainedLines.find(
    (tl) => tl.role === 'support' && tl.startIndex === 5 && tl.endIndex === 29
  );
  assert.ok(retainedSup, 'Trendline with closing violation <= violationAtrMult * ATR must be retained');
  assert.equal(retainedSup.closingViolations, 1, 'closingViolations must count the minor violation');
  assert.equal(retainedSup.withinTolerance, true, 'withinTolerance must be true');
  assert.ok(
    retainedSup.maxViolationAtrRatio > 0 &&
      retainedSup.maxViolationAtrRatio <= PATTERN_ENGINE_CONFIG.trendline.violationAtrMult,
    `Expected 0 < maxViolationAtrRatio (${retainedSup.maxViolationAtrRatio}) <= ${PATTERN_ENGINE_CONFIG.trendline.violationAtrMult}`
  );

  // Case B: Violation equal to 0.60 * ATR (exceeds violationAtrMult = 0.25 * ATR)
  const majorViolationDist = barAtr * 0.60;
  const exceedTolCandles = baseCandles.map((c, idx) =>
    idx === targetIdx
      ? {
          ...c,
          low: Number((linePriceAt20 - majorViolationDist - 1).toFixed(2)),
          close: Number((linePriceAt20 - majorViolationDist).toFixed(2))
        }
      : { ...c }
  );

  const rejectedLines = detectTrendlines(exceedTolCandles, swings, { minTouches: 3 });
  const rejectedSup = rejectedLines.find(
    (tl) => tl.role === 'support' && tl.startIndex === 5 && tl.endIndex === 29
  );
  assert.equal(rejectedSup, undefined, 'Trendline with closing violation > violationAtrMult * ATR must be eliminated');
});

test('M2.9 (M2.1 Item 3) Normalized score (0..1), deterministic id generation, and 100% identical sorting across repeated runs', async () => {
  const { runPatternRuleEngine } = await import('../public/js/patternEngine.js');
  const fixturePath = path.join(__dirname, 'fixtures', 'india-daily-klines.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixtures;
  const relianceCandles = fixtures['RELIANCE.NS'].candles;

  const run1 = runPatternRuleEngine(relianceCandles);
  const run2 = runPatternRuleEngine(relianceCandles);
  const run3 = runPatternRuleEngine([...relianceCandles]);

  const categories = [
    (r) => r.supportResistance.supports,
    (r) => r.supportResistance.resistances,
    (r) => r.supportResistance.allClusters,
    (r) => r.trendlines,
    (r) => r.boxRanges,
    (r) => r.divergences,
    (r) => r.patterns
  ];

  for (const getList of categories) {
    const list1 = getList(run1);
    const list2 = getList(run2);
    const list3 = getList(run3);

    assert.deepEqual(
      list1.map((c) => ({ id: c.id, score: c.score })),
      list2.map((c) => ({ id: c.id, score: c.score })),
      'Candidate IDs and scores must be 100% deterministic across repeated runs'
    );
    assert.deepEqual(list1, list3, 'Full candidate objects and ordering must be identical');

    for (let i = 0; i < list1.length; i++) {
      const item = list1[i];
      assert.equal(typeof item.id, 'string', 'Every candidate must have a string id');
      assert.ok(item.id.length > 5, 'Candidate id must be non-empty');
      assert.equal(typeof item.score, 'number', 'Every candidate must have a numeric score');
      assert.ok(item.score >= 0 && item.score <= 1, `Score ${item.score} must be in [0, 1]`);
    }
  }

  // Verify score descending order on allClusters, trendlines, boxRanges, divergences, patterns
  for (const list of [
    run1.supportResistance.allClusters,
    run1.trendlines,
    run1.boxRanges,
    run1.divergences,
    run1.patterns
  ]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i - 1].score >= list[i].score,
        `List must be sorted by score descending (${list[i - 1].score} < ${list[i].score})`
      );
    }
  }
});

test('M2.10 (M2.1 Item 4) Anchor { time, index } contract matches normalizeAndSortCandles even with duplicate or invalid input bars', async () => {
  const { runPatternRuleEngine } = await import('../public/js/patternEngine.js');
  const { normalizeAndSortCandles } = await import('../public/js/lwcAdapter.js');

  const waypoints = [
    { index: 0, price: 1300, polarity: 'high' },
    { index: 8, price: 1150, polarity: 'low' },
    { index: 16, price: 1260, polarity: 'high' },
    { index: 24, price: 1152, polarity: 'low' },
    { index: 32, price: 1258, polarity: 'high' },
    { index: 40, price: 1140, polarity: 'low' },
    { index: 48, price: 1290, polarity: 'high' }
  ];
  const cleanCandles = generateSeriesFromWaypoints(waypoints, 52);

  // Inject duplicate timestamps, out-of-order entries, and invalid NaN/null bars
  const dirtyCandles = [
    { time: 'invalid-date', open: 100, high: 110, low: 90, close: 105, volume: 0 },
    cleanCandles[5], // duplicate out-of-order
    ...cleanCandles.slice(0, 20),
    { time: cleanCandles[10].time, open: 1200, high: 1210, low: 1190, close: Number.NaN, volume: 500 },
    cleanCandles[12], // duplicate of index 12
    ...cleanCandles.slice(20)
  ];

  const chartNormalized = normalizeAndSortCandles(dirtyCandles, {
    interval: '1d',
    timeZone: 'Asia/Kolkata'
  });
  const result = runPatternRuleEngine(dirtyCandles, {
    interval: '1d',
    timeZone: 'Asia/Kolkata',
    leftBars: 2,
    rightBars: 2
  });

  assert.equal(result.candles.length, chartNormalized.length);
  assert.deepEqual(
    result.candles.map((c) => c.time),
    chartNormalized.map((c) => c.time),
    'Rule engine normalized candles must be 100% identical to chart normalizeAndSortCandles output'
  );

  function verifyAnchor(anchor, label) {
    assert.ok(anchor, `Missing anchor on ${label}`);
    assert.equal(typeof anchor.index, 'number', `Anchor index must be number on ${label}`);
    assert.ok(
      anchor.index >= 0 && anchor.index < chartNormalized.length,
      `Anchor index ${anchor.index} out of bounds [0, ${chartNormalized.length}) on ${label}`
    );
    assert.equal(
      anchor.time,
      chartNormalized[anchor.index].time,
      `Anchor time (${anchor.time}) must equal candles[${anchor.index}].time (${chartNormalized[anchor.index].time}) on ${label}`
    );
  }

  for (const s of result.swings) {
    verifyAnchor(s, 'swing');
  }
  for (const sr of result.supportResistance.allClusters) {
    verifyAnchor(sr.startAnchor, `${sr.id}.startAnchor`);
    verifyAnchor(sr.endAnchor, `${sr.id}.endAnchor`);
    for (const a of sr.anchors) verifyAnchor(a, `${sr.id}.anchors[]`);
  }
  for (const tl of result.trendlines) {
    verifyAnchor(tl.startAnchor, `${tl.id}.startAnchor`);
    verifyAnchor(tl.endAnchor, `${tl.id}.endAnchor`);
    for (const a of tl.anchors) verifyAnchor(a, `${tl.id}.anchors[]`);
    for (const a of tl.touchAnchors) verifyAnchor(a, `${tl.id}.touchAnchors[]`);
  }
  for (const box of result.boxRanges) {
    verifyAnchor(box.startAnchor, `${box.id}.startAnchor`);
    verifyAnchor(box.endAnchor, `${box.id}.endAnchor`);
    for (const a of box.anchors) verifyAnchor(a, `${box.id}.anchors[]`);
  }
  for (const div of result.divergences) {
    verifyAnchor(div.startAnchor, `${div.id}.startAnchor`);
    verifyAnchor(div.endAnchor, `${div.id}.endAnchor`);
    for (const a of div.anchors) verifyAnchor(a, `${div.id}.anchors[]`);
  }
  for (const pat of result.patterns) {
    verifyAnchor(pat.startAnchor, `${pat.id}.startAnchor`);
    verifyAnchor(pat.endAnchor, `${pat.id}.endAnchor`);
    for (const a of pat.points) verifyAnchor(a, `${pat.id}.points[]`);
  }
});

test('M2.11 (M2.1 Item 6) aggregateDailyToWeeklyCandles groups strictly by IST (Asia/Kolkata) Monday–Friday week boundaries across UTC day boundaries and holidays', async () => {
  const { aggregateDailyToWeeklyCandles } = await import('../public/js/patternEngine.js');

  // Week 1 in IST: Monday 2026-03-16 through Friday 2026-03-20
  // Note: 00:00 IST on Monday 2026-03-16 is Sunday 2026-03-15T18:30:00Z in UTC!
  // Suppose Wednesday 2026-03-18 is an Indian market holiday (only 4 bars in Week 1).
  // Week 2 in IST: Monday 2026-03-23 through Friday 2026-03-27 (5 bars, starting Sunday 2026-03-22T18:30:00Z).
  const rawDailyBars = [
    // Week 1 (IST 2026-03-16 Mon .. 2026-03-20 Fri, 4 trading days due to Wed holiday)
    { time: '2026-03-15T18:30:00.000Z', open: 100, high: 110, low: 95, close: 105, volume: 1000 }, // Mon Mar 16 IST
    { time: '2026-03-16T18:30:00.000Z', open: 105, high: 125, low: 102, close: 120, volume: 1500 }, // Tue Mar 17 IST (Week 1 High = 125)
    // Wed Mar 18 IST holiday skipped!
    { time: '2026-03-18T18:30:00.000Z', open: 120, high: 122, low: 88, close: 92, volume: 1200 }, // Thu Mar 19 IST (Week 1 Low = 88)
    { time: '2026-03-19T18:30:00.000Z', open: 92, high: 115, low: 90, close: 112, volume: 1100 }, // Fri Mar 20 IST

    // Week 2 (IST 2026-03-23 Mon .. 2026-03-27 Fri, 5 trading days)
    { time: '2026-03-22T18:30:00.000Z', open: 200, high: 210, low: 195, close: 205, volume: 2000 }, // Mon Mar 23 IST
    { time: '2026-03-23T18:30:00.000Z', open: 205, high: 215, low: 198, close: 210, volume: 2000 }, // Tue Mar 24 IST
    { time: '2026-03-24T18:30:00.000Z', open: 210, high: 240, low: 208, close: 235, volume: 2500 }, // Wed Mar 25 IST (Week 2 High = 240)
    { time: '2026-03-25T18:30:00.000Z', open: 235, high: 238, low: 180, close: 185, volume: 1800 }, // Thu Mar 26 IST (Week 2 Low = 180)
    { time: '2026-03-26T18:30:00.000Z', open: 185, high: 225, low: 182, close: 220, volume: 2200 }  // Fri Mar 27 IST
  ];

  const weekly = aggregateDailyToWeeklyCandles(rawDailyBars, { timeZone: 'Asia/Kolkata' });

  // Fixed 5-bar chunking would have pulled Mon Mar 23 IST (open=200, high=210) into Week 1!
  // UTC Monday-Sunday grouping would have placed Sun Mar 15 18:30Z (Mon Mar 16 IST) into the previous week!
  assert.equal(weekly.length, 2, 'Must produce exactly 2 IST trading weeks');

  assert.equal(weekly[0].weekKey, '2026-03-16');
  assert.equal(weekly[0].barCount, 4, 'Holiday-shortened Week 1 must contain 4 bars, not 5');
  assert.equal(weekly[0].startLocalDate, '2026-03-16');
  assert.equal(weekly[0].endLocalDate, '2026-03-20');
  assert.equal(weekly[0].open, 100);
  assert.equal(weekly[0].high, 125);
  assert.equal(weekly[0].low, 88);
  assert.equal(weekly[0].close, 112);
  assert.equal(weekly[0].volume, 4800);
  assert.equal(weekly[0].highDailyIndex, 1);
  assert.equal(weekly[0].lowDailyIndex, 2);

  assert.equal(weekly[1].weekKey, '2026-03-23');
  assert.equal(weekly[1].barCount, 5);
  assert.equal(weekly[1].startLocalDate, '2026-03-23');
  assert.equal(weekly[1].endLocalDate, '2026-03-27');
  assert.equal(weekly[1].open, 200);
  assert.equal(weekly[1].high, 240);
  assert.equal(weekly[1].low, 180);
  assert.equal(weekly[1].close, 220);
  assert.equal(weekly[1].volume, 10500);
});

test('M2.12 (M2.1 Item 5) Real NSE stock fixtures (RELIANCE.NS & TCS.NS) sanity check + 1500-bar performance benchmark', async () => {
  const { runPatternRuleEngine, PATTERN_ENGINE_CONFIG } = await import('../public/js/patternEngine.js');
  const fixturePath = path.join(__dirname, 'fixtures', 'india-daily-klines.json');
  assert.equal(fs.existsSync(fixturePath), true, 'test/fixtures/india-daily-klines.json must exist');

  const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const maxC = PATTERN_ENGINE_CONFIG.maxCandidates;

  for (const symbol of ['RELIANCE.NS', 'TCS.NS']) {
    const fix = payload.fixtures[symbol];
    assert.ok(fix && fix.candles.length >= 400, `${symbol} fixture must contain >= 400 real daily candles`);

    const out = runPatternRuleEngine(fix.candles, {
      interval: '1d',
      timeZone: 'Asia/Kolkata',
      tickSize: 0.05
    });

    assert.ok(
      out.supportResistance.supports.length >= 1 && out.supportResistance.supports.length <= maxC.supports,
      `${symbol} supports count (${out.supportResistance.supports.length}) must be within [1, ${maxC.supports}]`
    );
    assert.ok(
      out.supportResistance.resistances.length >= 1 && out.supportResistance.resistances.length <= maxC.resistances,
      `${symbol} resistances count (${out.supportResistance.resistances.length}) must be within [1, ${maxC.resistances}]`
    );
    assert.ok(
      out.trendlines.length <= maxC.trendlines,
      `${symbol} trendlines count (${out.trendlines.length}) must be <= ${maxC.trendlines}`
    );
    assert.ok(
      out.boxRanges.length <= maxC.boxRanges,
      `${symbol} boxRanges count (${out.boxRanges.length}) must be <= ${maxC.boxRanges}`
    );
    assert.ok(
      out.divergences.length <= maxC.divergences,
      `${symbol} divergences count (${out.divergences.length}) must be <= ${maxC.divergences}`
    );
    assert.ok(
      out.patterns.length <= maxC.patterns,
      `${symbol} patterns count (${out.patterns.length}) must be <= ${maxC.patterns}`
    );
  }

  // 1500-bar performance benchmark constructed by concatenating / extending real daily movements
  const baseCandles = payload.fixtures['RELIANCE.NS'].candles;
  const candles1500 = [];
  const startEpochMs = Date.parse('2020-01-01T00:00:00Z');
  for (let i = 0; i < 1500; i++) {
    const template = baseCandles[i % baseCandles.length];
    const cycleOffset = Math.floor(i / baseCandles.length) * 120;
    candles1500.push({
      time: new Date(startEpochMs + i * 86400000).toISOString(),
      open: Number((template.open + cycleOffset).toFixed(2)),
      high: Number((template.high + cycleOffset).toFixed(2)),
      low: Number((template.low + cycleOffset).toFixed(2)),
      close: Number((template.close + cycleOffset).toFixed(2)),
      volume: template.volume
    });
  }

  // Warmup once, then measure
  runPatternRuleEngine(candles1500);
  const t0 = performance.now();
  const benchOut = runPatternRuleEngine(candles1500);
  const elapsedMs = performance.now() - t0;

  assert.equal(benchOut.candles.length, 1500);
  assert.ok(
    elapsedMs < 250,
    `1500-bar runPatternRuleEngine took ${elapsedMs.toFixed(2)}ms (expected < 250ms)`
  );
  console.log(`[M2.12 Benchmark] 1500 daily bars processed in ${elapsedMs.toFixed(2)} ms`);
});
