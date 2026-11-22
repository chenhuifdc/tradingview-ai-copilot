const test = require('node:test');
const assert = require('node:assert/strict');

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

function makeYahooPayload(symbol = 'RELIANCE.NS', count = 10) {
  const baseTs = 1710892800; // 2024-03-20T00:00:00Z
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

test('1.1 Cache key normalization: case, whitespace, interval, and range are canonicalized', () => {
  assert.equal(normalizeSymbol('  reliance.ns '), 'RELIANCE.NS');
  assert.equal(normalizeInterval(' 1D '), '1d');
  assert.equal(normalizeInterval('invalid_tf'), '1d');
  assert.equal(normalizeRange('', '1d', { provider: 'yahoo', mode: 'klines' }), '5y');
  assert.equal(normalizeRange(' 2Y ', '1d', { provider: 'yahoo', mode: 'klines' }), '2y');

  const k1 = buildMarketCacheKey({ type: 'klines', symbol: 'reliance.ns', interval: '1d', range: '5y' });
  const k2 = buildMarketCacheKey({ type: 'klines', symbol: '  RELIANCE.NS ', interval: ' 1D ', range: '' });
  assert.equal(k1.key, k2.key);
  assert.equal(k1.key, 'klines::RELIANCE.NS::1d::5y');
});

test('1.2 LruTtlCache enforces maxEntries LRU eviction and TTL expiration + stale window', () => {
  let now = 100000;
  const cache = new LruTtlCache({ maxEntries: 3, defaultTtlMs: 5000, nowFn: () => now });

  cache.set('a', { v: 1 });
  cache.set('b', { v: 2 });
  cache.set('c', { v: 3 });
  assert.equal(cache.size, 3);

  assert.deepEqual(cache.get('a'), { v: 1 });

  cache.set('d', { v: 4 });
  assert.equal(cache.size, 3);
  assert.equal(cache.get('b'), undefined, 'Least-recently-used key b must be evicted');
  assert.deepEqual(cache.get('a'), { v: 1 });
  assert.deepEqual(cache.get('c'), { v: 3 });
  assert.deepEqual(cache.get('d'), { v: 4 });

  now += 6000;
  assert.equal(cache.getEntry('a', { allowStale: false, maxStaleMs: 20000 }), null);
  const staleHit = cache.getEntry('a', { allowStale: true, maxStaleMs: 20000 });
  assert.ok(staleHit, 'allowStale should recover expired entry within maxStaleMs');
  assert.equal(staleHit.stale, true);
  assert.deepEqual(staleHit.value, { v: 1 });

  now += 25000;
  assert.equal(cache.getEntry('a', { allowStale: true, maxStaleMs: 20000 }), null);
});

test('1.3 SingleFlightGroup coalesces N concurrent requests for same key into 1 upstream call', async () => {
  const sf = new SingleFlightGroup();
  let upstreamCount = 0;

  const task = () =>
    sf.do('klines::RELIANCE.NS::1d::5y', async () => {
      upstreamCount += 1;
      await new Promise((r) => setTimeout(r, 25));
      return { symbol: 'RELIANCE.NS', bars: 100 };
    });

  const results = await Promise.all(Array.from({ length: 12 }, () => task()));
  assert.equal(upstreamCount, 1, '12 concurrent calls for same key must trigger only 1 upstream call');
  const sharedCount = results.filter((r) => r.shared).length;
  assert.equal(sharedCount, 11);
  for (const r of results) {
    assert.deepEqual(r.value, { symbol: 'RELIANCE.NS', bars: 100 });
  }
  assert.equal(sf.inFlightCount, 0);
});

test('1.4 getKlines cache hit + single-flight: 10 concurrent requests hit upstream once, subsequent call hits cache', async () => {
  let fetchCalls = 0;
  const svc = createMarketService({
    fetchFn: async () => {
      fetchCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 15))
      };
    }
  });

  const concurrent = await Promise.all(
    Array.from({ length: 10 }, (_, idx) =>
      svc.getKlines(idx % 2 === 0 ? 'RELIANCE.NS' : '  reliance.ns ', '1d')
    )
  );

  assert.equal(fetchCalls, 1, '10 concurrent getKlines calls must result in 1 upstream fetch');
  for (const res of concurrent) {
    assert.equal(res.candles.length, 15);
    assert.equal(res.meta.source, 'live');
  }

  const cachedRes = await svc.getKlines('RELIANCE.NS', '1d');
  assert.equal(fetchCalls, 1, 'Cached call must not trigger upstream fetch');
  assert.equal(cachedRes.cacheHit, true);
  assert.equal(cachedRes.meta.source, 'cache');
  assert.equal(cachedRes.meta.stale, false);
});

test('1.5 Single-flight failure isolation: failed upstream request cleans in-flight map and allows subsequent retry', async () => {
  let attempts = 0;
  let shouldFail = true;

  const svc = createMarketService({
    resilienceConfig: {
      retry: { maxRetriesPerNode: 0 }
    },
    fetchFn: async () => {
      attempts += 1;
      await new Promise((r) => setTimeout(r, 15));
      if (shouldFail) {
        throw new Error('Upstream network reset');
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('INFY.NS', 12))
      };
    }
  });

  // 5 concurrent requests when both query1 and query2 fail (maxRetriesPerNode: 0 -> 2 node attempts total across all 5 callers)
  const firstBatch = await Promise.all(
    Array.from({ length: 5 }, () => svc.getKlines('INFY.NS', '1d'))
  );
  assert.equal(attempts, 2, '5 concurrent failing requests must coalesce into 1 single-flight execution (1 try on query1 + 1 failover on query2)');
  for (const res of firstBatch) {
    assert.equal(res.source, 'simulated');
  }
  assert.equal(svc.klineCache.singleFlight.inFlightCount, 0);

  shouldFail = false;
  const retryRes = await svc.getKlines('INFY.NS', '1d');
  assert.equal(attempts, 3);
  assert.equal(retryRes.source, 'live');
  assert.equal(retryRes.candles.length, 12);
});

test('1.6 OHLC consistency: getKlines uses split-adjusted raw quote[0] instead of dividend-adjusted adjclose', async () => {
  const svc = createMarketService({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(makeYahooPayload('TCS.NS', 5))
    })
  });

  const res = await svc.getKlines('TCS.NS', '1d');
  assert.equal(res.meta.priceBasis, PRICE_BASIS);
  assert.equal(res.candles.length, 5);
  assert.equal(res.candles[0].open, 2800);
  assert.equal(res.candles[0].high, 2825);
  assert.equal(res.candles[0].low, 2790);
  assert.equal(res.candles[0].close, 2815);
  assert.notEqual(res.candles[0].close, 2700, 'Must never use dividend-adjusted adjclose');
});

test('1.7 Indian equity NSE (.NS) -> BSE (.BO) automatic fallback when NSE returns 404 or Not Found', async () => {
  const requestedUrls = [];
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
          text: async () => JSON.stringify(makeYahooPayload('BSELTD.BO', 8))
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  const res = await svc.getKlines('BSELTD.NS', '1d');
  assert.ok(requestedUrls.some((u) => u.includes('BSELTD.NS')));
  assert.ok(requestedUrls.some((u) => u.includes('BSELTD.BO')));
  assert.equal(res.source, 'live');
  assert.equal(res.meta.resolvedSymbol, 'BSELTD.BO');
  assert.equal(res.meta.exchange, 'BSE');
  assert.equal(res.meta.exchangeFallback, true);
  assert.equal(res.candles.length, 8);
});
