const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

test('M1.1 normalizeLwcTime: handles Unix seconds, milliseconds, ISO strings, Date, BusinessDay and invalid inputs', async () => {
  const { normalizeLwcTime } = await import('../public/js/lwcAdapter.js');

  const sec = 1711008000;
  assert.equal(normalizeLwcTime(sec), sec);
  assert.equal(normalizeLwcTime(sec * 1000), sec, 'Milliseconds must be converted to Unix seconds');
  assert.equal(normalizeLwcTime('2024-03-21T08:00:00Z'), sec, 'ISO datetime string must parse cleanly');
  assert.equal(normalizeLwcTime('2024-03-21'), Math.floor(Date.UTC(2024, 2, 21) / 1000), 'Date-only string must map to UTC midnight');
  assert.equal(normalizeLwcTime(new Date(sec * 1000)), sec, 'Date instance must convert to Unix seconds');
  assert.equal(
    normalizeLwcTime({ year: 2024, month: 3, day: 21 }),
    Math.floor(Date.UTC(2024, 2, 21) / 1000),
    'BusinessDay object must convert to UTC midnight seconds'
  );
  assert.equal(normalizeLwcTime(String(sec)), sec, 'Numeric string must convert to seconds');

  for (const invalid of [null, undefined, '', 'not-a-date', 0, -100, Number.NaN, {}]) {
    assert.equal(normalizeLwcTime(invalid), null, `Invalid input ${JSON.stringify(invalid)} must return null`);
  }
});

test('M1.2 normalizeAndSortCandles & toLwcCandlestickData: sorts out-of-order bars, deduplicates timestamps, and filters invalid entries', async () => {
  const { normalizeAndSortCandles, toLwcCandlestickData } = await import('../public/js/lwcAdapter.js');

  const rawCandles = [
    { time: 1711065600, open: 2910, high: 2930, low: 2900, close: 2925, volume: 1200 },
    { time: 1710979200, open: 2890, high: 2915, low: 2880, close: 2910, volume: 1000 },
    // Duplicate timestamp -> latest entry wins
    { time: 1710979200, open: 2895, high: 2920, low: 2885, close: 2912, volume: 1100 },
    // Invalid NaN close -> filtered out
    { time: 1711152000, open: 2925, high: 2940, low: 2910, close: Number.NaN, volume: 900 },
    // Invalid null entry -> filtered out
    null
  ];

  const normalized = normalizeAndSortCandles(rawCandles, {
    interval: '1d',
    timeZone: 'Asia/Kolkata'
  });
  assert.equal(normalized.length, 2, 'Duplicate and invalid bars must be deduplicated/filtered');
  assert.ok(normalized[0].time < normalized[1].time, 'Candles must be sorted strictly ascending');
  assert.equal(normalized[0].close, 2912, 'Latest duplicate entry should win');

  const lwcBars = toLwcCandlestickData(rawCandles, { interval: '1d', timeZone: 'Asia/Kolkata' });
  assert.equal(lwcBars.length, 2);
  assert.deepEqual(Object.keys(lwcBars[0]).sort(), ['close', 'high', 'low', 'open', 'time']);
  assert.ok(lwcBars[0].time < lwcBars[1].time);
  assert.equal(lwcBars[0].close, 2912);
});

test('M1.3 toLwcVolumeData: assigns bull/bear histogram colors matching candle close >= open', async () => {
  const { toLwcVolumeData } = await import('../public/js/lwcAdapter.js');

  const candles = [
    { time: 1710979200, open: 100, high: 110, low: 95, close: 108, volume: 1500 }, // bull (close > open)
    { time: 1711065600, open: 108, high: 112, low: 100, close: 102, volume: 2100 }, // bear (close < open)
    { time: 1711152000, open: 102, high: 105, low: 99, close: 102, volume: 900 } // doji (close === open -> bull)
  ];

  const vol = toLwcVolumeData(candles, { upColor: '#00AA00', downColor: '#DD0000' });
  assert.equal(vol.length, 3);
  assert.equal(vol[0].value, 1500);
  assert.equal(vol[0].color, '#00AA00');
  assert.equal(vol[1].value, 2100);
  assert.equal(vol[1].color, '#DD0000');
  assert.equal(vol[2].value, 900);
  assert.equal(vol[2].color, '#00AA00');
});

test('M1.4 toLwcLineData, toLwcBollingerData & toLwcMacdData: converts EMA, Bollinger Bands and 4-color MACD series accurately', async () => {
  const { toLwcLineData, toLwcBollingerData, toLwcMacdData } = await import('../public/js/lwcAdapter.js');
  const { calcEMA, calcBollinger, calcMACD } = await import('../public/js/indicators.js');

  const candles = Array.from({ length: 45 }, (_, i) => ({
    time: 1710000000 + i * 86400,
    open: 2800 + Math.sin(i / 4) * 60,
    high: 2825 + Math.sin(i / 4) * 60,
    low: 2775 + Math.sin(i / 4) * 60,
    close: 2805 + Math.sin(i / 4) * 60,
    volume: 100000 + i * 1000
  }));

  const ema20Vals = calcEMA(candles.map((c) => c.close), 20);
  const ema20 = toLwcLineData(candles, ema20Vals);
  assert.ok(ema20.length > 20);
  assert.equal(ema20[ema20.length - 1].time, candles[candles.length - 1].time);

  const bollRaw = calcBollinger(candles, 20, 2);
  const bb = toLwcBollingerData(candles, bollRaw);
  assert.ok(bb.upper.length > 0);
  assert.equal(bb.upper.length, bb.middle.length);
  assert.equal(bb.upper.length, bb.lower.length);

  // Real MACD (10,21,9) conversion
  const macdRaw = calcMACD(candles, 10, 21, 9);
  const macdData = toLwcMacdData(candles, macdRaw);
  assert.ok(macdData.macdLine.length > 0);
  assert.ok(macdData.signalLine.length > 0);
  assert.ok(macdData.histogram.length > 0);
  assert.equal(macdData.macdLine[macdData.macdLine.length - 1].time, candles[candles.length - 1].time);

  // Explicit 4-color MACD histogram state transitions: upStrong, upWeak, downStrong, downWeak
  const palette = {
    histUpStrong: '#11AA11',
    histUpWeak: '#88DD88',
    histDownStrong: '#CC1111',
    histDownWeak: '#FF9999'
  };
  const syntheticCandles = [0, 1, 2, 3, 4].map((i) => ({
    time: 1710000000 + i * 86400,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 1000
  }));
  const syntheticMacd = {
    macd: [0.5, 1.0, 0.8, -0.5, -0.2],
    signal: [0.2, 0.3, 0.4, 0.1, 0.0],
    hist: [0.2, 0.7, 0.4, -0.8, -0.3] // +rising(upStrong), +rising(upStrong), +falling(upWeak), -falling(downStrong), -rising(downWeak)
  };
  const fourColor = toLwcMacdData(syntheticCandles, syntheticMacd, palette);
  assert.equal(fourColor.histogram.length, 5);
  assert.equal(fourColor.histogram[1].color, palette.histUpStrong, 'Positive growing hist must be histUpStrong');
  assert.equal(fourColor.histogram[2].color, palette.histUpWeak, 'Positive shrinking hist must be histUpWeak');
  assert.equal(fourColor.histogram[3].color, palette.histDownStrong, 'Negative deepening hist must be histDownStrong');
  assert.equal(fourColor.histogram[4].color, palette.histDownWeak, 'Negative recovering hist must be histDownWeak');
});

test('M1.5 toLwcRealtimeUpdate: formats single live candle tick for incremental series.update()', async () => {
  const { toLwcRealtimeUpdate } = await import('../public/js/lwcAdapter.js');

  const tick = {
    time: 1711008000 * 1000, // ms timestamp
    open: 1350.0,
    high: 1362.5,
    low: 1348.0,
    close: 1359.75,
    volume: 42500
  };
  const update = toLwcRealtimeUpdate(tick, { upColor: '#00AA00', downColor: '#DD0000' });
  assert.ok(update);
  assert.deepEqual(update.candleBar, {
    time: 1711008000,
    open: 1350,
    high: 1362.5,
    low: 1348,
    close: 1359.75
  });
  assert.deepEqual(update.volumeBar, {
    time: 1711008000,
    value: 42500,
    color: '#00AA00'
  });

  const bearUpdate = toLwcRealtimeUpdate(
    { time: 1711008060, open: 1360, high: 1362, low: 1351, close: 1352, volume: 12000 },
    { upColor: '#00AA00', downColor: '#DD0000' }
  );
  assert.equal(bearUpdate.volumeBar.color, '#DD0000');
  assert.equal(toLwcRealtimeUpdate({ time: null, open: Number.NaN }), null);
});

test('M1.6 Exchange timezone formatting (IST & global markets) + daily candle date attribution', async () => {
  const adapter = await import('../public/js/lwcAdapter.js');

  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'in', symbol: 'RELIANCE.NS' } }).timeZone, 'Asia/Kolkata');
  assert.equal(adapter.resolveExchangeTimezone({ symbol: 'TCS.BO' }).timeZone, 'Asia/Kolkata');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'kr', symbol: '005930.KS' } }).timeZone, 'Asia/Seoul');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'hk', symbol: '0700.HK' } }).timeZone, 'Asia/Hong_Kong');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'us', symbol: 'NVDA' } }).timeZone, 'America/New_York');
  assert.equal(adapter.resolveExchangeTimezone({ instrument: { market: 'crypto', symbol: 'BTCUSDT' } }).timeZone, 'UTC');

  // 1) NSE market open: 09:15 IST = 03:45 UTC on 2026-03-20
  const nseOpenUtcSec = Math.floor(Date.parse('2026-03-20T03:45:00Z') / 1000);
  assert.equal(
    adapter.formatLwcCrosshairTime(nseOpenUtcSec, { interval: '15m', timeZone: 'Asia/Kolkata', tzAbbr: 'IST' }),
    '2026-03-20 09:15 IST'
  );
  assert.equal(
    adapter.formatLwcTickMark(nseOpenUtcSec, 3, { interval: '15m', timeZone: 'Asia/Kolkata' }),
    '09:15'
  );

  // 2) NSE market close: 15:30 IST = 10:00 UTC on 2026-03-20
  const nseCloseUtcSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);
  assert.equal(
    adapter.formatLwcCrosshairTime(nseCloseUtcSec, { interval: '15m', timeZone: 'Asia/Kolkata', tzAbbr: 'IST' }),
    '2026-03-20 15:30 IST'
  );
  assert.equal(
    adapter.formatLwcTickMark(nseCloseUtcSec, 2, { interval: '15m', timeZone: 'Asia/Kolkata' }),
    '03-20'
  );

  // 3) KRX market open: 09:00 KST = 00:00 UTC
  const krxOpenUtcSec = Math.floor(Date.parse('2026-03-20T00:00:00Z') / 1000);
  assert.equal(
    adapter.formatLwcCrosshairTime(krxOpenUtcSec, { interval: '15m', timeZone: 'Asia/Seoul', tzAbbr: 'KST' }),
    '2026-03-20 09:00 KST'
  );

  // 4) Daily bar date attribution across UTC midnight boundary:
  // 2026-03-19T18:30:00Z = 2026-03-20 00:00 IST -> must be attributed to 2026-03-20
  const nseMidnightIstSec = Math.floor(Date.parse('2026-03-19T18:30:00Z') / 1000);
  const canonicalDailySec = adapter.normalizeLwcTime(nseMidnightIstSec, {
    interval: '1d',
    timeZone: 'Asia/Kolkata'
  });
  assert.equal(new Date(canonicalDailySec * 1000).toISOString().slice(0, 10), '2026-03-20');
  assert.equal(
    adapter.formatLwcCrosshairTime(canonicalDailySec, { interval: '1d', timeZone: 'Asia/Kolkata' }),
    '2026-03-20'
  );
  assert.equal(
    adapter.formatLwcTickMark(canonicalDailySec, 2, { interval: '1d', timeZone: 'Asia/Kolkata' }),
    '03-20'
  );
});

test('M1.7 Vendor files & SHA-256 integrity check: verifies lightweight-charts v5.2.1 against CHECKSUMS.json and NOTICE', () => {
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
  assert.equal(actualSha256, fileRecord.sha256, 'Vendor bundle SHA-256 must match recorded npm release hash');
  assert.equal(lwcBuffer.length, fileRecord.bytes);

  const licenseBuffer = fs.readFileSync(licenseFile);
  const licenseSha256 = crypto.createHash('sha256').update(licenseBuffer).digest('hex');
  assert.equal(licenseSha256, checksums.files.LICENSE.sha256, 'LICENSE SHA-256 must match CHECKSUMS.json');

  const noticeText = fs.readFileSync(noticeFile, 'utf8');
  assert.equal(noticeText.includes(actualSha256), true, 'NOTICE must document the vendor SHA-256');
  assert.match(noticeText, /https:\/\/www\.tradingview\.com\//, 'TradingView attribution URL must be documented in NOTICE');

  const html = fs.readFileSync(htmlFile, 'utf8');
  const engineSrc = fs.readFileSync(engineFile, 'utf8');
  assert.match(html, /vendor\/lightweight-charts\.standalone\.production\.js/);
  assert.equal(/https?:\/\/.*lightweight-charts/.test(html), false, 'No external CDN allowed for LWC');
  assert.match(engineSrc, /attributionLogo:\s*true/, 'Lightweight Charts attributionLogo must be enabled');
});
