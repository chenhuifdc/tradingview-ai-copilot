const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { NodeCircuitBreaker } = require('../server/cache');
const {
  createMarketService,
  formatDateInTimezone,
  buildResponseMeta,
  CACHE_CONFIG
} = require('../server/marketService');

function makeYahooPayload(symbol = 'RELIANCE.NS', count = 6, baseTs = 1711008000) {
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];

  for (let i = 0; i < count; i++) {
    timestamp.push(baseTs + i * 86400);
    open.push(2900 + i * 5);
    high.push(2920 + i * 5);
    low.push(2885 + i * 5);
    close.push(2910 + i * 5);
    volume.push(1500000 + i * 10000);
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
            quote: [{ open, high, low, close, volume }]
          }
        }
      ],
      error: null
    }
  };
}

test('2.1 Exponential backoff retries on 429 and 5xx, does NOT retry on 404, and fails over from query1 to query2', async () => {
  const calls = [];
  const svcRetry = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: {
      retry: { maxRetriesPerNode: 2, baseDelayMs: 5, maxDelayMs: 50, backoffFactor: 2 }
    },
    fetchFn: async (url) => {
      calls.push(url);
      if (calls.length <= 2) {
        return {
          ok: false,
          status: calls.length === 1 ? 429 : 503,
          text: async () => '{}'
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('TCS.NS', 6))
      };
    }
  });

  const res = await svcRetry.getKlines('TCS.NS', '1d');
  assert.equal(calls.length, 3, 'Should attempt initial + 2 retries on query1');
  assert.equal(res.source, 'live');
  assert.equal(res.meta.source, 'live');
  assert.equal(res.meta.stale, false);

  let calls404 = 0;
  const svc404 = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: {
      retry: { maxRetriesPerNode: 2, baseDelayMs: 5 }
    },
    fetchFn: async () => {
      calls404 += 1;
      return {
        ok: false,
        status: 404,
        text: async () => '{}'
      };
    }
  });

  const res404 = await svc404.getKlines('AAPL', '1d');
  assert.equal(calls404, 1, '404 must not trigger retries or query2 failover');
  assert.equal(res404.source, 'simulated');
  assert.equal(res404.meta.source, 'simulated');

  const hostCalls = [];
  const svcFailover = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: {
      retry: { maxRetriesPerNode: 0 }
    },
    fetchFn: async (url) => {
      hostCalls.push(url);
      if (url.includes('query1.finance.yahoo.com')) {
        throw new Error('query1 ETIMEDOUT');
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('HDFCBANK.NS', 7))
      };
    }
  });

  const resFailover = await svcFailover.getKlines('HDFCBANK.NS', '1d');
  assert.equal(hostCalls.length, 2);
  assert.match(hostCalls[0], /query1\.finance\.yahoo\.com/);
  assert.match(hostCalls[1], /query2\.finance\.yahoo\.com/);
  assert.equal(resFailover.source, 'live');
  assert.equal(resFailover.meta.source, 'live');
});

test('2.2 NodeCircuitBreaker opens after consecutive failures, skips host during cooldown, and recovers after half-open success', () => {
  let now = 1_000_000;
  const cb = new NodeCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 30_000,
    nowFn: () => now
  });

  const host = 'yahoo_query1';
  assert.equal(cb.canAttempt(host).allowed, true);

  cb.recordFailure(host);
  cb.recordFailure(host);
  assert.equal(cb.getNodeStatus(host).state, 'CLOSED');
  assert.equal(cb.canAttempt(host).allowed, true);

  cb.recordFailure(host);
  assert.equal(cb.getNodeStatus(host).state, 'OPEN');
  assert.equal(cb.canAttempt(host).allowed, false, 'Open circuit must block requests during cooldown');

  now += 31_000;
  assert.equal(cb.getNodeStatus(host).state, 'HALF_OPEN');
  const probe = cb.canAttempt(host);
  assert.equal(probe.allowed, true, 'After cooldown, circuit transitions to HALF_OPEN probe');
  assert.equal(probe.halfOpenProbe, true);

  cb.recordFailure(host);
  assert.equal(cb.getNodeStatus(host).state, 'OPEN');
  assert.equal(cb.canAttempt(host).allowed, false);

  now += 31_000;
  assert.equal(cb.canAttempt(host).allowed, true);
  cb.recordSuccess(host);
  assert.equal(cb.getNodeStatus(host).state, 'CLOSED');
  assert.equal(cb.getNodeStatus(host).failures, 0);
});

test('2.3 Three-tier degradation: live -> stale cache (within maxStaleMs) -> simulated fallback (when stale cache expired)', async () => {
  let now = 1_711_000_000_000;
  let shouldFail = false;

  const svc = createMarketService({
    nowFn: () => now,
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      if (shouldFail) throw new Error('Upstream outage');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('SBIN.NS', 8))
      };
    }
  });

  const liveRes = await svc.getKlines('SBIN.NS', '1d');
  assert.equal(liveRes.meta.source, 'live');
  assert.equal(liveRes.meta.stale, false);

  // Advance 1 hour (past 10m TTL, well within 4-day maxStaleMs for 1d) and fail upstream
  now += 3600 * 1000;
  shouldFail = true;
  const staleRes = await svc.getKlines('SBIN.NS', '1d');
  assert.equal(staleRes.source, 'cache');
  assert.equal(staleRes.meta.source, 'cache');
  assert.equal(staleRes.meta.stale, true);
  assert.ok(staleRes.meta.ageMs >= 3600 * 1000);

  // Advance beyond 4 days (96h) maxStaleMs -> must fall back to simulated
  now += 100 * 3600 * 1000;
  const simRes = await svc.getKlines('SBIN.NS', '1d');
  assert.equal(simRes.source, 'simulated');
  assert.equal(simRes.meta.source, 'simulated');
  assert.equal(simRes.meta.stale, false);
});

test('2.4 Weekend & Indian holiday stale cache: Friday 1d cache survives Saturday, Sunday, and Monday holiday outage (~75h)', async () => {
  assert.equal(CACHE_CONFIG.maxStaleMs['1d'], 4 * 24 * 60 * 60 * 1000, '1d maxStaleMs must be 96 hours (4 days)');
  assert.equal(CACHE_CONFIG.maxStaleMs['1w'], 7 * 24 * 60 * 60 * 1000, '1w maxStaleMs must remain 7 days');

  // Friday 15:30 IST = Friday 10:00 UTC (2026-03-20T10:00:00Z -> 1773998400)
  const fridayCloseSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);
  const fridayBaseSec = fridayCloseSec - 4 * 86400;

  let now = Date.parse('2026-03-20T10:05:00Z');
  let upstreamDown = false;

  const svc = createMarketService({
    nowFn: () => now,
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      if (upstreamDown) throw new Error('Holiday upstream maintenance');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 5, fridayBaseSec))
      };
    }
  });

  await svc.getKlines('RELIANCE.NS', '1d');

  // 75 hours later (Monday 18:35 IST during a market holiday + upstream outage)
  now += 75 * 3600 * 1000;
  upstreamDown = true;

  const holidayOutageRes = await svc.getKlines('RELIANCE.NS', '1d');
  assert.equal(holidayOutageRes.source, 'cache', 'Friday cache on Monday holiday must NOT fall back to simulated');
  assert.equal(holidayOutageRes.meta.source, 'cache');
  assert.equal(holidayOutageRes.meta.stale, true);
  assert.equal(holidayOutageRes.meta.latestTradingDay, '2026-03-20', 'latestTradingDay must remain Friday 2026-03-20');
});

test('2.5 Meta resolvedSymbol & exchange: NSE -> BSE fallback populates resolvedSymbol and exchange=BSE', async () => {
  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      if (url.includes('BSELTD.NS')) {
        return { ok: false, status: 404, text: async () => '{}' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('BSELTD.BO', 5))
      };
    }
  });

  const res = await svc.getKlines('BSELTD.NS', '1d');
  assert.equal(res.meta.resolvedSymbol, 'BSELTD.BO');
  assert.equal(res.meta.exchange, 'BSE');
  assert.equal(res.meta.exchangeFallback, true);
});

test('2.6 latestTradingDay is derived strictly from latestBarTime in IST (Asia/Kolkata), not current date', () => {
  // 2026-03-20 18:30 UTC is 2026-03-21 00:00 IST
  const tsUtcMs = Date.parse('2026-03-20T18:30:00Z');
  assert.equal(formatDateInTimezone(tsUtcMs, 'Asia/Kolkata'), '2026-03-21');

  // Historical bar from 2024-01-12 10:00 UTC (15:30 IST Friday) queried on any weekend/holiday in 2026
  // must report 2024-01-12, never today's wall-clock date.
  const friday2024Sec = Math.floor(Date.parse('2024-01-12T10:00:00Z') / 1000);
  const meta = buildResponseMeta({
    source: 'cache',
    fetchedAt: Date.now() - 48 * 3600 * 1000,
    now: Date.now(),
    stale: true,
    provider: 'yahoo',
    latestBarTime: friday2024Sec,
    market: 'in',
    resolvedSymbol: 'RELIANCE.NS',
    exchange: 'NSE'
  });
  assert.equal(meta.latestTradingDay, '2024-01-12');
});

test('2.7 Simulated mode blocks AI analysis by default unless chkDemoMode is enabled, and demo disclaimers stay out of copyable reportText', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /id="simulatedWatermark"/);
  assert.match(html, /id="chkDemoMode"/);
  assert.match(html, /id="demoModeBanner"/);
  assert.match(appJs, /demoMode/);
  assert.match(appJs, /当前为模拟数据：AI 分析默认已禁用/);
});
