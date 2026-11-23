const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startMockAppServer, withCdpPage } = require('./helpers');

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'india-daily-klines.json');
const FIVE_NSE_SYMBOLS = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'SUNPHARMA.NS', 'ITC.NS'];
const EXPORT_OUT_DIR = '/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/adf4774c-dc80-41ec-a16c-53672cefac77/scratch/m5_exports';

const PALETTE_RGB = {
  support: [4, 120, 87],       // #047857
  resistance: [190, 18, 60],   // #be123c
  trendline: [109, 40, 217],   // #6d28d9
  pattern: [55, 48, 163]       // #3730a3
};

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
  assert.equal(bitDepth, 8);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp === 3 || bpp === 4);
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
  if (bpp === 4) return { width, height, rgba: recon };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < recon.length; i += 3, j += 4) {
    rgba[j] = recon[i];
    rgba[j + 1] = recon[i + 1];
    rgba[j + 2] = recon[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function getPixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const idx = (y * img.width + x) * 4;
  return [img.rgba[idx], img.rgba[idx + 1], img.rgba[idx + 2], img.rgba[idx + 3]];
}

function colorMatchScore(r, g, b, target) {
  const dr = r - target[0];
  const dg = g - target[1];
  const db = b - target[2];
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  if (dist > 60) return 0;
  return 1 - dist / 60;
}

function measureHorizontalLineYError(img, { expectedCssY, paneWidthCss, targetRgb, dpr }) {
  const expectedBy = expectedCssY * dpr;
  const minX = Math.floor(20 * dpr);
  const maxX = Math.floor((paneWidthCss - 20) * dpr);
  const colErrors = [];
  const stepX = Math.max(2, Math.floor((maxX - minX) / 48));
  for (let x = minX; x <= maxX; x += stepX) {
    let wSum = 0;
    let ySum = 0;
    let maxW = 0;
    const y0 = Math.max(0, Math.floor(expectedBy - 4 * dpr));
    const y1 = Math.min(img.height - 1, Math.ceil(expectedBy + 4 * dpr));
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
    if (wSum >= 0.9 && maxW >= 0.65) {
      const centroidBy = ySum / wSum;
      colErrors.push(Math.abs(centroidBy / dpr - expectedCssY));
    }
  }
  if (colErrors.length < 3) return null;
  colErrors.sort((a, b) => a - b);
  return {
    medianErrCss: colErrors[Math.floor(colErrors.length / 2)],
    samples: colErrors.length
  };
}

function measureAnchorDotXYError(img, { expectedCssX, expectedCssY, targetRgb, dpr }) {
  const bx = expectedCssX * dpr;
  const by = expectedCssY * dpr;
  const rad = 3.2 * dpr;
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
  if (strongHits < 4) return null;
  const cx = xSum / wSum;
  const cy = ySum / wSum;
  return {
    errXCss: Math.abs(cx / dpr - expectedCssX),
    errYCss: Math.abs(cy / dpr - expectedCssY),
    strongHits
  };
}

async function runM5BrowserTest(chromeBin) {
  // Verify screenshotAnnotator.js has zero references to legacy chartEngine.js
  const annotatorSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'screenshotAnnotator.js'), 'utf8');
  assert.equal(annotatorSrc.includes('chartEngine.js'), false, 'screenshotAnnotator.js must not reference legacy chartEngine.js');

  fs.mkdirSync(EXPORT_OUT_DIR, { recursive: true });
  const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

  const mockMarketService = {
    searchSymbols: async (q) => ({
      remoteOnline: true,
      results: FIVE_NSE_SYMBOLS.filter((s) => s.includes(String(q || '').toUpperCase()) || !q).map((sym) => ({
        symbol: sym,
        displaySymbol: sym.replace('.NS', ''),
        name: fixtureRaw.fixtures[sym]?.name || sym,
        enName: fixtureRaw.fixtures[sym]?.name || sym,
        exchange: 'NSE',
        market: 'in',
        type: '印股'
      }))
    }),
    getKlines: async (symbol, interval) => {
      const stock = fixtureRaw.fixtures[symbol] || fixtureRaw.fixtures['RELIANCE.NS'];
      const candles = stock.candles;
      const latestSec = candles[candles.length - 1].time;
      return {
        symbol,
        interval: interval || '1d',
        source: 'live',
        feedName: 'NSE Fixture Feed',
        instrument: {
          symbol,
          displaySymbol: symbol.replace('.NS', ''),
          name: stock.name,
          enName: stock.enName || symbol.replace('.NS', ''),
          exchange: 'NSE',
          market: 'in'
        },
        candles,
        meta: {
          source: 'live',
          stale: false,
          provider: 'yahoo:query1',
          latestBarTime: latestSec,
          exchangeTimezone: 'Asia/Kolkata',
          timezone: 'IST',
          requestedSymbol: symbol,
          resolvedSymbol: symbol,
          exchange: 'NSE',
          exchangeFallback: false
        }
      };
    },
    getLatestTick: async (symbol, interval) => {
      const stock = fixtureRaw.fixtures[symbol] || fixtureRaw.fixtures['RELIANCE.NS'];
      const candles = stock.candles;
      return {
        symbol,
        interval: interval || '1d',
        source: 'live',
        candle: candles[candles.length - 1],
        prevClose: candles[candles.length - 2].close,
        meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: candles[candles.length - 1].time, exchange: 'NSE' }
      };
    },
    getStockFundamentals: async (symbol) => ({
      symbol,
      sector: 'Energy & Conglomerate',
      industry: 'Integrated',
      headlines: [{ title: 'Quarterly earnings steady amid domestic demand', pubDate: '2026-03-20' }],
      meta: { source: 'live', stale: false, provider: 'yahoo:query1', exchange: 'NSE' }
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(chromeBin, srv.baseUrl, async ({ evaluate, consoleErrors, pageExceptions }) => {
      const summary = { exports: {}, uiChecks: null };

      for (const sym of FIVE_NSE_SYMBOLS) {
        const res = await evaluate(`(async () => {
          const app = window.__chartCopilot;
          await app.loadSymbol(${JSON.stringify(sym)}, '1d');
          // Set UI to dark theme to prove export forces light theme & restores dark theme
          app.chart.setTheme('dark');
          const beforeW = app.chart.width;
          const beforeH = app.chart.height;
          const beforeTheme = app.chart.theme;

          // Clear previous annotations and capture clean vision snapshot
          const cleanSnap = app.chart.captureSnapshot({ includeCurrentAI: false });
          await app.copilot.ask('Analyze support resistance and pattern', { autoDraw: true, captureScreenshot: true });
          await new Promise((r) => setTimeout(r, 150));

          const afterW = app.chart.width;
          const afterH = app.chart.height;
          const afterTheme = app.chart.theme;
          const last = app.copilot.lastResult;
          const exportSnap = last.snapshot;

          // Map expected export coordinates (CSS px relative to 1600x900 final PNG, chart starts at y = 44)
          const headerH = 44;
          const paneW = exportSnap.geometry?.mainPane?.width || 1520;
          const coords = exportSnap.geometry?.exportCoords || { hLines: [], anchors: [] };
          const hLines = coords.hLines.map((x) => ({
            type: x.type,
            price: x.price,
            expectedCssY: headerH + x.y
          }));
          const anchors = coords.anchors.map((a) => ({
            kind: a.kind,
            expectedCssX: a.x,
            expectedCssY: headerH + a.y
          }));

          const reportEl = document.querySelector('.strict-report-body');
          const disclaimerEl = document.getElementById('cornerDisclaimer');
          const copyBtn = document.querySelector('.js-copy-report');
          const dlBtn = document.querySelector('.js-download-shot');

          return {
            cleanHasDataUrl: Boolean(cleanSnap.cleanDataUrl && cleanSnap.cleanDataUrl.startsWith('data:image/png;base64,')),
            uiRestored: beforeW === afterW && beforeH === afterH && beforeTheme === 'dark' && afterTheme === 'dark',
            annotatedImageUrl: last.annotatedImageUrl,
            paneW,
            hLines,
            anchors,
            ui: {
              hasReportPre: Boolean(reportEl),
              whiteSpace: reportEl ? getComputedStyle(reportEl).whiteSpace : '',
              hasCopyBtn: Boolean(copyBtn),
              hasDlBtn: Boolean(dlBtn),
              hasDisclaimer: Boolean(disclaimerEl),
              disclaimerExcludedFromReport: Boolean(reportEl && disclaimerEl && !reportEl.textContent.includes(disclaimerEl.textContent))
            }
          };
        })()`);

        assert.equal(res.cleanHasDataUrl, true, `${sym}: clean snapshot must be captured`);
        assert.equal(res.uiRestored, true, `${sym}: UI size and dark theme must be restored after light export`);
        assert.equal(res.ui.hasReportPre, true);
        assert.equal(res.ui.whiteSpace, 'pre-wrap');
        assert.equal(res.ui.hasCopyBtn, true);
        assert.equal(res.ui.hasDlBtn, true);
        assert.equal(res.ui.hasDisclaimer, true);
        assert.equal(res.ui.disclaimerExcludedFromReport, true);
        summary.uiChecks = res.ui;

        const base64 = res.annotatedImageUrl.replace(/^data:image\/png;base64,/, '');
        const pngBuf = Buffer.from(base64, 'base64');
        const outPath = path.join(EXPORT_OUT_DIR, `${sym}.png`);
        fs.writeFileSync(outPath, pngBuf);

        const img = decodePngRgba(pngBuf);
        assert.equal(img.width, 3200, `${sym}: exported PNG width must be 3200 (1600 @ 2x DPR)`);
        assert.equal(img.height, 1800, `${sym}: exported PNG height must be 1800 (900 @ 2x DPR)`);

        // Verify light theme header bar background (#f8f9fd -> R>=240, G>=240, B>=240)
        const hdrPx = getPixel(img, 10, 10);
        assert.ok(hdrPx[0] >= 240 && hdrPx[1] >= 240 && hdrPx[2] >= 240, `${sym}: exported header must be light theme`);

        let maxLineErr = 0;
        let checkedLines = 0;
        for (const hl of res.hLines) {
          const rgb = hl.type === 'support' ? PALETTE_RGB.support : PALETTE_RGB.resistance;
          const m = measureHorizontalLineYError(img, {
            expectedCssY: hl.expectedCssY,
            paneWidthCss: res.paneW,
            targetRgb: rgb,
            dpr: 2
          });
          if (m) {
            checkedLines++;
            if (m.medianErrCss > maxLineErr) maxLineErr = m.medianErrCss;
            assert.ok(m.medianErrCss <= 0.5, `${sym} ${hl.type} line error ${m.medianErrCss}px > 0.5px`);
          }
        }
        assert.ok(checkedLines >= 1, `${sym}: must verify >= 1 horizontal line on exported PNG`);

        let maxAnchorX = 0;
        let maxAnchorY = 0;
        let checkedAnchors = 0;
        for (const a of res.anchors) {
          const rgb = a.kind === 'trendline' ? PALETTE_RGB.trendline : PALETTE_RGB.pattern;
          const m = measureAnchorDotXYError(img, {
            expectedCssX: a.expectedCssX,
            expectedCssY: a.expectedCssY,
            targetRgb: rgb,
            dpr: 2
          });
          if (m) {
            checkedAnchors++;
            if (m.errXCss > maxAnchorX) maxAnchorX = m.errXCss;
            if (m.errYCss > maxAnchorY) maxAnchorY = m.errYCss;
            assert.ok(m.errXCss <= 0.5, `${sym} anchor X error ${m.errXCss}px > 0.5px`);
            assert.ok(m.errYCss <= 0.5, `${sym} anchor Y error ${m.errYCss}px > 0.5px`);
          }
        }
        assert.ok(checkedAnchors >= 1, `${sym}: must verify >= 1 2D anchor (X & Y) on exported PNG`);

        // Sabotage check on RELIANCE.NS: shifting expected Y by +4px must trigger > 0.5px failure
        if (sym === 'RELIANCE.NS' && res.hLines.length) {
          const sab = measureHorizontalLineYError(img, {
            expectedCssY: res.hLines[0].expectedCssY + 4,
            paneWidthCss: res.paneW,
            targetRgb: res.hLines[0].type === 'support' ? PALETTE_RGB.support : PALETTE_RGB.resistance,
            dpr: 2
          });
          assert.ok(!sab || sab.medianErrCss > 0.5, 'Sabotage (+4px header shift) must be caught by exported PNG alignment check');
          summary.sabotageCaught = true;
        }

        summary.exports[sym] = {
          width: img.width,
          height: img.height,
          checkedLines,
          maxLineErr: Number(maxLineErr.toFixed(3)),
          checkedAnchors,
          maxAnchorX: Number(maxAnchorX.toFixed(3)),
          maxAnchorY: Number(maxAnchorY.toFixed(3))
        };
      }

      assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
      assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);
      return summary;
    });
  } finally {
    await srv.close();
  }
}

module.exports = { runM5BrowserTest };
