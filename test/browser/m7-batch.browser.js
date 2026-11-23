const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMockAppServer, withCdpPage } = require('./helpers');

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'india-daily-klines.json');

async function runM7BrowserTest(chromeBin) {
  const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

  const mockMarketService = {
    searchSymbols: async () => ({ remoteOnline: true, results: [] }),
    getKlines: async (symbol, interval) => {
      const isSim = symbol === 'SIMONLY.NS';
      const stock = fixtureRaw.fixtures[symbol] || fixtureRaw.fixtures['RELIANCE.NS'];
      const candles = stock.candles;
      const latestSec = candles[candles.length - 1].time;
      return {
        symbol,
        interval: interval || '1d',
        source: isSim ? 'simulated' : 'live',
        feedName: isSim ? 'Simulated' : 'NSE Fixture',
        instrument: {
          symbol,
          displaySymbol: symbol.replace(/\.(NS|BO)$/, ''),
          name: stock.name,
          enName: stock.enName || symbol.replace(/\.(NS|BO)$/, ''),
          exchange: 'NSE',
          market: 'in'
        },
        candles,
        meta: {
          source: isSim ? 'simulated' : 'live',
          stale: false,
          provider: isSim ? 'simulated' : 'yahoo:query1',
          latestBarTime: latestSec,
          latestTradingDay: '2026-03-20',
          exchangeTimezone: 'Asia/Kolkata',
          timezone: 'IST',
          requestedSymbol: symbol,
          resolvedSymbol: symbol,
          exchange: 'NSE',
          exchangeFallback: false
        }
      };
    },
    getLatestTick: async () => ({ source: 'live', candle: null }),
    getStockFundamentals: async (symbol) => ({
      symbol,
      sector: 'Energy',
      industry: 'Integrated',
      headlines: [{ title: 'Quarterly update steady', pubDate: '2026-03-20' }],
      meta: { source: 'live', stale: false }
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(chromeBin, srv.baseUrl, async ({ evaluate, consoleErrors, pageExceptions }) => {
      await evaluate(`(async () => {
        window.location.href = '/batch.html';
      })()`);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const ready = await evaluate(`Boolean(window.__batchApp && document.getElementById('batchSymbols'))`);
        if (ready) break;
      }
      const res = await evaluate(`(async () => {
        const app = window.__batchApp;
        document.getElementById('batchSymbols').value = [
          'RELIANCE.NS',
          'TCS.NS',
          'HDFCBANK.NS',
          'SUNPHARMA.NS',
          'ITC.NS',
          'SIMONLY.NS'
        ].join('\\n');
        document.getElementById('batchDelay').value = '0';
        const out = await app.runBatch({ resume: false });
        return {
          summary: out.manifest.summary,
          zipSize: out.zipBytes.length,
          zipMagic: [out.zipBytes[0], out.zipBytes[1], out.zipBytes[2], out.zipBytes[3]],
          zipEntryNames: out.zipEntries.map((e) => e.name),
          rowCount: document.querySelectorAll('#batchResultsBody tr').length,
          downloadEnabled: !document.getElementById('btnBatchDownloadZip').disabled,
          statusText: document.getElementById('batchStatusText').textContent
        };
      })()`);

      assert.equal(res.summary.total, 6);
      assert.equal(res.summary.success, 5);
      assert.equal(res.summary.skippedSimulated, 1);
      assert.equal(res.summary.failed, 0);
      assert.deepEqual(res.zipMagic, [0x50, 0x4b, 0x03, 0x04]);
      assert.ok(res.zipSize > 50000, `Expected non-trivial ZIP with 5 3200x1800 PNGs, got ${res.zipSize} bytes`);
      assert.ok(res.zipEntryNames.includes('manifest.json'));
      assert.ok(res.zipEntryNames.includes('RELIANCE.NS.png'));
      assert.ok(res.zipEntryNames.includes('RELIANCE.NS.txt'));
      assert.equal(res.rowCount, 6);
      assert.equal(res.downloadEnabled, true);
      assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
      assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);

      return res;
    });
  } finally {
    await srv.close();
  }
}

module.exports = { runM7BrowserTest };
