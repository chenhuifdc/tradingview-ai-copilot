const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_PATH = path.join(__dirname, 'fixtures', 'india-daily-klines.json');
const FIVE_NSE_SYMBOLS = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'SUNPHARMA.NS', 'ITC.NS'];

test('M3.1 (M3 Item 7) Price basis end-to-end: K-lines and patternEngine annotations strictly use split-adjusted raw OHLC (quote[0]) and NEVER dividend-adjusted adjclose', async () => {
  const { createMarketService } = require('../server/marketService');
  const { runPatternRuleEngine } = await import('../public/js/patternEngine.js');
  const { buildAnnotationsFromPatternEngine } = await import('../public/js/lwcAnnotationPrimitive.js');

  const rawFixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).fixtures;
  const relCandles = rawFixtures['RELIANCE.NS'].candles.slice(-160);

  // Build realistic Yahoo v8 chart payload where dividend-adjusted adjclose is shifted DOWN by 15%
  // relative to split-adjusted raw OHLC in indicators.quote[0].
  const timestamps = relCandles.map((c) => Math.floor(Date.parse(c.time) / 1000));
  const rawOpen = relCandles.map((c) => c.open);
  const rawHigh = relCandles.map((c) => c.high);
  const rawLow = relCandles.map((c) => c.low);
  const rawClose = relCandles.map((c) => c.close);
  const rawVolume = relCandles.map((c) => c.volume);
  const shiftedAdjClose = relCandles.map((c) => Number((c.close * 0.85).toFixed(2)));

  const payload = {
    chart: {
      result: [
        {
          meta: {
            symbol: 'RELIANCE.NS',
            currency: 'INR',
            exchangeName: 'NSI',
            exchangeTimezoneName: 'Asia/Kolkata'
          },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: rawOpen,
                high: rawHigh,
                low: rawLow,
                close: rawClose,
                volume: rawVolume
              }
            ],
            adjclose: [{ adjclose: shiftedAdjClose }]
          }
        }
      ],
      error: null
    }
  };
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  });

  const market = createMarketService({ fetchFn: mockFetch });
  const klineResp = await market.getKlines('RELIANCE.NS', '1d', '6mo');
  assert.equal(klineResp.source, 'live', 'Mock Yahoo response must be treated as live, not simulated');
  assert.equal(klineResp.meta.priceBasis, 'split_adjusted_raw_ohlc');
  assert.equal(klineResp.candles.length, relCandles.length);

  // Verify K-lines match raw OHLC verbatim, NOT shifted adjclose
  for (let i = 0; i < relCandles.length; i++) {
    assert.equal(klineResp.candles[i].close, rawClose[i], `Bar ${i} close must equal raw quote[0].close`);
    assert.equal(klineResp.candles[i].high, rawHigh[i], `Bar ${i} high must equal raw quote[0].high`);
    assert.equal(klineResp.candles[i].low, rawLow[i], `Bar ${i} low must equal raw quote[0].low`);
    assert.notEqual(klineResp.candles[i].close, shiftedAdjClose[i], `Bar ${i} close must NOT use adjclose`);
  }

  // Feed live marketService candles into patternEngine & M3 annotation builder
  const engineOut = runPatternRuleEngine(klineResp.candles, {
    interval: '1d',
    timeZone: 'Asia/Kolkata',
    useCache: false
  });
  const ann = buildAnnotationsFromPatternEngine(engineOut, {
    candles: engineOut.candles,
    precision: 2
  });

  const minRawPrice = Math.min(...rawLow);
  const maxAdjClose = Math.max(...shiftedAdjClose);
  assert.ok(ann.horizontalLevels.length >= 1, 'Annotations must include horizontal S&R levels');

  // Every annotation anchor must match raw OHLC candle high/low and NOT the 15%-lower adjclose regime
  for (const lvl of ann.horizontalLevels) {
    assert.ok(
      lvl.price >= minRawPrice - 1e-6,
      `Horizontal level ${lvl.price} fell into adjclose range (< minRawPrice ${minRawPrice})`
    );
    const bar = engineOut.candles[lvl.anchorIndex];
    assert.ok(bar, 'Level anchorIndex must resolve to a real candle');
    assert.ok(
      lvl.price === bar.high || lvl.price === bar.low,
      `Level price ${lvl.price} must equal raw OHLC high (${bar.high}) or low (${bar.low}), not adjclose (${shiftedAdjClose[lvl.anchorIndex]})`
    );
  }
  for (const tl of ann.trendlines) {
    for (const anc of [tl.startAnchor, tl.endAnchor]) {
      const bar = engineOut.candles[anc.index];
      const expected = tl.role === 'resistance' ? bar.high : bar.low;
      assert.equal(anc.price, expected, `Trendline anchor ${anc.price} must match raw OHLC ${expected}`);
    }
  }
  // Sanity: confirm latest candle close is strictly above shifted adjclose
  assert.ok(engineOut.candles[engineOut.candles.length - 1].close > shiftedAdjClose[shiftedAdjClose.length - 1] * 1.1);
  assert.ok(maxAdjClose > 0);
});

test('M3.2 (M3 Item 7) Anchor snapping: EVERY anchor price across all 5 NSE fixtures strictly equals corresponding candle high or low', async () => {
  const { runPatternRuleEngine } = await import('../public/js/patternEngine.js');
  const { buildAnnotationsFromPatternEngine } = await import('../public/js/lwcAnnotationPrimitive.js');

  const rawFixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).fixtures;
  let totalAnchorsChecked = 0;

  for (const sym of FIVE_NSE_SYMBOLS) {
    const out = runPatternRuleEngine(rawFixtures[sym].candles, {
      interval: '1d',
      timeZone: 'Asia/Kolkata',
      useCache: false
    });
    const candles = out.candles;

    // 1) Swings
    for (const s of out.swings) {
      const c = candles[s.index];
      assert.ok(c, `${sym} swing index ${s.index} out of bounds`);
      const expected = s.polarity === 'high' ? c.high : c.low;
      assert.equal(s.price, expected, `${sym} swing[${s.index}] (${s.polarity}) price ${s.price} !== candle ${expected}`);
      totalAnchorsChecked++;
    }

    // 2) Support & Resistance clusters (every touch anchor + cluster snapped priceAnchor)
    for (const lvl of [...out.supportResistance.supports, ...out.supportResistance.resistances]) {
      assert.ok(lvl.anchors && lvl.anchors.length >= 1);
      for (const anc of lvl.anchors) {
        const c = candles[anc.index];
        assert.ok(c, `${sym} S&R anchor index ${anc.index} out of bounds`);
        const expected = anc.polarity === 'high' ? c.high : c.low;
        assert.equal(anc.price, expected, `${sym} S&R ${lvl.id} anchor[${anc.index}] price ${anc.price} !== ${expected}`);
        totalAnchorsChecked++;
      }
      assert.ok(lvl.priceAnchor, `${sym} S&R ${lvl.id} must expose priceAnchor snapped to a real candle high/low`);
      const pc = candles[lvl.priceAnchor.index];
      const expectedCenter = lvl.priceAnchor.polarity === 'high' ? pc.high : pc.low;
      assert.equal(lvl.price, expectedCenter, `${sym} S&R ${lvl.id} price ${lvl.price} !== candle ${expectedCenter}`);
      totalAnchorsChecked++;
    }

    // 3) Trendlines (startAnchor, endAnchor, touchAnchors)
    for (const tl of out.trendlines) {
      for (const anc of [tl.startAnchor, tl.endAnchor, ...(tl.touchAnchors || [])]) {
        const c = candles[anc.index];
        const expected = tl.role === 'resistance' ? c.high : c.low;
        assert.equal(anc.price, expected, `${sym} trendline ${tl.id} anchor[${anc.index}] price ${anc.price} !== ${expected}`);
        totalAnchorsChecked++;
      }
    }

    // 4) Box ranges (upperAnchor -> high, lowerAnchor -> low, bounds match anchors)
    for (const bx of out.boxRanges) {
      const uc = candles[bx.upperAnchor.index];
      const lc = candles[bx.lowerAnchor.index];
      assert.equal(bx.upperAnchor.price, uc.high, `${sym} box ${bx.id} upperAnchor ${bx.upperAnchor.price} !== candle.high ${uc.high}`);
      assert.equal(bx.lowerAnchor.price, lc.low, `${sym} box ${bx.id} lowerAnchor ${bx.lowerAnchor.price} !== candle.low ${lc.low}`);
      assert.equal(bx.upperBound, uc.high, `${sym} box ${bx.id} upperBound ${bx.upperBound} !== candle.high ${uc.high}`);
      assert.equal(bx.lowerBound, lc.low, `${sym} box ${bx.id} lowerBound ${bx.lowerBound} !== candle.low ${lc.low}`);
      totalAnchorsChecked += 2;
    }

    // 5) Divergences (bullish -> low, bearish -> high)
    for (const dv of out.divergences) {
      for (const anc of [dv.startAnchor, dv.endAnchor]) {
        const c = candles[anc.index];
        const expected = dv.bias === 'bullish' ? c.low : c.high;
        assert.equal(anc.price, expected, `${sym} divergence ${dv.id} anchor[${anc.index}] price ${anc.price} !== ${expected}`);
        totalAnchorsChecked++;
      }
    }

    // 6) Geometric chart patterns (all points + startAnchor + endAnchor)
    for (const pat of out.patterns) {
      for (const pt of [...(pat.points || []), pat.startAnchor, pat.endAnchor].filter(Boolean)) {
        const c = candles[pt.index];
        assert.ok(c, `${sym} pattern ${pat.id} point index ${pt.index} out of bounds`);
        assert.ok(
          pt.price === c.high || pt.price === c.low,
          `${sym} pattern ${pat.id} anchor[${pt.index}] price ${pt.price} must equal candle high (${c.high}) or low (${c.low})`
        );
        totalAnchorsChecked++;
      }
    }

    // 7) Built M3 annotations retain exact anchor snapping
    const ann = buildAnnotationsFromPatternEngine(out, { candles });
    for (const lvl of ann.horizontalLevels) {
      const c = candles[lvl.anchorIndex];
      assert.ok(lvl.price === c.high || lvl.price === c.low, `${sym} built level ${lvl.id} must snap to candle high/low`);
    }
    for (const tl of ann.trendlines) {
      assert.equal(tl.startPrice, tl.role === 'resistance' ? candles[tl.startIndex].high : candles[tl.startIndex].low);
      assert.equal(tl.endPrice, tl.role === 'resistance' ? candles[tl.endIndex].high : candles[tl.endIndex].low);
    }
    for (const p of ann.patterns) {
      for (const anc of p.anchors || []) {
        const c = candles[anc.index];
        assert.ok(anc.price === c.high || anc.price === c.low, `${sym} built pattern ${p.id} anchor must snap to candle high/low`);
      }
    }
  }

  assert.ok(totalAnchorsChecked > 200, `Expected > 200 anchors audited across 5 NSE fixtures (checked ${totalAnchorsChecked})`);

  // 8) Explicitly audit un-thresholded pattern vertices (incl. HDFCBANK.NS post-split non-0.05 decimals like 831.72)
  const { detectChartPatterns } = await import('../public/js/patternEngine.js');
  const hdfcOut = runPatternRuleEngine(rawFixtures['HDFCBANK.NS'].candles, { interval: '1d', timeZone: 'Asia/Kolkata', useCache: false });
  const hdfcAllPats = detectChartPatterns(hdfcOut.candles, hdfcOut.swings, { _alreadyNormalized: true, minScore: 0 });
  assert.ok(hdfcAllPats.length > 0, 'HDFCBANK.NS must produce raw pattern candidates for post-split decimal anchor audit');
  for (const pat of hdfcAllPats) {
    for (const pt of [...(pat.points || []), pat.startAnchor, pat.endAnchor].filter(Boolean)) {
      const c = hdfcOut.candles[pt.index];
      assert.ok(
        pt.price === c.high || pt.price === c.low,
        `HDFCBANK.NS raw pattern ${pat.id} anchor[${pt.index}] price ${pt.price} drifted from exact candle high (${c.high}) / low (${c.low})`
      );
    }
  }
});

test('M3.3 Aesthetic caps, score selection, device-pixel snapping, segment clipping, and right-axis label collision avoidance', async () => {
  const { runPatternRuleEngine } = await import('../public/js/patternEngine.js');
  const {
    ANNOTATION_STYLE_CONFIG,
    buildAnnotationsFromPatternEngine,
    snapBitmapCoord,
    clipSegmentToRect,
    resolveNonOverlappingLabels
  } = await import('../public/js/lwcAnnotationPrimitive.js');

  const rawFixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).fixtures;

  // 1) Aesthetic caps strictly enforced across all 5 NSE fixtures
  for (const sym of FIVE_NSE_SYMBOLS) {
    const out = runPatternRuleEngine(rawFixtures[sym].candles, { useCache: false });
    const ann = buildAnnotationsFromPatternEngine(out, { candles: out.candles });
    assert.equal(ann.source, 'patternEngine');
    const sups = ann.horizontalLevels.filter((l) => l.type === 'support');
    const ress = ann.horizontalLevels.filter((l) => l.type === 'resistance');
    assert.ok(sups.length <= 2, `${sym} supports (${sups.length}) must be <= 2`);
    assert.ok(ress.length <= 2, `${sym} resistances (${ress.length}) must be <= 2`);
    assert.ok(ann.trendlines.length <= 1, `${sym} trendlines (${ann.trendlines.length}) must be <= 1`);
    assert.ok(ann.patterns.length <= 1, `${sym} patterns+boxes (${ann.patterns.length}) must be <= 1`);
    // Supports & resistances must be the highest-scoring candidates from patternEngine
    if (sups.length === 2) assert.ok(sups[0].score >= sups[1].score);
    if (ress.length === 2) assert.ok(ress[0].score >= ress[1].score);
  }

  // 2) Centralized palette distinguishes support vs resistance vs trendline vs volume/EMA colors
  const light = ANNOTATION_STYLE_CONFIG.palette.light;
  assert.notEqual(light.supportLine, light.resistanceLine);
  assert.notEqual(light.supportLine, light.trendlineLine);
  assert.notEqual(light.resistanceLine, light.trendlineLine);
  // Distinct from default EMA5 (#f59e0b), EMA10 (#06b6d4), EMA20 (#2962ff) and candle bull/bear (#089981/#f23645)
  const reservedColors = new Set(['#f59e0b', '#06b6d4', '#2962ff', '#089981', '#f23645']);
  assert.equal(reservedColors.has(light.supportLine), false);
  assert.equal(reservedColors.has(light.resistanceLine), false);
  assert.equal(reservedColors.has(light.trendlineLine), false);
  assert.equal(reservedColors.has(light.patternLine), false);

  // 3) Device-pixel snapping guarantees <= 0.5 CSS px error at DPR 1 and <= 0.25 CSS px at DPR 2
  for (const media of [100.0, 100.23, 100.49, 100.51, 100.87, 253.74]) {
    const errDpr1Odd = Math.abs(snapBitmapCoord(media, 1, 1) / 1 - media);
    const errDpr1Even = Math.abs(snapBitmapCoord(media, 1, 2) / 1 - media);
    const errDpr2Odd = Math.abs(snapBitmapCoord(media, 2, 3) / 2 - media);
    const errDpr2Even = Math.abs(snapBitmapCoord(media, 2, 4) / 2 - media);
    assert.ok(errDpr1Odd <= 0.5001, `DPR1 odd err ${errDpr1Odd} > 0.5`);
    assert.ok(errDpr1Even <= 0.5001, `DPR1 even err ${errDpr1Even} > 0.5`);
    assert.ok(errDpr2Odd <= 0.2501, `DPR2 odd err ${errDpr2Odd} > 0.25`);
    assert.ok(errDpr2Even <= 0.2501, `DPR2 even err ${errDpr2Even} > 0.25`);
  }

  // 4) Segment clipping bounds any trendline ray strictly within [0, plotW] x [0, plotH]
  const clipped = clipSegmentToRect(50, 100, 950, -80, 0, 0, 800, 500);
  assert.ok(clipped);
  assert.ok(clipped.x1 >= 0 && clipped.x1 <= 800 && clipped.y1 >= 0 && clipped.y1 <= 500);
  assert.ok(clipped.x2 >= 0 && clipped.x2 <= 800 && clipped.y2 >= 0 && clipped.y2 <= 500);
  assert.equal(clipSegmentToRect(-100, -50, -10, -20, 0, 0, 800, 500), null);

  // 5) Right-axis label collision avoidance enforces >= 20px minimum gap even on crowded levels
  const crowded = [
    { id: 'r1', targetY: 120 },
    { id: 'r2', targetY: 123 },
    { id: 's1', targetY: 126 },
    { id: 's2', targetY: 129 }
  ];
  const spaced = resolveNonOverlappingLabels(crowded, { minGap: 20, minY: 14, maxY: 480 });
  assert.equal(spaced.length, 4);
  for (let i = 1; i < spaced.length; i++) {
    assert.ok(
      spaced[i].y - spaced[i - 1].y >= 19.99,
      `Labels ${spaced[i - 1].id} and ${spaced[i].id} overlap: gap=${spaced[i].y - spaced[i - 1].y}`
    );
  }
  for (const item of spaced) {
    assert.ok(item.y >= 14 && item.y <= 480);
  }
});

test('M3.4 Native AIAnnotationSeriesPrimitive uses logical coordinates for future ray extension and clears completely via clear()', async () => {
  const { AIAnnotationSeriesPrimitive } = await import('../public/js/lwcAnnotationPrimitive.js');

  const logicalCalls = [];
  let drawOps = 0;
  let requestUpdateCount = 0;

  const mockCtx = {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    arc() {},
    stroke() { drawOps++; },
    fill() { drawOps++; },
    fillRect() { drawOps++; },
    strokeRect() { drawOps++; },
    fillText() { drawOps++; },
    setLineDash() {},
    measureText: (t) => ({ width: String(t).length * 7 })
  };

  const mockChart = {
    timeScale: () => ({
      timeToCoordinate: (t) => (t <= 1000 ? 100 + t * 0.4 : null),
      logicalToCoordinate: (idx) => {
        logicalCalls.push(idx);
        return 50 + idx * 8;
      }
    })
  };
  const mockSeries = {
    priceToCoordinate: (p) => 400 - (p - 1000) * 2
  };

  const primitive = new AIAnnotationSeriesPrimitive({ theme: 'light', precision: 2 });
  primitive.attached({
    chart: mockChart,
    series: mockSeries,
    requestUpdate: () => { requestUpdateCount++; }
  });

  primitive.setAnnotations({
    source: 'patternEngine',
    horizontalLevels: [
      { id: 'r1', type: 'resistance', price: 1120, bandLow: 1118, bandHigh: 1122, startIndex: 10, endIndex: 50, startTime: 100, endTime: 500, anchorIndex: 40, anchorTime: 400, strength: 'strong', label: 'R1 ₹1120.00' },
      { id: 's1', type: 'support', price: 1050, bandLow: 1048, bandHigh: 1052, startIndex: 15, endIndex: 50, startTime: 150, endTime: 500, anchorIndex: 35, anchorTime: 350, strength: 'strong', label: 'S1 ₹1050.00' }
    ],
    trendlines: [
      {
        id: 'tl1',
        role: 'support',
        startIndex: 10,
        endIndex: 48,
        startAnchor: { index: 10, time: 100, price: 1040 },
        endAnchor: { index: 48, time: 480, price: 1080 },
        extendRight: true,
        extendBars: 12,
        label: '上升趋势线'
      }
    ],
    patterns: [],
    signals: []
  });

  assert.ok(requestUpdateCount >= 1);

  const renderer = primitive.paneViews()[0].renderer();
  renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: mockCtx,
        bitmapSize: { width: 1600, height: 1000 },
        mediaSize: { width: 800, height: 500 },
        horizontalPixelRatio: 2,
        verticalPixelRatio: 2
      })
  });

  assert.ok(drawOps > 0, 'Primitive must render drawing operations when annotations are set');
  assert.ok(logicalCalls.includes(60), 'Trendline ray extension must call logicalToCoordinate(48 + 12 = 60) without future timestamps');
  const layout = primitive.getLastRenderedLayout();
  assert.ok(layout && layout.horizontalLevels.length === 2 && layout.trendlines.length === 1);
  assert.ok(layout.trendlines[0].clippedRay, 'Bounded ray extension must be computed and clipped inside plot');

  // Clear all AI annotations -> subsequent draw emits ZERO operations
  primitive.clear();
  drawOps = 0;
  renderer.draw({
    useBitmapCoordinateSpace: (cb) =>
      cb({
        context: mockCtx,
        bitmapSize: { width: 1600, height: 1000 },
        mediaSize: { width: 800, height: 500 },
        horizontalPixelRatio: 2,
        verticalPixelRatio: 2
      })
  });
  assert.equal(drawOps, 0, 'Cleared primitive must draw 0 operations');
  assert.equal(primitive.getLastRenderedLayout(), null);
});
