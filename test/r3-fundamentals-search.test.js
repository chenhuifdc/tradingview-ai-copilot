const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAppServer } = require('../server');
const { createMarketService } = require('../server/marketService');

function makeYahooChart(symbol = 'RELIANCE.NS', count = 10, baseTs = Math.floor(Date.parse('2026-03-11T10:00:00Z') / 1000)) {
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  for (let i = 0; i < count; i++) {
    timestamp.push(baseTs + i * 86400);
    open.push(1350 + i * 4);
    high.push(1365 + i * 4);
    low.push(1340 + i * 4);
    close.push(1358 + i * 4);
    volume.push(2000000 + i * 50000);
  }
  return {
    chart: {
      result: [
        {
          meta: { currency: 'INR', symbol, exchangeName: symbol.endsWith('.BO') ? 'BSE' : 'NSI' },
          timestamp,
          indicators: { quote: [{ open, high, low, close, volume }] }
        }
      ],
      error: null
    }
  };
}

function makeYahooSearchMeta(symbol = 'RELIANCE.NS') {
  return {
    quotes: [
      {
        symbol,
        shortname: 'Reliance Industries',
        longname: 'Reliance Industries Limited',
        sectorDisp: 'Energy',
        industryDisp: 'Oil & Gas Refining & Marketing',
        exchange: 'NSI',
        exchDisp: 'NSE',
        quoteType: 'EQUITY'
      }
    ],
    news: [
      {
        title: 'Reliance Q4 refining margins beat Street estimates',
        providerPublishTime: Math.floor(Date.parse('2026-03-20T06:30:00Z') / 1000)
      },
      {
        title: 'Reliance Jio expands 5G enterprise rollout across India',
        providerPublishTime: Math.floor(Date.parse('2026-03-19T11:15:00Z') / 1000)
      }
    ]
  };
}

const MOCK_GNEWS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Reliance Q4 refining margins beat Street estimates - Economic Times]]></title>
    <pubDate>Fri, 20 Mar 2026 07:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Reliance Retail opens 200 new stores in FY26 - Mint</title>
    <pubDate>Thu, 19 Mar 2026 09:45:00 GMT</pubDate>
  </item>
</channel></rss>`;

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

test('R3.1 getStockFundamentals fetches Yahoo sector/industry/news + Google News RSS with timestamps and deduplicates headlines', async () => {
  const calledHosts = new Set();
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      calledHosts.add(new URL(url).host);
      if (url.includes('/v1/finance/search')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooSearchMeta('RELIANCE.NS')) };
      }
      if (url.includes('news.google.com/rss/search')) {
        return { ok: true, status: 200, text: async () => MOCK_GNEWS_RSS };
      }
      if (url.includes('/v8/finance/chart/')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooChart('RELIANCE.NS', 10)) };
      }
      throw new Error(`Unexpected external URL: ${url}`);
    }
  });

  try {
    const f = await svc.getStockFundamentals('RELIANCE.NS');
    assert.equal(f.symbol, 'RELIANCE.NS');
    assert.equal(f.sector, 'Energy');
    assert.equal(f.industry, 'Oil & Gas Refining & Marketing');
    assert.equal(f.enName, 'Reliance Industries Limited');
    assert.equal(f.latestDate, '2026-03-20');
    assert.ok(f.meta && f.meta.source === 'live');
    assert.equal(f.meta.provider, 'yahoo:query1');

    // Deduplicated headlines: 2 from GNews + 2 from Yahoo with 1 exact duplicate title -> 3 unique items
    assert.equal(f.headlines.length, 3, 'Duplicate headline across Google News and Yahoo must be deduplicated');
    for (const h of f.headlines) {
      assert.ok(h.title.length > 5);
      assert.match(h.pubDate, /^\d{4}-\d{2}-\d{2}$/, 'Headline must carry YYYY-MM-DD pubDate');
      assert.match(h.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Headline must carry ISO timestamp');
    }
    assert.equal(f.headlines[0].title, 'Reliance Q4 refining margins beat Street estimates');
    assert.equal(f.headlines[1].title, 'Reliance Retail opens 200 new stores in FY26');
    assert.equal(f.headlines[2].title, 'Reliance Jio expands 5G enterprise rollout across India');

    // Only Yahoo Finance and Google News RSS should be touched
    for (const host of calledHosts) {
      assert.ok(
        host.endsWith('finance.yahoo.com') || host === 'news.google.com',
        `Must not contact unrelated external site: ${host}`
      );
    }
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('R3.2 getStockFundamentals caches in fundamentalsCache, coalesces concurrent requests, and degrades to stale cache past TTL when upstreams fail', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-03-20T10:05:00Z') });
  let searchCalls = 0;
  let rssCalls = 0;
  let upstreamDown = false;

  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      if (upstreamDown) throw new Error('Total outage');
      if (url.includes('/v1/finance/search')) {
        searchCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooSearchMeta('RELIANCE.NS')) };
      }
      if (url.includes('news.google.com/rss/search')) {
        rssCalls += 1;
        return { ok: true, status: 200, text: async () => MOCK_GNEWS_RSS };
      }
      if (url.includes('/v8/finance/chart/')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooChart('RELIANCE.NS', 10)) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  try {
    // 5 concurrent callers coalesce into 1 Yahoo search + 1 RSS fetch
    const batch = await Promise.all(
      Array.from({ length: 5 }, (_, i) => svc.getStockFundamentals(i % 2 === 0 ? 'RELIANCE.NS' : 'reliance'))
    );
    assert.equal(searchCalls, 1, 'Concurrent fundamentals requests must single-flight coalesce');
    assert.equal(rssCalls, 1);
    for (const r of batch) {
      assert.equal(r.sector, 'Energy');
      assert.equal(r.headlines.length, 3);
    }

    // Fresh cache hit within 5m TTL
    const hit = await svc.getStockFundamentals('RELIANCE.NS');
    assert.equal(searchCalls, 1);
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.meta.source, 'cache');
    assert.equal(hit.meta.stale, false);

    // Advance 12 minutes (past 5m fundamentals TTL and 10m kline TTL, triggering 12 periodic sweeps), then fail all upstreams
    t.mock.timers.tick(12 * 60 * 1000);
    upstreamDown = true;

    // Wait: klineCache still has stale 1d cache, so also expire klineCache OR test fundamentals stale directly by clearing klineCache
    svc.klineCache.clear();
    const staleFund = await svc.getStockFundamentals('RELIANCE.NS');
    assert.equal(staleFund.cacheHit, true, 'Must degrade to stale fundamentalsCache when all upstreams fail');
    assert.equal(staleFund.meta.source, 'cache');
    assert.equal(staleFund.meta.stale, true);
    assert.equal(staleFund.sector, 'Energy', 'Stale degradation must preserve sector/industry/headlines');
    assert.equal(staleFund.headlines.length, 3);
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('R3.3 getStockFundamentals routes Yahoo search through circuit breaker failover (query1 -> query2) and exposes complete meta over HTTP /api/fundamentals', async () => {
  const yahooSearchHosts = [];
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      if (url.includes('/v1/finance/search')) {
        const host = new URL(url).host;
        yahooSearchHosts.push(host);
        if (host === 'query1.finance.yahoo.com') throw new Error('query1 search 503');
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooSearchMeta('TCS.NS')) };
      }
      if (url.includes('news.google.com/rss/search')) {
        return { ok: true, status: 200, text: async () => MOCK_GNEWS_RSS };
      }
      if (url.includes('/v8/finance/chart/')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooChart('TCS.NS', 8)) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    const res = await httpGetJson(port, '/api/fundamentals?symbol=TCS.NS');
    assert.equal(res.status, 200);
    assert.deepEqual(yahooSearchHosts, ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
    assert.equal(res.json.sector, 'Energy');
    assert.ok(res.json.headlines.length >= 2);
    assert.ok(res.json.meta && res.json.meta.source === 'live');
    assert.equal(res.json.meta.exchange, 'NSE');
    assert.equal(res.json.meta.resolvedSymbol, 'TCS.NS');
    assert.equal(res.json.meta.latestTradingDay, '2026-03-18');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('R3.4 searchSymbols merges local catalog with Yahoo Finance global search (including India .NS companion query) and respects Yahoo failover', async () => {
  const seenUrls = [];
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      seenUrls.push(url);
      if (url.includes('query1.finance.yahoo.com')) {
        throw new Error('query1 timeout');
      }
      if (url.includes('query2.finance.yahoo.com/v1/finance/search')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              quotes: [
                {
                  symbol: 'MRF.NS',
                  shortname: 'MRF Limited',
                  longname: 'MRF Limited India',
                  exchange: 'NSI',
                  exchDisp: 'NSE',
                  quoteType: 'EQUITY'
                },
                {
                  symbol: 'MRF.BO',
                  shortname: 'MRF BSE',
                  exchange: 'BSE',
                  exchDisp: 'BSE',
                  quoteType: 'EQUITY'
                },
                {
                  symbol: 'MRF2603C100',
                  quoteType: 'OPTION',
                  exchange: 'NSI'
                }
              ]
            })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  try {
    const out = await svc.searchSymbols('MRF', 'in');
    assert.equal(out.remoteOnline, true);
    assert.ok(seenUrls.some((u) => u.includes('q=MRF&')), 'Must query raw term MRF');
    assert.ok(seenUrls.some((u) => u.includes('q=MRF.NS&')), 'India tab must also query MRF.NS companion term');
    assert.ok(out.results.some((r) => r.symbol === 'MRF.NS' && r.exchange === 'NSE' && r.currency === 'INR'));
    assert.ok(out.results.some((r) => r.symbol === 'MRF.BO' && r.exchange === 'BSE'));
    assert.equal(out.results.some((r) => r.symbol === 'MRF2603C100'), false, 'OPTION quotes must be filtered out');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('R3.5 searchSymbols queries Naver for Korean Hangul/kr queries and Eastmoney for CJK/CN queries without touching unrelated providers', async () => {
  const hitUrls = [];
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      hitUrls.push(url);
      if (url.includes('ac.stock.naver.com/ac')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                { nationCode: 'KOR', code: '005930', typeCode: 'KOSPI', name: '삼성전자' },
                { nationCode: 'KOR', code: '247540', typeCode: 'KOSDAQ', name: '에코프로비엠' }
              ]
            })
        };
      }
      if (url.includes('searchapi.eastmoney.com/api/suggest/get')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              QuotationCodeTable: {
                Data: [
                  { Code: '600519', Name: '贵州茅台', PinYin: 'GZMT', Classify: 'AStock', MktNum: '1' },
                  { Code: '00700', Name: '腾讯控股', Classify: 'HK' }
                ]
              }
            })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  try {
    // 1) Korean Hangul query -> hits Naver, does NOT hit Yahoo or Eastmoney
    hitUrls.length = 0;
    const krOut = await svc.searchSymbols('에코프로', 'kr');
    assert.equal(krOut.remoteOnline, true);
    assert.ok(hitUrls.every((u) => u.includes('ac.stock.naver.com')));
    assert.ok(krOut.results.some((r) => r.symbol === '247540.KQ' && r.exchange === 'KOSDAQ' && r.currency === 'KRW'));

    // 2) Chinese CJK query -> hits Eastmoney, does NOT hit Yahoo or Naver
    hitUrls.length = 0;
    const cnOut = await svc.searchSymbols('茅台', 'all');
    assert.equal(cnOut.remoteOnline, true);
    assert.ok(hitUrls.every((u) => u.includes('searchapi.eastmoney.com')));
    assert.ok(cnOut.results.some((r) => r.symbol === '600519.SS' && r.exchange === 'SSE' && r.currency === 'CNY'));
    assert.ok(cnOut.results.some((r) => r.symbol === '0700.HK' && r.exchange === 'HKEX' && r.currency === 'HKD'));
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('R3.6 searchSymbols generates direct fallback candidates (India NSE/BSE, Korea KOSPI/KOSDAQ, synthetic Binance pair) when offline, verified over HTTP /api/search', async () => {
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      throw new Error('Offline network');
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    // 1) India direct fallback (.NS + .BO)
    const inRes = await httpGetJson(port, '/api/search?q=ZOMATOX&market=in');
    assert.equal(inRes.status, 200);
    assert.equal(inRes.json.remoteOnline, false);
    assert.deepEqual(
      inRes.json.results.map((r) => r.symbol),
      ['ZOMATOX.NS', 'ZOMATOX.BO']
    );

    // 2) Korea 6-digit direct fallback (.KS + .KQ)
    const krRes = await httpGetJson(port, '/api/search?q=999999&market=kr');
    assert.equal(krRes.status, 200);
    assert.deepEqual(
      krRes.json.results.map((r) => r.symbol),
      ['999999.KS', '999999.KQ']
    );

    // 3) Synthetic Binance crypto pair
    const cryptoRes = await httpGetJson(port, '/api/search?q=PEPE&market=crypto');
    assert.equal(cryptoRes.status, 200);
    assert.ok(cryptoRes.json.results.some((r) => r.symbol === 'PEPEUSDT' && r.provider === 'binance'));
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('R3.7 Eastmoney search uses fixed public parameter constant and is never overridden by env vars or user input', async () => {
  const { EASTMONEY_PUBLIC_SUGGEST_PARAM } = require('../server/marketService');
  assert.equal(EASTMONEY_PUBLIC_SUGGEST_PARAM, 'D43BF722C8E33BDC906FB84D85E326E8');

  const prevEnv = {
    EASTMONEY_TOKEN: process.env.EASTMONEY_TOKEN,
    TOKEN: process.env.TOKEN,
    API_TOKEN: process.env.API_TOKEN
  };
  process.env.EASTMONEY_TOKEN = 'ENV_OVERRIDE_SHOULD_NOT_BE_USED';
  process.env.TOKEN = 'ENV_TOKEN_SHOULD_NOT_BE_USED';
  process.env.API_TOKEN = 'ENV_API_TOKEN_SHOULD_NOT_BE_USED';

  const capturedUrls = [];
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      capturedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ QuotationCodeTable: { Data: [] } })
      };
    }
  });

  try {
    // Attempt query-parameter injection via user query string
    await svc.searchSymbols('茅台&token=USER_INJECTED_TOKEN', 'all');
    assert.equal(capturedUrls.length, 1);
    const parsed = new URL(capturedUrls[0]);
    assert.equal(parsed.hostname, 'searchapi.eastmoney.com');
    assert.deepEqual(
      parsed.searchParams.getAll('token'),
      [EASTMONEY_PUBLIC_SUGGEST_PARAM],
      'Outgoing Eastmoney token query param must strictly equal the fixed public constant'
    );
    assert.equal(parsed.searchParams.get('input'), '茅台&token=USER_INJECTED_TOKEN');
    assert.equal(capturedUrls[0].includes('ENV_OVERRIDE'), false);
    assert.equal(capturedUrls[0].includes('ENV_TOKEN'), false);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

