const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMockAppServer, makeMockCandles, withCdpPage } = require('./helpers');

async function runM1BrowserTest(chromeBin) {
  const dailyCandles = makeMockCandles({
    count: 120,
    endSec: Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000),
    stepSec: 86400
  });
  const intraday15mCandles = makeMockCandles({
    count: 90,
    endSec: Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000), // 15:30 IST
    stepSec: 900
  });

  const mockMarketService = {
    searchSymbols: async () => ({ results: [], remoteOnline: true }),
    getKlines: async (symbol, interval) => {
      const isSim = symbol.includes('SIM');
      const candles = interval === '15m' ? intraday15mCandles : dailyCandles;
      const lastSec = candles[candles.length - 1].time;
      return {
        symbol,
        interval,
        source: isSim ? 'simulated' : 'live',
        feedName: isSim ? 'Simulated Demo' : 'Yahoo Finance Real-Time (yahoo:query1)',
        instrument: {
          symbol,
          displaySymbol: symbol.replace(/\.(NS|BO)$/i, ''),
          name: '信实工业',
          enName: 'Reliance Industries Ltd',
          exchange: 'NSE',
          market: 'in',
          currency: 'INR'
        },
        candles,
        events: [],
        meta: {
          source: isSim ? 'simulated' : 'live',
          fetchedAt: lastSec * 1000,
          ageMs: 0,
          stale: false,
          provider: isSim ? 'simulated' : 'yahoo:query1',
          priceBasis: 'split_adjusted_raw_ohlc',
          latestBarTime: lastSec,
          exchangeTimezone: 'Asia/Kolkata',
          timezone: 'IST',
          utcOffset: '+05:30',
          latestTradingDay: '2026-03-20',
          resolvedSymbol: symbol,
          exchange: 'NSE',
          exchangeFallback: false
        }
      };
    },
    getLatestTick: async (symbol, interval) => {
      const candles = interval === '15m' ? intraday15mCandles : dailyCandles;
      const last = candles[candles.length - 1];
      return {
        symbol,
        interval,
        source: 'live',
        candle: last,
        prevClose: candles[candles.length - 2].close,
        meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: last.time, exchange: 'NSE' }
      };
    },
    getStockFundamentals: async (symbol) => ({
      symbol,
      headlines: [],
      meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: dailyCandles[dailyCandles.length - 1].time, exchange: 'NSE' }
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(
      chromeBin,
      srv.baseUrl,
      async ({ sendCdp, evaluate, consoleErrors, pageExceptions }) => {
        const res = await evaluate(`(async () => {
          const app = window.__chartCopilot;

          // Enable Bollinger Bands via real checkbox change event
          const bollCb = document.querySelector('[data-indicator-toggle="boll"]');
          if (bollCb && !bollCb.checked) {
            bollCb.checked = true;
            bollCb.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise((r) => setTimeout(r, 250));

          const c = app.chart;
          const attrLink = document.querySelector('#lwcChartContainer a[href*="tradingview.com"]');

          // Check real chart's localization.timeFormatter on daily bar across UTC midnight (18:30Z -> next IST date)
          const dailyCrosshair = c.lwcChart
            .options()
            .localization.timeFormatter(Math.floor(Date.parse('2026-03-19T18:30:00Z') / 1000));

          const dailySummary = {
            lwcVersion: window.LightweightCharts?.version ? window.LightweightCharts.version() : null,
            candleCount: c.candleSeries ? c.candleSeries.data().length : 0,
            volumeCount: c.volumeSeries ? c.volumeSeries.data().length : 0,
            emaSeriesCount: c.emaSeriesMap ? c.emaSeriesMap.size : 0,
            bollUpperCount: c.bollUpperSeries ? c.bollUpperSeries.data().length : 0,
            paneCount: c.lwcChart ? c.lwcChart.panes().length : 0,
            macdHistCount: c.macdHistSeries ? c.macdHistSeries.data().length : 0,
            macdLineCount: c.macdLineSeries ? c.macdLineSeries.data().length : 0,
            macdSignalCount: c.macdSignalSeries ? c.macdSignalSeries.data().length : 0,
            hasAttributionLink: Boolean(attrLink),
            attributionHref: attrLink ? attrLink.getAttribute('href') : null,
            dailyCrosshair
          };

          // Switch to 15m intraday via real app.loadSymbol and verify chart's live IST formatters
          await app.loadSymbol('RELIANCE.NS', '15m');
          await new Promise((r) => setTimeout(r, 200));
          const nseOpenSec = Math.floor(Date.parse('2026-03-20T03:45:00Z') / 1000); // 09:15 IST
          const istCrosshair = c.lwcChart.options().localization.timeFormatter(nseOpenSec);
          const istTick = c.lwcChart.timeScale().options().tickMarkFormatter(nseOpenSec, 3);

          // Switch to SIMULATED via real app.loadSymbol and verify watermark z-index sits above LWC container
          await app.loadSymbol('SIM.NS', '1d');
          await new Promise((r) => setTimeout(r, 200));
          const wm = document.getElementById('simulatedWatermark');
          const lwcEl = document.getElementById('lwcChartContainer');
          const wmZ = Number(getComputedStyle(wm).zIndex) || 0;
          const lwcZ = Number(getComputedStyle(lwcEl).zIndex) || 0;

          return {
            ...dailySummary,
            istCrosshair,
            istTick,
            watermarkVisibleOnSim: !wm.hidden && wm.dataset.watermarkVisible === 'true',
            watermarkZAboveChart: wmZ > lwcZ
          };
        })()`);

        if (process.env.SCREENSHOT_DIR) {
          const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
          if (shot && shot.data) {
            fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
            const outPath = path.join(process.env.SCREENSHOT_DIR, 'm1_lwc_chart.png');
            fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
            res.screenshotPath = outPath;
          }
        }

        assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
        assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);
        assert.equal(res.lwcVersion, '5.2.1', 'LightweightCharts version must be 5.2.1');
        assert.equal(res.candleCount, 120, 'CandlestickSeries must contain all 120 bars');
        assert.equal(res.volumeCount, 120, 'Volume HistogramSeries must match candle count');
        assert.equal(res.emaSeriesCount, 3, 'Default EMA (5,10,20) series count must be 3');
        assert.ok(res.bollUpperCount > 30, 'Bollinger upper LineSeries must be populated');
        assert.equal(res.paneCount, 2, 'Chart must render 2 panes (main K-line + secondary MACD)');
        assert.ok(res.macdHistCount > 20, 'MACD histogram series must have data');
        assert.ok(res.macdLineCount > 20, 'MACD DIF series must have data');
        assert.ok(res.macdSignalCount > 20, 'MACD DEA series must have data');
        assert.equal(res.hasAttributionLink, true, 'TradingView attribution link must be present');
        assert.match(res.attributionHref || '', /tradingview\.com/);
        assert.equal(res.dailyCrosshair, '2026-03-20', 'Daily bar at 18:30Z must map to 2026-03-20 IST');
        assert.equal(res.istCrosshair, '2026-03-20 09:15 IST', 'Intraday crosshair must render IST time');
        assert.equal(res.istTick, '09:15', 'Intraday tick mark must render IST time');
        assert.equal(res.watermarkVisibleOnSim, true, 'Watermark must appear on simulated load');
        assert.equal(res.watermarkZAboveChart, true, 'Watermark z-index must be above LWC chart container');
        return res;
      },
      { width: 1600, height: 900, deviceScaleFactor: 2 }
    );
  } finally {
    await srv.close();
  }
}

module.exports = { runM1BrowserTest };
