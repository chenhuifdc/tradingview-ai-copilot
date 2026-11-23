import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSymbolList, runBatchPipeline } from '../public/js/batchRunner.js';
import { buildZipArchive } from '../public/js/zipBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'india-daily-klines.json');
const FIXTURE_DATA = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

test('M7.1: parseSymbolList deduplicates and normalizes whitespace/comma/semicolon lists', () => {
  const list = parseSymbolList('reliance.ns, TCS.NS;\nhdfcbank.ns RELIANCE.NS');
  assert.deepEqual(list, ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS']);
});

test('M7.2: runBatchPipeline processes 5+ stocks with partial failure isolation, simulated skip, manifest completeness, resume, and valid ZIP output', async () => {
  let failTransientOnce = true;
  const symbols = [
    'RELIANCE.NS',
    'TCS.NS',
    'HDFCBANK.NS',
    'SUNPHARMA.NS',
    'ITC.NS',
    'SIMONLY.NS',
    'TRANSIENT.NS'
  ];

  const fetchMarketFn = async (sym, interval) => {
    if (sym === 'TRANSIENT.NS' && failTransientOnce) {
      failTransientOnce = false;
      throw new Error('Upstream temporary 503');
    }
    const baseSym = FIXTURE_DATA.fixtures[sym] ? sym : 'RELIANCE.NS';
    const stock = FIXTURE_DATA.fixtures[baseSym];
    const isSim = sym === 'SIMONLY.NS';
    const resolved = sym === 'ITC.NS' ? 'ITC.BO' : sym;
    const exchange = sym === 'ITC.NS' ? 'BSE' : 'NSE';
    return {
      kData: {
        symbol: sym,
        interval,
        source: isSim ? 'simulated' : 'live',
        instrument: {
          symbol: sym,
          displaySymbol: sym.replace(/\.(NS|BO)$/, ''),
          name: stock.name,
          exchange,
          market: 'in'
        },
        candles: stock.candles,
        meta: {
          source: isSim ? 'simulated' : 'live',
          stale: false,
          provider: isSim ? 'simulated' : 'yahoo:query1',
          latestBarTime: stock.candles[stock.candles.length - 1].time,
          latestTradingDay: '2026-03-20',
          resolvedSymbol: resolved,
          exchange,
          exchangeFallback: sym === 'ITC.NS'
        }
      },
      fundamentals: {
        sector: 'Test Sector',
        industry: 'Test Industry',
        headlines: [{ title: 'Steady domestic demand', pubDate: '2026-03-20' }]
      }
    };
  };

  let fetchedOnResume = [];
  const firstRun = await runBatchPipeline({
    symbols,
    config: { concurrency: 2, delayBetweenMs: 0, allowSimulated: false, interval: '1d' },
    fetchMarketFn,
    renderAndExportFn: async ({ symbol }) => `data:image/png;base64,${Buffer.from(`PNG_${symbol}`).toString('base64')}`,
    sleepFn: async () => {}
  });

  // Verify summary: 5 succeeded, 1 skipped_simulated, 1 failed (TRANSIENT.NS)
  assert.equal(firstRun.manifest.summary.total, 7);
  assert.equal(firstRun.manifest.summary.success, 5);
  assert.equal(firstRun.manifest.summary.skippedSimulated, 1);
  assert.equal(firstRun.manifest.summary.failed, 1);

  const itcItem = firstRun.manifest.items.find((i) => i.symbol === 'ITC.NS');
  assert.equal(itcItem.resolvedSymbol, 'ITC.BO');
  assert.equal(itcItem.exchange, 'BSE');
  assert.ok(itcItem.selectedSupportId);
  assert.ok(itcItem.selectedResistanceId);
  assert.ok(itcItem.files.png && itcItem.files.text);

  const simItem = firstRun.manifest.items.find((i) => i.symbol === 'SIMONLY.NS');
  assert.equal(simItem.status, 'skipped_simulated');
  assert.equal(simItem.failureReason, 'SIMULATED_DATA_SKIPPED');

  // Verify ZIP signature (PK\x03\x04) and EOCD (PK\x05\x06) and manifest.json entry
  assert.equal(firstRun.zipBytes[0], 0x50);
  assert.equal(firstRun.zipBytes[1], 0x4b);
  assert.equal(firstRun.zipBytes[2], 0x03);
  assert.equal(firstRun.zipBytes[3], 0x04);
  assert.ok(firstRun.zipEntries.some((e) => e.name === 'manifest.json'));
  assert.ok(firstRun.zipEntries.some((e) => e.name === 'ITC.BO.png'));
  assert.ok(firstRun.zipEntries.some((e) => e.name === 'ITC.BO.txt'));

  // Resume from checkpoint -> must skip the 5 succeeded symbols and succeed on TRANSIENT.NS
  const resumedRun = await runBatchPipeline({
    symbols,
    config: { concurrency: 1, delayBetweenMs: 0, allowSimulated: false, interval: '1d' },
    resumeManifest: firstRun.manifest,
    fetchMarketFn: async (sym, iv) => {
      fetchedOnResume.push(sym);
      return fetchMarketFn(sym, iv);
    },
    renderAndExportFn: async ({ symbol }) => `data:image/png;base64,${Buffer.from(`PNG_${symbol}`).toString('base64')}`,
    sleepFn: async () => {}
  });

  assert.equal(fetchedOnResume.includes('RELIANCE.NS'), false, 'Resume must skip already succeeded symbols');
  assert.equal(fetchedOnResume.includes('TRANSIENT.NS'), true, 'Resume must retry previously failed symbol');
  assert.equal(resumedRun.manifest.summary.success, 6);
  assert.equal(resumedRun.manifest.summary.skippedSimulated, 1);
  assert.equal(resumedRun.manifest.summary.failed, 0);
});

test('M7.3: buildZipArchive produces valid PKZIP local headers and End-of-Central-Directory record', () => {
  const bytes = buildZipArchive([
    { name: 'hello.txt', data: 'world' },
    { name: 'manifest.json', data: '{"ok":true}' }
  ]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  // EOCD starts at bytes.length - 22
  const eocdPos = bytes.length - 22;
  assert.equal(bytes[eocdPos], 0x50);
  assert.equal(bytes[eocdPos + 1], 0x4b);
  assert.equal(bytes[eocdPos + 2], 0x05);
  assert.equal(bytes[eocdPos + 3], 0x06);
});
