const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startMockAppServer, withCdpPage } = require('./helpers');

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'india-daily-klines.json');
const FIVE_NSE_SYMBOLS = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'SUNPHARMA.NS', 'ITC.NS'];

const PALETTE_RGB = {
  support: [4, 120, 87],       // #047857
  resistance: [190, 18, 60],   // #be123c
  trendline: [109, 40, 217],   // #6d28d9
  pattern: [55, 48, 163],      // #3730a3
  signalBull: [15, 118, 110],  // #0f766e
  signalBear: [159, 18, 57]    // #9f1239
};

/**
 * Pure zero-dependency RFC 2083 PNG decoder (8-bit RGB/RGBA) using built-in node:zlib.
 * Allows inspecting actual exported PNG pixel bytes without any external packages.
 */
function decodePngRgba(pngBuffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(pngBuffer.length > 33 && pngBuffer.subarray(0, 8).equals(sig), 'Invalid PNG signature');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = pngBuffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  assert.equal(bitDepth, 8, `Expected 8-bit PNG, got ${bitDepth}`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp === 3 || bpp === 4, `Unsupported PNG colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const recon = Buffer.alloc(height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const filt = raw[rowStart + x];
      const a = x >= bpp ? recon[outStart + x - bpp] : 0;
      const b = y > 0 ? recon[outStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? recon[outStart - stride + x - bpp] : 0;
      let val = filt;
      if (filterType === 1) val = (filt + a) & 0xff;
      else if (filterType === 2) val = (filt + b) & 0xff;
      else if (filterType === 3) val = (filt + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) val = (filt + paeth(a, b, c)) & 0xff;
      recon[outStart + x] = val;
    }
  }

  if (bpp === 4) {
    return { width, height, rgba: recon };
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < recon.length; i += 3, j += 4) {
    rgba[j] = recon[i];
    rgba[j + 1] = recon[i + 1];
    rgba[j + 2] = recon[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function colorMatchScore(r, g, b, targetRgb) {
  const dr = r - targetRgb[0];
  const dg = g - targetRgb[1];
  const db = b - targetRgb[2];
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  // Strong match when pixel is pure target color or anti-aliased blend with white/translucent bg
  if (dist <= 38) return 1.0 - dist / 45;
  // Also recognize anti-aliased edge blended against white (#ffffff) or translucent zone
  const wr = 255 - r;
  const wg = 255 - g;
  const wb = 255 - b;
  const tr = 255 - targetRgb[0];
  const tg = 255 - targetRgb[1];
  const tb = 255 - targetRgb[2];
  const tNorm = Math.sqrt(tr * tr + tg * tg + tb * tb);
  const wNorm = Math.sqrt(wr * wr + wg * wg + wb * wb);
  if (wNorm < 40 || tNorm < 1) return 0;
  const alpha = wNorm / tNorm;
  if (alpha < 0.28 || alpha > 1.25) return 0;
  const cos = (wr * tr + wg * tg + wb * tb) / (wNorm * tNorm);
  return cos >= 0.985 ? Math.min(1, alpha) * 0.7 : 0;
}

function getPixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const idx = (y * img.width + x) * 4;
  return [img.rgba[idx], img.rgba[idx + 1], img.rgba[idx + 2], img.rgba[idx + 3]];
}

/**
 * Measure exact Y alignment error (in CSS px) of a horizontal line across multiple clean columns.
 */
function measureHorizontalLineYError(img, { expectedMediaY, startMediaX, endMediaX, targetRgb, dpr }) {
  const expectedBy = expectedMediaY * dpr;
  const minX = Math.max(4, Math.floor((startMediaX + 6) * dpr));
  // Stop left of the right-axis price pill (~95 CSS px wide)
  const maxX = Math.min(img.width - 4, Math.floor((endMediaX - 115) * dpr));
  if (maxX <= minX) return null;

  const colErrors = [];
  const stepX = Math.max(2, Math.floor((maxX - minX) / 48));
  for (let x = minX; x <= maxX; x += stepX) {
    let wSum = 0;
    let ySum = 0;
    let maxW = 0;
    const y0 = Math.max(0, Math.floor(expectedBy - 4));
    const y1 = Math.min(img.height - 1, Math.ceil(expectedBy + 4));
    for (let y = y0; y <= y1; y++) {
      const px = getPixel(img, x, y);
      if (!px) continue;
      const w = colorMatchScore(px[0], px[1], px[2], targetRgb);
      if (w > 0) {
        wSum += w;
        ySum += (y + 0.5) * w;
        if (w > maxW) maxW = w;
      }
    }
    // Require a clear crisp stroke hit (skip columns inside dash gaps or occluded by candles)
    if (wSum >= 0.9 && maxW >= 0.65) {
      const centroidBy = ySum / wSum;
      colErrors.push(Math.abs(centroidBy / dpr - expectedMediaY));
    }
  }

  if (colErrors.length < 3) return null;
  colErrors.sort((a, b) => a - b);
  return {
    medianErrCss: colErrors[Math.floor(colErrors.length / 2)],
    samples: colErrors.length
  };
}

/**
 * Measure exact 2D (X time & Y price) alignment error (in CSS px) of a rendered anchor dot
 * centered at (expectedMediaX, expectedMediaY).
 */
function measureAnchorDotXYError(img, { expectedMediaX, expectedMediaY, targetRgb, dpr }) {
  const bx = expectedMediaX * dpr;
  const by = expectedMediaY * dpr;
  // Symmetric circular window matching the halo-isolated anchor dot fill (r = 3.0 CSS px + 1.2 CSS px white halo)
  const rad = 3.1 * dpr;
  const radSq = rad * rad;
  const xMin = Math.floor(bx - rad - 1);
  const xMax = Math.ceil(bx + rad + 1);
  const yMin = Math.floor(by - rad - 1);
  const yMax = Math.ceil(by + rad + 1);
  let wSum = 0;
  let xSum = 0;
  let ySum = 0;
  let strongHits = 0;

  for (let pxY = yMin; pxY <= yMax; pxY++) {
    for (let pxX = xMin; pxX <= xMax; pxX++) {
      const dx = (pxX + 0.5) - bx;
      const dy = (pxY + 0.5) - by;
      if (dx * dx + dy * dy > radSq) continue;
      const px = getPixel(img, pxX, pxY);
      if (!px) continue;
      const w = colorMatchScore(px[0], px[1], px[2], targetRgb);
      if (w >= 0.65) {
        wSum += w;
        xSum += (pxX + 0.5) * w;
        ySum += (pxY + 0.5) * w;
        strongHits++;
      }
    }
  }

  if (strongHits < Math.max(4, Math.floor(dpr * dpr * 4))) return null;
  const cx = xSum / wSum;
  const cy = ySum / wSum;
  return {
    errXCss: Math.abs(cx / dpr - expectedMediaX),
    errYCss: Math.abs(cy / dpr - expectedMediaY),
    strongHits
  };
}

/**
 * Measure perpendicular pixel alignment error along a diagonal trendline or ray segment.
 */
function measureSegmentLineError(img, { x1, y1, x2, y2, targetRgb, dpr }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 12) return null;
  // Unit normal perpendicular to segment
  const nx = -dy / len;
  const ny = dx / len;

  const errs = [];
  const steps = Math.min(36, Math.max(10, Math.floor(len / 5)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const mx = x1 + dx * t;
    const my = y1 + dy * t;
    let wSum = 0;
    let dSum = 0;
    let maxW = 0;
    // Scan perpendicularly in [-3, +3] bitmap px
    for (let k = -3; k <= 3; k += 0.5) {
      const pxX = Math.floor(mx * dpr + nx * k);
      const pxY = Math.floor(my * dpr + ny * k);
      const px = getPixel(img, pxX, pxY);
      if (!px) continue;
      const w = colorMatchScore(px[0], px[1], px[2], targetRgb);
      if (w > 0) {
        wSum += w;
        dSum += k * w;
        if (w > maxW) maxW = w;
      }
    }
    if (wSum >= 0.8 && maxW >= 0.5) {
      errs.push(Math.abs((dSum / wSum) / dpr));
    }
  }
  if (errs.length < 2) return null;
  errs.sort((a, b) => a - b);
  return {
    medianPerpErrCss: errs[Math.floor(errs.length / 2)],
    samples: errs.length
  };
}

const HOLDOUT_PATH = path.join(__dirname, '..', 'fixtures', 'india-holdout-klines.json');

async function runM3BrowserTest(chromeBin, options = {}) {
  const devFixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')).fixtures;
  const holdoutFixtures = fs.existsSync(HOLDOUT_PATH)
    ? JSON.parse(fs.readFileSync(HOLDOUT_PATH, 'utf8')).fixtures
    : {};
  const fixtureData = options.fixturesMap || { ...devFixtures, ...holdoutFixtures };
  const symbolsToTest = options.symbols || FIVE_NSE_SYMBOLS;
  const saveDir = options.saveDir || process.env.M3_SAVE_SCREENSHOTS_DIR || '';
  const commitTag = options.commitTag || process.env.M3_COMMIT_TAG || '';
  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

  const mockMarketService = {
    searchSymbols: async () => ({ results: [], remoteOnline: true }),
    getKlines: async (symbol, interval) => {
      const key = fixtureData[symbol] ? symbol : 'RELIANCE.NS';
      const entry = fixtureData[key];
      const toSec = (t) => (typeof t === 'number' ? t : Math.floor(Date.parse(t) / 1000));
      const candles = entry.candles.map((c) => ({
        time: toSec(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));
      const lastSec = candles[candles.length - 1].time;
      return {
        symbol: key,
        interval: interval || '1d',
        source: 'live',
        feedName: 'Yahoo Finance Real-Time (yahoo:query1)',
        instrument: {
          symbol: key,
          displaySymbol: key.replace(/\.(NS|BO)$/i, ''),
          name: entry.name || key,
          enName: entry.name || key,
          exchange: 'NSE',
          market: 'in',
          currency: 'INR'
        },
        candles,
        events: [],
        meta: {
          source: 'live',
          fetchedAt: lastSec * 1000,
          ageMs: 0,
          stale: false,
          provider: 'yahoo:query1',
          priceBasis: 'split_adjusted_raw_ohlc',
          latestBarTime: lastSec,
          exchangeTimezone: 'Asia/Kolkata',
          timezone: 'IST',
          utcOffset: '+05:30',
          latestTradingDay: '2026-11-20',
          resolvedSymbol: key,
          exchange: 'NSE',
          exchangeFallback: false
        }
      };
    },
    getLatestTick: async (symbol) => {
      const key = fixtureData[symbol] ? symbol : 'RELIANCE.NS';
      const entry = fixtureData[key];
      const raw = entry.candles;
      const last = raw[raw.length - 1];
      const prev = raw[raw.length - 2];
      const lastSec = typeof last.time === 'number' ? last.time : Math.floor(Date.parse(last.time) / 1000);
      return {
        symbol: key,
        interval: '1d',
        source: 'live',
        candle: { time: lastSec, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume },
        prevClose: prev.close,
        meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: lastSec, exchange: 'NSE' }
      };
    },
    getStockFundamentals: async (symbol) => ({
      symbol,
      sector: fixtureData[symbol]?.sector || 'Energy',
      headlines: [],
      meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: Math.floor(Date.now() / 1000), exchange: 'NSE' }
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(
      chromeBin,
      srv.baseUrl,
      async ({ evaluate, consoleErrors, pageExceptions }) => {
        // 1) Confirm transitional #mainChartCanvas & dead manual-drawing controls are completely removed
        const domAudit = await evaluate(`(() => ({
          hasMainChartCanvas: Boolean(document.getElementById('mainChartCanvas')),
          hasLwcContainer: Boolean(document.getElementById('lwcChartContainer')),
          drawToolBtnCount: document.querySelectorAll('[data-draw-tool]').length,
          hasClearBtn: Boolean(document.getElementById('btnClearDrawings')),
          hasToggleAiBtn: Boolean(document.getElementById('btnToggleAiLayer'))
        }))()`);
        assert.equal(domAudit.hasMainChartCanvas, false, 'Transitional #mainChartCanvas must be completely removed');
        assert.equal(domAudit.hasLwcContainer, true, '#lwcChartContainer must exist');
        assert.equal(domAudit.drawToolBtnCount, 0, 'All dead [data-draw-tool] buttons must be removed');
        assert.equal(domAudit.hasClearBtn, true);
        assert.equal(domAudit.hasToggleAiBtn, true);

        const rupeeProbe = await evaluate(`(async () => {
          const mod = await import('/js/lwcAnnotationPrimitive.js');
          mod.clearRupeeGlyphCache();
          const supported = mod.detectRupeeGlyphSupport({ forceCheck: true });
          const prefix = mod.resolveInrCurrencyPrefix();
          return { supported, prefix };
        })()`);
        assert.equal(typeof rupeeProbe.supported, 'boolean');
        assert.equal(rupeeProbe.prefix, rupeeProbe.supported ? '₹' : 'Rs.');

        const summaryBySymbol = {};

        // 2) Run full M3 alignment & visual checks across target NSE fixtures
        for (const sym of symbolsToTest) {
          const snapInfo = await evaluate(`(async () => {
            const app = window.__chartCopilot;
            // Clear any saved API key so built-in patternEngine path runs deterministically offline
            localStorage.removeItem('chartcopilot_ai_settings_v1');
            await app.loadSymbol(${JSON.stringify(sym)}, '1d');
            await new Promise((r) => setTimeout(r, 120));

            await app.copilot.ask('分析关键支撑阻力与技术形态', {
              captureScreenshot: false,
              autoDraw: true
            });
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));

            const c = app.chart;
            const shot = c.captureSnapshot({ includeCurrentAI: true });
            const layout = c.getAnnotationLayout();
            const ts = c.lwcChart.timeScale();
            const ann = c.aiAnnotations;

            const verifyCoords = (anc) => {
              const tCoord = anc.time != null ? ts.timeToCoordinate(anc.time) : null;
              const lCoord = Number.isFinite(anc.index) ? ts.logicalToCoordinate(anc.index) : null;
              const pCoord = c.candleSeries.priceToCoordinate(anc.price);
              return { index: anc.index, time: anc.time, price: anc.price, tCoord, lCoord, pCoord };
            };

            const levelChecks = (ann?.horizontalLevels || []).map((lvl) => ({
              id: lvl.id,
              type: lvl.type,
              price: lvl.price,
              label: lvl.label,
              pCoord: c.candleSeries.priceToCoordinate(lvl.price),
              startCoord: verifyCoords({ index: lvl.startIndex, time: lvl.startTime, price: lvl.price }),
              anchorCoord: verifyCoords({ index: lvl.anchorIndex, time: lvl.anchorTime, price: lvl.price })
            }));

            const trendChecks = (ann?.trendlines || []).map((tl) => {
              const s = verifyCoords(tl.startAnchor);
              const e = verifyCoords(tl.endAnchor);
              const extBars = tl.extendBars || 12;
              const rayLogical = tl.endAnchor.index + extBars;
              const exactSlope = (tl.endAnchor.price - tl.startAnchor.price) / Math.max(1, tl.endAnchor.index - tl.startAnchor.index);
              const rayPrice = tl.endAnchor.price + exactSlope * extBars;
              return {
                id: tl.id,
                role: tl.role,
                label: tl.label,
                start: s,
                end: e,
                ray: {
                  logical: rayLogical,
                  lCoord: ts.logicalToCoordinate(rayLogical),
                  pCoord: c.candleSeries.priceToCoordinate(rayPrice)
                }
              };
            });

            const patternChecks = (ann?.patterns || []).map((pat) => ({
              id: pat.id,
              kind: pat.kind,
              name: pat.name,
              anchors: (pat.anchors || []).map(verifyCoords)
            }));

            const signalChecks = (ann?.signals || []).map((sig) => ({
              id: sig.id,
              kind: sig.kind,
              anchor: verifyCoords(sig.endAnchor || { index: sig.index, time: sig.time, price: sig.price })
            }));

            return {
              symbol: ${JSON.stringify(sym)},
              source: ann?.source,
              dpr: shot.dpr,
              width: shot.width,
              height: shot.height,
              bitmapWidth: shot.bitmapWidth,
              bitmapHeight: shot.bitmapHeight,
              dataUrl: shot.cleanDataUrl,
              layout,
              levelChecks,
              trendChecks,
              patternChecks,
              signalChecks
            };
          })()`);

          assert.equal(snapInfo.source, 'patternEngine', `${sym} annotations must come from patternEngine`);
          assert.ok(snapInfo.dataUrl && snapInfo.dataUrl.startsWith('data:image/png;base64,'), `${sym} PNG export failed`);
          assert.ok(snapInfo.layout, `${sym} primitive layout must be populated`);

          const pngBuf = Buffer.from(snapInfo.dataUrl.split(',')[1], 'base64');
          if (saveDir) {
            const safeSym = sym.replace(/[^A-Za-z0-9]/g, '_');
            const fname = commitTag ? `${safeSym}-${commitTag}.png` : `${safeSym}.png`;
            fs.writeFileSync(path.join(saveDir, fname), pngBuf);
          }

          const img = decodePngRgba(pngBuf);
          const dpr = snapInfo.layout.verticalPixelRatio;
          const plotW = snapInfo.layout.mediaSize.width;
          const plotH = snapInfo.layout.mediaSize.height;

          // Aesthetic cap checks
          const supLevels = snapInfo.levelChecks.filter((l) => l.type === 'support');
          const resLevels = snapInfo.levelChecks.filter((l) => l.type === 'resistance');
          assert.ok(supLevels.length <= 2, `${sym} supports (${supLevels.length}) > 2`);
          assert.ok(resLevels.length <= 2, `${sym} resistances (${resLevels.length}) > 2`);
          assert.ok(snapInfo.trendChecks.length <= 1, `${sym} trendlines (${snapInfo.trendChecks.length}) > 1`);
          assert.ok(snapInfo.patternChecks.length <= 1, `${sym} patterns (${snapInfo.patternChecks.length}) > 1`);

          // Label non-overlap & plot bounds check
          const labels = [...(snapInfo.layout.labels || [])].sort((a, b) => a.y - b.y);
          for (let i = 0; i < labels.length; i++) {
            assert.ok(
              labels[i].x >= 0 && labels[i].x + labels[i].width <= plotW + 1,
              `${sym} label ${labels[i].text} exceeds plot X bounds`
            );
            assert.ok(
              labels[i].y >= 8 && labels[i].y <= plotH - 8,
              `${sym} label ${labels[i].text} exceeds plot Y bounds`
            );
            if (i > 0) {
              const gap = labels[i].y - labels[i - 1].y;
              assert.ok(
                gap >= 19.5,
                `${sym} right-axis labels overlap: ${labels[i - 1].text} & ${labels[i].text} gap=${gap.toFixed(2)}px`
              );
            }
          }

          let maxErrYCss = 0;
          let maxErrXCss = 0;
          let checkedLines = 0;
          let checkedAnchors = 0;

          // A) Check EVERY visible horizontal S&R line in exported PNG (Y error <= 0.5 CSS px)
          for (const lvl of snapInfo.levelChecks) {
            const layoutLvl = snapInfo.layout.horizontalLevels.find((h) => h.id === lvl.id);
            if (!layoutLvl || lvl.pCoord === null || lvl.pCoord < 4 || lvl.pCoord > plotH - 4) continue;
            const rgb = lvl.type === 'resistance' ? PALETTE_RGB.resistance : PALETTE_RGB.support;
            const res = measureHorizontalLineYError(img, {
              expectedMediaY: lvl.pCoord,
              startMediaX: layoutLvl.startMediaX,
              endMediaX: layoutLvl.endMediaX,
              targetRgb: rgb,
              dpr
            });
            assert.ok(res, `${sym} horizontal level ${lvl.id} (${lvl.price}) line pixels not found in exported PNG`);
            assert.ok(
              res.medianErrCss <= 0.5,
              `${sym} level ${lvl.id} Y error ${res.medianErrCss.toFixed(3)} CSS px > 0.5 px`
            );
            maxErrYCss = Math.max(maxErrYCss, res.medianErrCss);
            checkedLines++;

            // Also verify anchor X & Y when primary anchor is in viewport and clear of right-axis pills
            const a = lvl.anchorCoord;
            if (a.tCoord !== null && a.lCoord !== null) {
              assert.ok(
                Math.abs(a.tCoord - a.lCoord) <= 0.05,
                `${sym} timeToCoordinate (${a.tCoord}) !== logicalToCoordinate (${a.lCoord})`
              );
              if (a.tCoord >= 12 && a.tCoord <= plotW - 105 && a.pCoord >= 12 && a.pCoord <= plotH - 12) {
                const dotRes = measureAnchorDotXYError(img, {
                  expectedMediaX: a.tCoord,
                  expectedMediaY: a.pCoord,
                  targetRgb: rgb,
                  dpr
                });
                if (dotRes) {
                  assert.ok(dotRes.errXCss <= 0.5, `${sym} S&R anchor ${lvl.id} X error ${dotRes.errXCss.toFixed(3)} > 0.5px`);
                  assert.ok(dotRes.errYCss <= 0.5, `${sym} S&R anchor ${lvl.id} Y error ${dotRes.errYCss.toFixed(3)} > 0.5px`);
                  maxErrXCss = Math.max(maxErrXCss, dotRes.errXCss);
                  maxErrYCss = Math.max(maxErrYCss, dotRes.errYCss);
                  checkedAnchors++;
                }
              }
            }
          }

          // B) Check Trendline anchors (X & Y <= 0.5px), solid segment, AND logical-coordinate ray clipping
          for (const tl of snapInfo.trendChecks) {
            const layoutTl = snapInfo.layout.trendlines.find((t) => t.id === tl.id);
            assert.ok(layoutTl, `${sym} trendline ${tl.id} must be rendered in layout`);

            // Bounds check for clipped segments
            for (const seg of [layoutTl.clippedBase, layoutTl.clippedRay].filter(Boolean)) {
              assert.ok(
                seg.x1 >= -0.01 && seg.x1 <= plotW + 0.01 && seg.x2 >= -0.01 && seg.x2 <= plotW + 0.01 &&
                seg.y1 >= -0.01 && seg.y1 <= plotH + 0.01 && seg.y2 >= -0.01 && seg.y2 <= plotH + 0.01,
                `${sym} trendline/ray segment escaped plot bounds: ${JSON.stringify(seg)}`
              );
            }

            // Logical ray endpoint must resolve via logicalToCoordinate even past last bar
            assert.ok(Number.isFinite(tl.ray.lCoord), `${sym} trendline future ray must use logicalToCoordinate`);

            // Check both anchors in PNG when visible inside clean plot region
            for (const anc of [tl.start, tl.end]) {
              if (anc.tCoord !== null && anc.lCoord !== null) {
                assert.ok(Math.abs(anc.tCoord - anc.lCoord) <= 0.05);
                if (anc.tCoord >= 12 && anc.tCoord <= plotW - 105 && anc.pCoord >= 12 && anc.pCoord <= plotH - 12) {
                  const dotRes = measureAnchorDotXYError(img, {
                    expectedMediaX: anc.tCoord,
                    expectedMediaY: anc.pCoord,
                    targetRgb: PALETTE_RGB.trendline,
                    dpr
                  });
                  assert.ok(dotRes, `${sym} trendline anchor (${anc.index}, ${anc.price}) dot missing in PNG`);
                  assert.ok(dotRes.errXCss <= 0.5, `${sym} trendline anchor X err ${dotRes.errXCss.toFixed(3)} > 0.5px`);
                  assert.ok(dotRes.errYCss <= 0.5, `${sym} trendline anchor Y err ${dotRes.errYCss.toFixed(3)} > 0.5px`);
                  maxErrXCss = Math.max(maxErrXCss, dotRes.errXCss);
                  maxErrYCss = Math.max(maxErrYCss, dotRes.errYCss);
                  checkedAnchors++;
                }
              }
            }

            // Check trendline line segment perpendicular pixel accuracy
            if (layoutTl.clippedBase) {
              const segRes = measureSegmentLineError(img, {
                ...layoutTl.clippedBase,
                targetRgb: PALETTE_RGB.trendline,
                dpr
              });
              if (segRes) {
                assert.ok(segRes.medianPerpErrCss <= 0.5, `${sym} trendline perp err ${segRes.medianPerpErrCss.toFixed(3)} > 0.5px`);
                maxErrYCss = Math.max(maxErrYCss, segRes.medianPerpErrCss);
              }
            }
          }

          // C) Check Pattern / Box anchor dots (X & Y <= 0.5px)
          for (const pat of snapInfo.patternChecks) {
            for (const anc of pat.anchors || []) {
              if (anc.tCoord !== null && anc.lCoord !== null) {
                assert.ok(Math.abs(anc.tCoord - anc.lCoord) <= 0.05);
                if (anc.tCoord >= 12 && anc.tCoord <= plotW - 105 && anc.pCoord >= 12 && anc.pCoord <= plotH - 12) {
                  const dotRes = measureAnchorDotXYError(img, {
                    expectedMediaX: anc.tCoord,
                    expectedMediaY: anc.pCoord,
                    targetRgb: PALETTE_RGB.pattern,
                    dpr
                  });
                  if (dotRes) {
                    assert.ok(dotRes.errXCss <= 0.5, `${sym} pattern anchor X err ${dotRes.errXCss.toFixed(3)} > 0.5px`);
                    assert.ok(dotRes.errYCss <= 0.5, `${sym} pattern anchor Y err ${dotRes.errYCss.toFixed(3)} > 0.5px`);
                    maxErrXCss = Math.max(maxErrXCss, dotRes.errXCss);
                    maxErrYCss = Math.max(maxErrYCss, dotRes.errYCss);
                    checkedAnchors++;
                  }
                }
              }
            }
          }

          assert.ok(checkedLines >= 1, `${sym} must verify >= 1 rendered horizontal S&R line in PNG`);
          assert.ok(checkedAnchors >= 1, `${sym} must verify >= 1 rendered 2D anchor (X & Y) in PNG`);

          summaryBySymbol[sym] = {
            supports: supLevels.map((l) => l.price),
            resistances: resLevels.map((l) => l.price),
            trendline: snapInfo.trendChecks[0]?.label || null,
            pattern: snapInfo.patternChecks[0]?.name || null,
            signals: snapInfo.signalChecks.length,
            labelsCount: labels.length,
            checkedLines,
            checkedAnchors,
            maxErrXCss: Number(maxErrXCss.toFixed(3)),
            maxErrYCss: Number(maxErrYCss.toFixed(3))
          };
        }

        // 3) Zoom recalculation verification + clearAIAnnotations() PNG verification on RELIANCE.NS
        const zoomAndClear = await evaluate(`(async () => {
          const app = window.__chartCopilot;
          await app.loadSymbol('RELIANCE.NS', '1d');
          await new Promise((r) => setTimeout(r, 120));
          await app.copilot.ask('分析', { captureScreenshot: false, autoDraw: true });
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))));

          const beforeRange = app.chart.getVisibleRange();
          const beforeLayout = app.chart.getAnnotationLayout();
          const beforeVisibleIds = new Set((beforeLayout?.horizontalLevels || []).map((h) => h.id));

          // Zoom in and confirm primitive auto-recalculates to new data coordinates
          app.chart.zoomBy(1.45);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))));
          const afterRange = app.chart.getVisibleRange();
          const zoomedShot = app.chart.captureSnapshot({ includeCurrentAI: true });
          const zoomedLayout = app.chart.getAnnotationLayout();
          const pickedRendered =
            (zoomedLayout?.horizontalLevels || []).find((h) => beforeVisibleIds.has(h.id)) ||
            (zoomedLayout?.horizontalLevels || [])[0];
          const pickedLvl = pickedRendered
            ? app.chart.aiAnnotations.horizontalLevels.find((l) => l.id === pickedRendered.id)
            : null;
          const afterY = pickedLvl ? app.chart.candleSeries.priceToCoordinate(pickedLvl.price) : null;

          // Click real #btnClearDrawings button and confirm primitive clears completely
          document.getElementById('btnClearDrawings').click();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))));
          const clearedLayout = app.chart.getAnnotationLayout();
          const clearedAnnotations = app.chart.aiAnnotations;
          const clearedShot = app.chart.captureSnapshot({ includeCurrentAI: true });

          return {
            beforeRange,
            afterRange,
            level: pickedLvl
              ? {
                  id: pickedLvl.id,
                  type: pickedLvl.type,
                  price: pickedLvl.price,
                  afterY
                }
              : null,
            zoomedLayout,
            zoomedDataUrl: zoomedShot.cleanDataUrl,
            clearedLayout,
            clearedAnnotations,
            clearedDataUrl: clearedShot.cleanDataUrl
          };
        })()`);

        assert.ok(
          zoomAndClear.afterRange.visibleStart > zoomAndClear.beforeRange.visibleStart,
          'Zooming in must change visible bar range'
        );
        const zoomedImg = decodePngRgba(Buffer.from(zoomAndClear.zoomedDataUrl.split(',')[1], 'base64'));
        const zLvlLayout = zoomAndClear.zoomedLayout.horizontalLevels.find((h) => h.id === zoomAndClear.level.id);
        assert.ok(zLvlLayout, 'Level must still render after zoom');
        const zRgb = zoomAndClear.level.type === 'resistance' ? PALETTE_RGB.resistance : PALETTE_RGB.support;
        const zErr = measureHorizontalLineYError(zoomedImg, {
          expectedMediaY: zoomAndClear.level.afterY,
          startMediaX: zLvlLayout.startMediaX,
          endMediaX: zLvlLayout.endMediaX,
          targetRgb: zRgb,
          dpr: zoomAndClear.zoomedLayout.verticalPixelRatio
        });
        assert.ok(zErr && zErr.medianErrCss <= 0.5, `Zoomed line must remain aligned <= 0.5px (got ${zErr?.medianErrCss})`);

        assert.equal(zoomAndClear.clearedAnnotations, null, 'Clear button must set aiAnnotations to null');
        assert.equal(zoomAndClear.clearedLayout, null, 'Clear button must clear primitive layout');
        const clearedImg = decodePngRgba(Buffer.from(zoomAndClear.clearedDataUrl.split(',')[1], 'base64'));
        const clearedLineStillPresent = measureHorizontalLineYError(clearedImg, {
          expectedMediaY: zoomAndClear.level.afterY,
          startMediaX: zLvlLayout.startMediaX,
          endMediaX: zLvlLayout.endMediaX,
          targetRgb: zRgb,
          dpr: zoomAndClear.zoomedLayout.verticalPixelRatio
        });
        assert.equal(clearedLineStillPresent, null, 'Cleared chart PNG must NOT contain old AI annotation line pixels');

        assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join('; ')}`);
        assert.deepEqual(pageExceptions, [], `Page exceptions: ${pageExceptions.join('; ')}`);

        return {
          domAudit,
          rupeeProbe,
          symbols: summaryBySymbol,
          zoomAlignedErrCss: Number(zErr.medianErrCss.toFixed(3)),
          clearedVerified: true
        };
      },
      { width: 1440, height: 900, deviceScaleFactor: 2 }
    );
  } finally {
    await srv.close();
  }
}

module.exports = { runM3BrowserTest, decodePngRgba };
