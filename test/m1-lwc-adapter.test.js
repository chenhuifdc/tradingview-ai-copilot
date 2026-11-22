const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

test('M1.1 Lightweight Charts vendor bundle, Apache-2.0 LICENSE, NOTICE, and SHA-256 CHECKSUMS integrity exist with zero external CDN dependencies', () => {
  const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
  const lwcFile = path.join(vendorDir, 'lightweight-charts.standalone.production.js');
  const licenseFile = path.join(vendorDir, 'LICENSE');
  const noticeFile = path.join(vendorDir, 'NOTICE');
  const checksumsFile = path.join(vendorDir, 'CHECKSUMS.json');
  const htmlFile = path.join(__dirname, '..', 'public', 'index.html');
  const engineFile = path.join(__dirname, '..', 'public', 'js', 'lwcChartEngine.js');

  assert.equal(fs.existsSync(lwcFile), true, 'lightweight-charts.standalone.production.js must exist');
  assert.equal(fs.existsSync(licenseFile), true, 'LICENSE must exist');
  assert.equal(fs.existsSync(noticeFile), true, 'NOTICE must exist');
  assert.equal(fs.existsSync(checksumsFile), true, 'CHECKSUMS.json must exist');

  const lwcBuffer = fs.readFileSync(lwcFile);
  assert.ok(lwcBuffer.length > 100_000, 'LWC bundle must be non-empty');

  const actualSha256 = crypto.createHash('sha256').update(lwcBuffer).digest('hex');
  const checksums = JSON.parse(fs.readFileSync(checksumsFile, 'utf8'));
  const fileRecord = checksums.files['lightweight-charts.standalone.production.js'];
  assert.equal(checksums.version, '5.2.1');
  assert.equal(
    actualSha256,
    fileRecord.sha256,
    'Vendor bundle SHA-256 must match recorded npm release hash'
  );
  assert.equal(lwcBuffer.length, fileRecord.bytes);

  const noticeText = fs.readFileSync(noticeFile, 'utf8');
  assert.equal(noticeText.includes(actualSha256), true, 'NOTICE must document the vendor SHA-256');

  const html = fs.readFileSync(htmlFile, 'utf8');
  const engineSrc = fs.readFileSync(engineFile, 'utf8');
  assert.match(html, /vendor\/lightweight-charts\.standalone\.production\.js/);
  assert.equal(/https?:\/\/.*lightweight-charts/.test(html), false, 'No external CDN allowed for LWC');
  assert.match(engineSrc, /attributionLogo:\s*true/, 'Lightweight Charts attributionLogo must be enabled');
  assert.match(noticeText, /https:\/\/www\.tradingview\.com\//, 'TradingView attribution URL must be documented in NOTICE');
});

test('M1.2 lwcAdapter normalizes timestamps, filters invalid OHLC, deduplicates, and sorts strictly ascending', async () => {
  const adapter = await import('../public/js/lwcAdapter.js');

  const rawCandles = [
    { time: 1711065600, open: 2910, high: 2930, low: 2900, close: 2925, volume: 1200 },
    { time: 1710979200, open: 2890, high: 2915, low: 2880, close: 2910, volume: 1000 },
    // Duplicate timestamp (should overwrite earlier entry for 1710979200)
    { time: 1710979200, open: 2895, high: 2920, low: 2885, close: 2912, volume: 1100 },
    // Invalid bar with NaN close (should be filtered out)
    { time: 1711152000, open: 2925, high: 2940, low: 2910, close: Number.NaN, volume: 900 }
  ];

  const normalized = adapter.normalizeAndSortCandles(rawCandles, {
    interval: '1d',
    timeZone: 'Asia/Kolkata'
  });
  assert.equal(normalized.length, 2, 'Duplicate and NaN bars must be deduplicated/removed');
  assert.ok(normalized[0].time < normalized[1].time, 'Candles must be strictly ascending');
  assert.equal(normalized[0].close, 2912, 'Latest duplicate entry should win');

  const lwcBars = adapter.toLwcCandlestickData(normalized);
  assert.equal(lwcBars.length, 2);
  assert.equal(typeof lwcBars[0].time, 'number');
  assert.ok(lwcBars[0].time < lwcBars[1].time);

  const volBars = adapter.toLwcVolumeData(normalized);
  assert.equal(volBars.length, 2);
  assert.equal(volBars[0].value, 1100);
  assert.ok(volBars[0].color.includes('8, 153, 129'));
});

test('M1.3 lwcAdapter builds EMA, Bollinger, and MACD (10,21,9) series aligned with candle timestamps', async () => {
  const adapter = await import('../public/js/lwcAdapter.js');
  const indicators = await import('../public/js/indicators.js');

  const candles = Array.from({ length: 40 }, (_, i) => ({
    time: 1710000000 + i * 86400,
    open: 2800 + i * 5,
    high: 2815 + i * 5 + (i % 5 === 0 ? 25 : 0),
    low: 2785 + i * 5 - (i % 7 === 0 ? 25 : 0),
    close: 2805 + i * 5,
    volume: 100000 + i * 1000
  }));

  const ema20Vals = indicators.calcEMA(candles.map((c) => c.close), 20);
  const ema20 = adapter.toLwcLineData(candles, ema20Vals);
  assert.ok(ema20.length > 15);
  assert.equal(ema20[ema20.length - 1].time, candles[candles.length - 1].time);

  const bollRaw = indicators.calcBollinger(candles, 20, 2);
  const bb = adapter.toLwcBollingerData(candles, bollRaw);
  assert.ok(bb.upper.length > 0);
  assert.equal(bb.upper.length, bb.middle.length);
  assert.equal(bb.upper.length, bb.lower.length);

  const macdRaw = indicators.calcMACD(candles, 10, 21, 9);
  const macdData = adapter.toLwcMacdData(candles, macdRaw);
  assert.ok(macdData.macdLine.length > 0);
  assert.ok(macdData.signalLine.length > 0);
  assert.ok(macdData.histogram.length > 0);
  assert.equal(
    macdData.macdLine[macdData.macdLine.length - 1].time,
    candles[candles.length - 1].time
  );
});

test('M1.4 Exchange timezone (IST Asia/Kolkata) formatting: intraday ticks, crosshair labels, and daily date attribution', async () => {
  const adapter = await import('../public/js/lwcAdapter.js');

  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'in', symbol: 'RELIANCE.NS' } }).timeZone, 'Asia/Kolkata');
  assert.equal(adapter.resolveExchangeTimezone({ symbol: 'TCS.BO' }).timeZone, 'Asia/Kolkata');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'kr', symbol: '005930.KS' } }).timeZone, 'Asia/Seoul');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'us', symbol: 'NVDA' } }).timeZone, 'America/New_York');

  // 1) Intraday market open in India: 09:15 IST = 03:45 UTC on 2026-03-20
  const nseOpenUtcSec = Math.floor(Date.parse('2026-03-20T03:45:00Z') / 1000);
  assert.equal(
    adapter.formatLwcCrosshairTime(nseOpenUtcSec, { interval: '15m', timeZone: 'Asia/Kolkata', tzAbbr: 'IST' }),
    '2026-03-20 09:15 IST'
  );
  assert.equal(
    adapter.formatLwcTickMark(nseOpenUtcSec, 3, { interval: '15m', timeZone: 'Asia/Kolkata' }),
    '09:15'
  );

  // 2) Intraday market close in India: 15:30 IST = 10:00 UTC on 2026-03-20
  const nseCloseUtcSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);
  assert.equal(
    adapter.formatLwcCrosshairTime(nseCloseUtcSec, { interval: '15m', timeZone: 'Asia/Kolkata', tzAbbr: 'IST' }),
    '2026-03-20 15:30 IST'
  );
  assert.equal(
    adapter.formatLwcTickMark(nseCloseUtcSec, 2, { interval: '15m', timeZone: 'Asia/Kolkata' }),
    '03-20'
  );

  // 3) Daily bar date attribution across UTC midnight boundary:
  // Yahoo Finance often timestamps NSE daily bars at 00:00 IST of the trading day,
  // which is 18:30 UTC of the PREVIOUS UTC calendar date (e.g., 2026-03-19T18:30:00Z = 2026-03-20 00:00 IST).
  const nseMidnightIstSec = Math.floor(Date.parse('2026-03-19T18:30:00Z') / 1000);
  const canonicalDailySec = adapter.normalizeLwcTime(nseMidnightIstSec, {
    interval: '1d',
    timeZone: 'Asia/Kolkata'
  });

  assert.equal(
    new Date(canonicalDailySec * 1000).toISOString().slice(0, 10),
    '2026-03-20',
    'Daily bar at 2026-03-19T18:30:00Z (00:00 IST Mar 20) must be attributed to 2026-03-20, not 2026-03-19'
  );
  assert.equal(
    adapter.formatLwcCrosshairTime(canonicalDailySec, { interval: '1d', timeZone: 'Asia/Kolkata' }),
    '2026-03-20'
  );
  assert.equal(
    adapter.formatLwcTickMark(canonicalDailySec, 2, { interval: '1d', timeZone: 'Asia/Kolkata' }),
    '03-20'
  );
});
