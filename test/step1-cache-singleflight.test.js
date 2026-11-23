const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAppServer } = require('../server');
const {
  LruTtlCache,
  SingleFlightGroup,
  CoalescingLruCache
} = require('../server/cache');

const {
  createMarketService,
  normalizeSymbol,
  normalizeInterval,
  normalizeRange,
  buildMarketCacheKey,
  PRICE_BASIS
} = require('../server/marketService');

function makeYahooPayload(symbol = 'RELIANCE.NS', count = 10, baseTs = 1710892800) {
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  const adjclose = [];

  for (let i = 0; i < count; i++) {
    timestamp.push(baseTs + i * 86400);
    open.push(2800 + i * 10);
    high.push(2825 + i * 10);
    low.push(2790 + i * 10);
    close.push(2815 + i * 10);
    volume.push(1000000 + i * 5000);
    // Intentionally different dividend-adjusted close to prove we use split-adjusted raw quote[0]
    adjclose.push(2700 + i * 10);
  }

  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'INR',
            symbol,
            exchangeName: symbol.endsWith('.BO') ? 'BSE' : 'NSI'
          },
          timestamp,
          indicators: {
            quote: [{ open, high, low, close, volume }],
            adjclose: [{ adjclose }]
          }
        }
      ],
      error: null
    }
  };
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('LruTtlCache supports cache hits, TTL expiration, and explicit expired pruning', () => {
  let now = 100_000;
  const cache = new LruTtlCache({ maxEntries: 5, defaultTtlMs: 5000, nowFn: () => now });

  cache.set('k1', { v: 1 }, 5000);
  cache.set('k2', { v: 2 }, 15000);
  assert.deepEqual(cache.get('k1'), { v: 1 });
  assert.equal(cache.size, 2);

  now += 6000;
  assert.equal(cache.get('k1'), undefined, 'Expired entry k1 must miss fresh get()');
  assert.deepEqual(cache.get('k2'), { v: 2 }, 'Unexpired entry k2 must still hit');

  const removed = cache.pruneExpired();
  assert.equal(removed, 1, 'Explicit pruneExpired must remove expired k1');
  assert.equal(cache.size, 1);
  assert.equal(cache.getEntry('k1', { allowStale: true, maxStaleMs: 60000 }), null);
});

test('LruTtlCache evicts least-recently-used entries when exceeding maxEntries and purges expired items first', () => {
  let now = 100_000;
  const cache = new LruTtlCache({ maxEntries: 3, defaultTtlMs: 5000, nowFn: () => now });

  cache.set('a', { v: 1 });
  cache.set('b', { v: 2 });
  cache.set('c', { v: 3 });
  assert.equal(cache.size, 3);

  // Access 'a' so 'b' becomes least-recently-used
  assert.deepEqual(cache.get('a'), { v: 1 });
  cache.set('d', { v: 4 });

  assert.equal(cache.size, 3);
  assert.equal(cache.get('b'), undefined, 'Least-recently-used key b must be evicted');
  assert.deepEqual(cache.get('a'), { v: 1 });
  assert.deepEqual(cache.get('c'), { v: 3 });
  assert.deepEqual(cache.get('d'), { v: 4 });

  // When an entry is expired (with no stale retention), capacity insertion must purge expired item before evicting fresh LRU items
  cache.set('short', { v: 99 }, 1000);
  now += 2000;
  // Now 'short' is expired, 'c' and 'd' are still fresh (created at 100_000, expires at 105_000)
  cache.set('e', { v: 5 }, 10000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('short'), undefined);
  assert.deepEqual(cache.get('e'), { v: 5 });
});

test('SingleFlightGroup coalesces N concurrent requests into 1 execution and isolates distinct keys', async () => {
  const sf = new SingleFlightGroup();
  let keyACount = 0;
  let keyBCount = 0;

  const taskA = () =>
    sf.do('klines::RELIANCE.NS::1d::5y', async () => {
      keyACount += 1;
      await new Promise((r) => setTimeout(r, 25));
      return { symbol: 'RELIANCE.NS', bars: 100 };
    });

  const taskB = () =>
    sf.do('klines::TCS.NS::1d::5y', async () => {
      keyBCount += 1;
      await new Promise((r) => setTimeout(r, 25));
      return { symbol: 'TCS.NS', bars: 200 };
    });

  const [resA, resB] = await Promise.all([
    Promise.all(Array.from({ length: 12 }, () => taskA())),
    Promise.all(Array.from({ length: 4 }, () => taskB()))
  ]);

  assert.equal(keyACount, 1, '12 concurrent calls for key A must trigger only 1 execution');
  assert.equal(keyBCount, 1, '4 concurrent calls for distinct key B must run independently');
  assert.equal(resA.filter((r) => r.shared).length, 11);
  assert.equal(resB.filter((r) => r.shared).length, 3);
  for (const r of resA) assert.deepEqual(r.value, { symbol: 'RELIANCE.NS', bars: 100 });
  for (const r of resB) assert.deepEqual(r.value, { symbol: 'TCS.NS', bars: 200 });
  assert.equal(sf.inFlightCount, 0);
});

test('SingleFlightGroup propagates failure to all waiters, cleans up in-flight state, and allows subsequent recovery', async () => {
  const sf = new SingleFlightGroup();
  let calls = 0;
  let shouldFail = true;

  const loader = () =>
    sf.do('shared-key', async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      if (shouldFail) throw new Error('upstream boom');
      return { ok: true, attempt: calls };
    });

  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => loader()));
  assert.equal(calls, 1);
  assert.equal(settled.every((s) => s.status === 'rejected' && /upstream boom/.test(s.reason.message)), true);
  assert.equal(sf.inFlightCount, 0, 'inFlight map must be cleared after rejection');

  shouldFail = false;
  const recovered = await loader();
  assert.equal(calls, 2);
  assert.deepEqual(recovered.value, { ok: true, attempt: 2 });
});

test('CoalescingLruCache does not cache rejected loader results and recovers on next call', async () => {
  let now = 1_000_000;
  const clc = new CoalescingLruCache({ maxEntries: 10, defaultTtlMs: 30_000, nowFn: () => now });
  let calls = 0;

  await assert.rejects(
    () =>
      Promise.all([
        clc.getOrLoad('k1', async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('loader failure');
        }),
        clc.getOrLoad('k1', async () => {
          calls += 1;
          throw new Error('should not execute second concurrent loader');
        })
      ]),
    /loader failure/
  );

  assert.equal(calls, 1);
  assert.equal(clc.size, 0, 'Rejected loader result must NOT be cached');
  assert.equal(clc.singleFlight.inFlightCount, 0);

  const ok = await clc.getOrLoad('k1', async () => {
    calls += 1;
    return { price: 1380 };
  }, 30_000);
  assert.equal(calls, 2);
  assert.equal(ok.fromCache, false);
  assert.deepEqual(ok.value, { price: 1380 });

  const cached = await clc.getOrLoad('k1', async () => {
    calls += 1;
    return { price: 9999 };
  }, 30_000);
  assert.equal(calls, 2);
  assert.equal(cached.fromCache, true);
  assert.deepEqual(cached.value, { price: 1380 });
});

test('Symbol, interval, range, and cache key normalization unify case and catalog aliases', () => {
  assert.equal(normalizeSymbol('  reliance.ns '), 'RELIANCE.NS');
  assert.equal(normalizeSymbol('reliance'), 'RELIANCE.NS');
  assert.equal(normalizeSymbol('btc/usdt'), 'BTCUSDT');
  assert.equal(normalizeSymbol('btc-usdt'), 'BTCUSDT');
  assert.equal(normalizeInterval(' 1D '), '1d');
  assert.equal(normalizeInterval('60m'), '1h');
  assert.equal(normalizeInterval('daily'), '1d');
  assert.equal(normalizeInterval('1wk'), '1w');
  assert.equal(normalizeInterval('invalid_tf'), '1d');
  assert.equal(normalizeRange('', '1d', { provider: 'yahoo', mode: 'klines' }), '5y');
  assert.equal(normalizeRange(' 2Y ', '1d', { provider: 'yahoo', mode: 'klines' }), '2y');
  assert.equal(normalizeRange('', '1d', { provider: 'yahoo', mode: 'quote' }), '1mo');

  const k1 = buildMarketCacheKey({ type: 'klines', symbol: 'reliance', interval: 'daily', range: '5y' });
  const k2 = buildMarketCacheKey({ type: 'klines', symbol: '  RELIANCE.NS ', interval: ' 1D ', range: '' });
  assert.equal(k1.key, k2.key);
  assert.equal(k1.key, 'klines::RELIANCE.NS::1d::5y');
});

test('marketService caches K-lines and quotes by normalized key, respects TTLs, and applies LRU eviction', async () => {
  let now = 1_711_000_000_000;
  let fetchCalls = 0;

  const svc = createMarketService({
    nowFn: () => now,
    cacheConfig: {
      maxEntries: { klines: 2, quotes: 2 },
      ttlMs: { klines: { '1d': 10_000 }, quote: { '1d': 5_000 } }
    },
    fetchFn: async (url) => {
      fetchCalls += 1;
      const sym = url.includes('TCS') ? 'TCS.NS' : url.includes('INFY') ? 'INFY.NS' : 'RELIANCE.NS';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload(sym, 8))
      };
    }
  });

  try {
    // 1) K-line cache hit & TTL expiration
    const kLive = await svc.getKlines('RELIANCE.NS', '1d');
    assert.equal(fetchCalls, 1);
    assert.equal(kLive.meta.source, 'live');
    assert.equal(kLive.cacheHit, false);

    const kCache = await svc.getKlines('  reliance ', 'daily');
    assert.equal(fetchCalls, 1, 'Alias must hit same K-line cache entry');
    assert.equal(kCache.cacheHit, true);
    assert.equal(kCache.meta.source, 'cache');

    // 2) Quote cache hit & TTL expiration
    const qLive = await svc.getLatestTick('RELIANCE.NS', '1d');
    assert.equal(fetchCalls, 2);
    assert.equal(qLive.meta.source, 'live');

    const qCache = await svc.getLatestTick('reliance', '1D');
    assert.equal(fetchCalls, 2, 'Quote alias must hit quote cache');
    assert.equal(qCache.cacheHit, true);
    assert.equal(qCache.meta.source, 'cache');

    // Advance past 5s quote TTL (still within 10s kline TTL)
    now += 6_000;
    const qRefreshed = await svc.getLatestTick('RELIANCE.NS', '1d');
    assert.equal(fetchCalls, 3, 'Quote must refresh after quote TTL expires');
    assert.equal(qRefreshed.meta.source, 'live');

    // 3) LRU eviction on maxEntries: 2
    await svc.getKlines('TCS.NS', '1d'); // cache now has [RELIANCE, TCS]
    assert.equal(fetchCalls, 4);
    await svc.getKlines('RELIANCE.NS', '1d'); // touch RELIANCE so TCS becomes LRU
    assert.equal(fetchCalls, 4);
    await svc.getKlines('INFY.NS', '1d'); // evicts TCS (maxEntries=2)
    assert.equal(fetchCalls, 5);
    assert.equal(svc.klineCache.size, 2);

    await svc.getKlines('TCS.NS', '1d'); // must re-fetch since evicted
    assert.equal(fetchCalls, 6);
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('marketService single-flight coalesces concurrent alias requests and propagates upstream failures without caching', async () => {
  let fetchCalls = 0;
  let shouldFail = false;

  const svc = createMarketService({
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      fetchCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      if (shouldFail) throw new Error('Upstream network reset');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 15))
      };
    }
  });

  try {
    // 10 concurrent alias variations -> strictly 1 upstream fetch
    const inputs = ['RELIANCE.NS', 'reliance.ns', '  RELIANCE ', 'reliance', 'RELIANCE.NS'];
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => svc.getKlines(inputs[idx % inputs.length], idx % 2 === 0 ? '1d' : 'daily'))
    );
    assert.equal(fetchCalls, 1, '10 concurrent alias requests must coalesce into 1 upstream call');
    for (const res of concurrent) {
      assert.equal(res.candles.length, 15);
      assert.equal(res.meta.source, 'live');
    }

    // Failure coalescing on distinct symbol: 5 concurrent callers -> 1 single-flight (2 Yahoo nodes tried once each)
    shouldFail = true;
    const beforeFailCalls = fetchCalls;
    const failedBatch = await Promise.all(Array.from({ length: 5 }, () => svc.getKlines('INFY.NS', '1d')));
    assert.equal(fetchCalls - beforeFailCalls, 2, '5 concurrent failing callers coalesce to 1 single-flight (query1 + query2)');
    for (const r of failedBatch) assert.equal(r.source, 'simulated');
    assert.equal(svc.klineCache.singleFlight.inFlightCount, 0);

    // Next call recovers immediately because failure was NOT cached
    shouldFail = false;
    const recovered = await svc.getKlines('INFY.NS', '1d');
    assert.equal(recovered.source, 'live');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('HTTP /api/klines and /api/quote coalesce concurrent requests, cache hits, and preserve response schema', async () => {
  let fetchCalls = 0;
  const svc = createMarketService({
    fetchFn: async () => {
      fetchCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 12))
      };
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    // 6 concurrent HTTP /api/klines requests -> 1 upstream call
    const kResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        httpGetJson(port, `/api/klines?symbol=${i % 2 === 0 ? 'RELIANCE.NS' : 'reliance'}&interval=1d`)
      )
    );
    assert.equal(fetchCalls, 1, 'Concurrent HTTP /api/klines requests must coalesce');
    for (const r of kResults) {
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json.candles) && r.json.candles.length === 12);
      assert.ok(r.json.instrument && r.json.instrument.symbol === 'RELIANCE.NS');
      assert.equal(r.json.interval, '1d');
      assert.equal(r.json.source, 'live');
      assert.ok(r.json.meta && r.json.meta.source === 'live');
    }

    // Subsequent HTTP /api/klines hits cache
    const kCached = await httpGetJson(port, '/api/klines?symbol=RELIANCE.NS&interval=1d');
    assert.equal(fetchCalls, 1);
    assert.equal(kCached.json.cacheHit, true);
    assert.equal(kCached.json.meta.source, 'cache');

    // 4 concurrent HTTP /api/quote requests -> 1 additional upstream call
    const qResults = await Promise.all(
      Array.from({ length: 4 }, () => httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d'))
    );
    assert.equal(fetchCalls, 2, 'Concurrent HTTP /api/quote requests must coalesce');
    for (const r of qResults) {
      assert.equal(r.status, 200);
      assert.equal(r.json.symbol, 'RELIANCE.NS');
      assert.ok(r.json.candle && Number.isFinite(r.json.candle.close));
      assert.ok(Number.isFinite(r.json.prevClose));
      assert.ok(r.json.meta && r.json.meta.source === 'live');
    }

    const qCached = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d');
    assert.equal(fetchCalls, 2);
    assert.equal(qCached.json.cacheHit, true);
    assert.equal(qCached.json.meta.source, 'cache');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('Yahoo K-lines strictly use split-adjusted raw OHLC (indicators.quote[0]) and ignore dividend-adjusted adjclose', async () => {
  const svc = createMarketService({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(makeYahooPayload('TCS.NS', 5))
    })
  });

  try {
    const res = await svc.getKlines('TCS.NS', '1d');
    assert.equal(res.meta.priceBasis, PRICE_BASIS);
    assert.equal(res.candles.length, 5);
    assert.equal(res.candles[0].open, 2800);
    assert.equal(res.candles[0].high, 2825);
    assert.equal(res.candles[0].low, 2790);
    assert.equal(res.candles[0].close, 2815);
    assert.notEqual(res.candles[0].close, 2700, 'Must never use dividend-adjusted adjclose');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('India stock automatically falls back from NSE (.NS) to BSE (.BO) when NSE returns Not Found, and resolves IST trading day', async () => {
  const requestedUrls = [];
  // 2026-03-19T18:30:00Z = 2026-03-20 00:00 IST (latest bar 4 days later = 2026-03-24 IST)
  const baseTs = Math.floor(Date.parse('2026-03-19T18:30:00Z') / 1000);
  const svc = createMarketService({
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      requestedUrls.push(url);
      if (url.includes('BSELTD.NS')) {
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ chart: { result: null, error: { code: 'Not Found' } } })
        };
      }
      if (url.includes('BSELTD.BO')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(makeYahooPayload('BSELTD.BO', 5, baseTs))
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  try {
    const res = await svc.getKlines('BSELTD.NS', '1d');
    assert.ok(requestedUrls.some((u) => u.includes('BSELTD.NS')));
    assert.ok(requestedUrls.some((u) => u.includes('BSELTD.BO')));
    assert.equal(res.source, 'live');
    assert.equal(res.meta.resolvedSymbol, 'BSELTD.BO');
    assert.equal(res.meta.exchange, 'BSE');
    assert.equal(res.meta.exchangeFallback, true);
    assert.equal(res.meta.exchangeTimezone, 'Asia/Kolkata');
    assert.equal(res.meta.timezone, 'IST');
    assert.equal(res.meta.latestTradingDay, '2026-03-24');
    assert.equal(res.candles.length, 5);
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('HTTP /api/quote forwards range parameter into cache key and upstream request', async () => {
  const requestedUrls = [];
  const svc = createMarketService({
    fetchFn: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 6))
      };
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    const r1 = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d&range=3mo');
    assert.equal(r1.status, 200);
    assert.equal(r1.json.meta.source, 'live');
    assert.match(requestedUrls[0], /range=3mo/, 'First upstream request must forward range=3mo');

    const r2 = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d&range=6mo');
    assert.equal(r2.status, 200);
    assert.equal(r2.json.meta.source, 'live');
    assert.equal(requestedUrls.length, 2, 'Different range values must use distinct cache keys');
    assert.match(requestedUrls[1], /range=6mo/, 'Second upstream request must forward range=6mo');

    const r3 = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d&range=3mo');
    assert.equal(r3.status, 200);
    assert.equal(requestedUrls.length, 2, 'Repeated range=3mo must hit cache');
    assert.equal(r3.json.cacheHit, true);
    assert.equal(r3.json.meta.source, 'cache');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
