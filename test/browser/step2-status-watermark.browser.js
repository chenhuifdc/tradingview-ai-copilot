const assert = require('node:assert/strict');
const { startMockAppServer, makeMockCandles, withCdpPage } = require('./helpers');

async function runStep2BrowserTest(chromeBin) {
  const mockCandles = makeMockCandles({ count: 120 });
  const nowSec = mockCandles[mockCandles.length - 1].time; // 2026-03-20T10:00:00Z = 15:30 IST

  let currentMode = 'live';
  const buildMeta = (mode, symbol) => {
    if (mode === 'bse') {
      return {
        source: 'live',
        fetchedAt: nowSec * 1000,
        ageMs: 0,
        stale: false,
        provider: 'yahoo:query1',
        priceBasis: 'split_adjusted_raw_ohlc',
        latestBarTime: nowSec,
        exchangeTimezone: 'Asia/Kolkata',
        timezone: 'IST',
        utcOffset: '+05:30',
        latestTradingDay: '2026-03-20',
        resolvedSymbol: symbol.replace(/\.NS$/i, '.BO'),
        exchange: 'BSE',
        exchangeFallback: true
      };
    }
    if (mode === 'cache') {
      return {
        source: 'cache',
        fetchedAt: nowSec * 1000 - 185000,
        ageMs: 185000, // 3分5秒
        stale: true,
        provider: 'yahoo:query2',
        priceBasis: 'split_adjusted_raw_ohlc',
        latestBarTime: nowSec,
        exchangeTimezone: 'Asia/Kolkata',
        timezone: 'IST',
        utcOffset: '+05:30',
        latestTradingDay: '2026-03-20',
        resolvedSymbol: symbol,
        exchange: 'NSE',
        exchangeFallback: false
      };
    }
    if (mode === 'simulated') {
      return {
        source: 'simulated',
        fetchedAt: nowSec * 1000,
        ageMs: 0,
        stale: false,
        provider: 'simulated',
        priceBasis: 'split_adjusted_raw_ohlc',
        latestBarTime: nowSec,
        exchangeTimezone: 'Asia/Kolkata',
        timezone: 'IST',
        utcOffset: '+05:30',
        latestTradingDay: '2026-03-20',
        resolvedSymbol: symbol,
        exchange: 'NSE',
        exchangeFallback: false
      };
    }
    return {
      source: 'live',
      fetchedAt: nowSec * 1000,
      ageMs: 0,
      stale: false,
      provider: 'yahoo:query1',
      priceBasis: 'split_adjusted_raw_ohlc',
      latestBarTime: nowSec,
      exchangeTimezone: 'Asia/Kolkata',
      timezone: 'IST',
      utcOffset: '+05:30',
      latestTradingDay: '2026-03-20',
      resolvedSymbol: symbol,
      exchange: 'NSE',
      exchangeFallback: false
    };
  };

  const mockMarketService = {
    searchSymbols: async () => ({ results: [], remoteOnline: true }),
    getKlines: async (symbol, interval) => {
      if (symbol.includes('BSEFALLBACK')) currentMode = 'bse';
      else if (symbol.includes('CACHE')) currentMode = 'cache';
      else if (symbol.includes('SIM')) currentMode = 'simulated';
      else currentMode = 'live';
      const meta = buildMeta(currentMode, symbol);
      return {
        symbol: meta.resolvedSymbol,
        interval,
        source: meta.source,
        feedName: `Mock (${meta.provider})`,
        instrument: {
          symbol: meta.resolvedSymbol,
          displaySymbol: meta.resolvedSymbol.replace(/\.(NS|BO)$/i, ''),
          name: '印度测试股',
          enName: 'India Test Equity',
          exchange: meta.exchange,
          market: 'in',
          currency: 'INR'
        },
        candles: mockCandles,
        events: [],
        meta
      };
    },
    getLatestTick: async (symbol, interval) => {
      const meta = buildMeta(currentMode, symbol);
      return {
        symbol: meta.resolvedSymbol,
        interval,
        source: meta.source,
        candle: mockCandles[mockCandles.length - 1],
        prevClose: mockCandles[mockCandles.length - 2].close,
        meta
      };
    },
    getStockFundamentals: async (symbol) => ({
      symbol,
      headlines: [{ title: 'Q4 Earnings Beat', pubDate: '2026-03-20' }],
      meta: buildMeta(currentMode, symbol)
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(chromeBin, srv.baseUrl, async ({ evaluate, consoleErrors, pageExceptions }) => {
      const res = await evaluate(`(async () => {
        const app = window.__chartCopilot;
        const snap = () => {
          const badge = document.getElementById('liveStatusBadge');
          const hud = document.getElementById('hudDataStatusBadge');
          const wm = document.getElementById('simulatedWatermark');
          const banner = document.getElementById('demoModeBanner');
          const lwc = document.getElementById('lwcChartContainer');
          const wmRect = wm ? wm.getBoundingClientRect() : null;
          return {
            feedStatus: badge?.dataset.feedStatus,
            feedStale: badge?.dataset.feedStale,
            badgeText: document.getElementById('liveStatusText')?.textContent || '',
            hudText: hud?.textContent || '',
            watermarkHidden: Boolean(wm?.hidden),
            watermarkVisibleAttr: wm?.dataset.watermarkVisible,
            watermarkWidth: Math.round(wmRect?.width || 0),
            watermarkHeight: Math.round(wmRect?.height || 0),
            watermarkZAboveChart:
              (Number(getComputedStyle(wm).zIndex) || 0) > (Number(getComputedStyle(lwc).zIndex) || 0),
            demoBannerHidden: Boolean(banner?.hidden)
          };
        };

        // 1) NSE -> BSE fallback real loadSymbol
        await app.loadSymbol('BSEFALLBACK.NS', '1d');
        const bseState = snap();

        // 2) Stale cache real loadSymbol + AI report header check
        await app.loadSymbol('CACHE.NS', '1d');
        const cacheState = snap();
        await app.copilot.ask('分析陈旧缓存状态');
        const cacheReports = Array.from(document.querySelectorAll('.strict-report-body')).map((e) => e.textContent);
        const latestCacheReport = cacheReports[cacheReports.length - 1] || '';

        // 3) Simulated real loadSymbol: default Demo Mode OFF -> blocks AI analysis
        await app.loadSymbol('SIM.NS', '1d');
        const simState = snap();
        const countBeforeBlocked = document.querySelectorAll('.strict-report-body').length;
        const blockedRes = await app.copilot.ask('模拟态默认禁止分析');
        const countAfterBlocked = document.querySelectorAll('.strict-report-body').length;

        // 4) Toggle real #chkDemoMode checkbox ON -> AI runs, UI card shows sim banner, copyable text stays clean
        const chk = document.getElementById('chkDemoMode');
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
        await app.copilot.ask('演示模式允许分析');
        const simReports = Array.from(document.querySelectorAll('.strict-report-body')).map((e) => e.textContent);
        const latestSimReport = simReports[simReports.length - 1] || '';
        const hasSimBannerOnCard = Boolean(document.querySelector('.ai-notice-sim'));

        return {
          bseState,
          cacheState,
          cacheReportHasNotice: latestCacheReport.startsWith('【数据状态提示：当前基于已陈旧缓存数据'),
          simState,
          blockedWhenDemoOff: Boolean(blockedRes?.blocked && blockedRes?.reason === 'simulated'),
          noReportWhenBlocked: countAfterBlocked === countBeforeBlocked,
          hasSimBannerOnCard,
          simReportNonEmpty: latestSimReport.length > 20,
          reportTextCleanOfSimDisclaimer: !/基于模拟数据|仅供演示/.test(latestSimReport)
        };
      })()`);

      assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
      assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);

      assert.match(res.bseState.badgeText, /BSE\(回退\)/);
      assert.match(res.bseState.hudText, /BSE\(回退\)/);
      assert.equal(res.bseState.watermarkHidden, true);

      assert.match(res.cacheState.badgeText, /缓存\(陈旧\)/);
      assert.equal(res.cacheState.feedStale, 'true');
      assert.equal(res.cacheState.watermarkHidden, true);
      assert.equal(res.cacheReportHasNotice, true);

      assert.equal(res.simState.feedStatus, 'simulated');
      assert.equal(res.simState.watermarkHidden, false, 'Simulated watermark must be visible');
      assert.equal(res.simState.watermarkVisibleAttr, 'true');
      assert.ok(res.simState.watermarkWidth > 100 && res.simState.watermarkHeight > 20, 'Watermark must have non-zero rendered box');
      assert.equal(res.simState.watermarkZAboveChart, true, 'Simulated watermark z-index must sit above LWC chart container');
      assert.equal(res.simState.demoBannerHidden, false, 'Demo mode banner must be visible in simulated state');
      assert.equal(res.blockedWhenDemoOff, true, 'Simulated mode must block AI analysis when Demo Mode is OFF');
      assert.equal(res.noReportWhenBlocked, true);
      assert.equal(res.hasSimBannerOnCard, true, 'Demo mode card must show sim notice banner');
      assert.equal(res.simReportNonEmpty, true);
      assert.equal(res.reportTextCleanOfSimDisclaimer, true, 'Demo disclaimer must NOT leak into copyable report text');
      return res;
    });
  } finally {
    await srv.close();
  }
}

module.exports = { runStep2BrowserTest };
