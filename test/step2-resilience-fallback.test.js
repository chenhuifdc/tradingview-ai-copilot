const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAppServer } = require('../server');
const { LruTtlCache, NodeCircuitBreaker } = require('../server/cache');
const {
  createMarketService,
  formatDateInTimezone,
  buildResponseMeta,
  CACHE_CONFIG,
  UPSTREAM_NODES
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

function assertCompleteMetaContract(meta, expectedSource) {
  assert.ok(meta && typeof meta === 'object', 'meta object must exist');
  const requiredFields = [
    'source',
    'fetchedAt',
    'ageMs',
    'stale',
    'provider',
    'priceBasis',
    'latestBarTime',
    'exchangeTimezone',
    'timezone',
    'utcOffset',
    'latestTradingDay',
    'resolvedSymbol',
    'exchange'
  ];
  for (const field of requiredFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(meta, field), `meta must include field '${field}'`);
  }
  assert.equal(meta.source, expectedSource);
  assert.equal(typeof meta.fetchedAt, 'number');
  assert.equal(typeof meta.ageMs, 'number');
  assert.equal(typeof meta.stale, 'boolean');
  assert.equal(typeof meta.provider, 'string');
  assert.ok(meta.provider.length > 0);
  assert.equal(typeof meta.priceBasis, 'string');
  assert.ok(Number.isFinite(meta.latestBarTime) && meta.latestBarTime > 0);
  assert.equal(typeof meta.exchangeTimezone, 'string');
  assert.equal(typeof meta.timezone, 'string');
  assert.equal(typeof meta.utcOffset, 'string');
  assert.match(meta.latestTradingDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof meta.resolvedSymbol, 'string');
  assert.equal(typeof meta.exchange, 'string');
}

function createMinimalDomForCopilot() {
  class MiniNode {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.style = {};
      this.dataset = {};
      this.children = [];
      this._textContent = '';
      this.listeners = {};
      this.scrollTop = 0;
      this.scrollHeight = 100;
    }
    get textContent() {
      if (!this.children.length) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
    }
    appendChild(c) {
      if (c) this.children.push(c);
      return c;
    }
    append(...list) {
      for (const c of list) this.appendChild(c);
    }
    addEventListener(ev, fn) {
      this.listeners[ev] = this.listeners[ev] || [];
      this.listeners[ev].push(fn);
    }
    remove() {}
    scrollIntoView() {}
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const out = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = (n) => {
        for (const c of n.children) {
          if (cls ? String(c.className || '').split(/\s+/).includes(cls) : c.tagName.toLowerCase() === sel.toLowerCase()) {
            out.push(c);
          }
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }
  return {
    MiniNode,
    doc: {
      createElement: (tag) => new MiniNode(tag),
      createDocumentFragment: () => new MiniNode('#fragment')
    }
  };
}

test('AbortController timeout, 429, and 5xx trigger exponential backoff retry and failover strictly across known nodes', async () => {
  // 1) 429 & 503 exponential backoff progression
  const calls = [];
  const recordedDelays = [];
  const svcRetry = createMarketService({
    sleepFn: async (ms) => {
      recordedDelays.push(ms);
    },
    resilienceConfig: {
      retry: { maxRetriesPerNode: 2, baseDelayMs: 10, maxDelayMs: 100, backoffFactor: 2 }
    },
    fetchFn: async (url) => {
      calls.push(url);
      if (calls.length <= 2) {
        return { ok: false, status: calls.length === 1 ? 429 : 503, text: async () => '{}' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('TCS.NS', 6)) };
    }
  });

  // 2) AbortController timeout triggers abort signal and fails over strictly to known query2 node
  let abortObserved = false;
  const timeoutUrls = [];
  const svcTimeout = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: {
      timeoutMs: { yahoo: 25 },
      retry: { maxRetriesPerNode: 0 }
    },
    fetchFn: async (url, opts) => {
      timeoutUrls.push(url);
      if (url.includes('query1.finance.yahoo.com')) {
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            abortObserved = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('HDFCBANK.NS', 7)) };
    }
  });

  // 3) 404 does NOT retry and does NOT fail over
  let calls404 = 0;
  const svc404 = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 2, baseDelayMs: 5 } },
    fetchFn: async () => {
      calls404 += 1;
      return { ok: false, status: 404, text: async () => '{}' };
    }
  });

  try {
    const res = await svcRetry.getKlines('TCS.NS', '1d');
    assert.equal(calls.length, 3, 'Should attempt initial + 2 retries on query1');
    assert.deepEqual(recordedDelays, [10, 20], 'Backoff delays must grow exponentially (10ms -> 20ms)');
    assert.equal(res.meta.source, 'live');
    assert.equal(res.meta.provider, 'yahoo:query1');

    const resTimeout = await svcTimeout.getKlines('HDFCBANK.NS', '1d');
    assert.equal(abortObserved, true, 'AbortController must fire abort on timed-out fetch signal');
    assert.equal(timeoutUrls.length, 2);
    const allowedHosts = UPSTREAM_NODES.yahoo.map((n) => new URL(n.baseUrl).host);
    for (const u of timeoutUrls) {
      assert.ok(allowedHosts.includes(new URL(u).host), `Failover must stay strictly within known nodes: ${u}`);
    }
    assert.equal(resTimeout.meta.source, 'live');
    assert.equal(resTimeout.meta.provider, 'yahoo:query2');

    const res404 = await svc404.getKlines('AAPL', '1d');
    assert.equal(calls404, 1, '404 must not trigger retries or failover');
    assert.equal(res404.meta.source, 'simulated');
  } finally {
    for (const s of [svcRetry, svcTimeout, svc404]) {
      s.klineCache.destroy();
      s.quoteCache.destroy();
      s.fundamentalsCache.destroy();
      s.simCache.destroy();
    }
  }
});

test('Circuit breaker opens after consecutive node failures, skips node during cooldown, and recovers via HALF_OPEN probe', async () => {
  let now = 1_000_000;
  const cb = new NodeCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 30_000,
    nowFn: () => now
  });

  const host = 'yahoo:query1';
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

  // Verify end-to-end inside marketService: once query1 opens, subsequent requests skip query1 directly to query2
  let svcNow = 2_000_000;
  let query1Down = true;
  const seenHosts = [];
  const svc = createMarketService({
    nowFn: () => svcNow,
    sleepFn: async () => {},
    resilienceConfig: {
      retry: { maxRetriesPerNode: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 }
    },
    fetchFn: async (url) => {
      const h = new URL(url).host;
      seenHosts.push(h);
      if (h === 'query1.finance.yahoo.com' && query1Down) {
        throw new Error('query1 failure');
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 6)) };
    }
  });

  try {
    // 2 distinct symbols fail on query1 -> opens circuit for yahoo:query1
    await svc.getKlines('SYM1.NS', '1d');
    await svc.getKlines('SYM2.NS', '1d');
    assert.equal(svc.circuitBreaker.getNodeStatus('yahoo:query1').state, 'OPEN');

    // Next request during cooldown MUST skip query1 completely and hit query2 directly
    seenHosts.length = 0;
    const skippedRes = await svc.getKlines('SYM3.NS', '1d');
    assert.deepEqual(seenHosts, ['query2.finance.yahoo.com']);
    assert.equal(skippedRes.meta.provider, 'yahoo:query2');

    // After cooldown, query1 recovers via HALF_OPEN probe
    svcNow += 31_000;
    query1Down = false;
    seenHosts.length = 0;
    const recoveredRes = await svc.getKlines('SYM4.NS', '1d');
    assert.deepEqual(seenHosts, ['query1.finance.yahoo.com']);
    assert.equal(recoveredRes.meta.provider, 'yahoo:query1');
    assert.equal(svc.circuitBreaker.getNodeStatus('yahoo:query1').state, 'CLOSED');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('CACHE_CONFIG.maxStaleMs matches exact per-interval specification and enforces tiered degradation', async () => {
  assert.equal(CACHE_CONFIG.maxStaleMs['1m'], 2 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['5m'], 5 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['15m'], 15 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['1h'], 60 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['4h'], 4 * 60 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['1d'], 4 * 24 * 60 * 60 * 1000);
  assert.equal(CACHE_CONFIG.maxStaleMs['1w'], 7 * 24 * 60 * 60 * 1000);

  let now = 1_711_000_000_000;
  let shouldFail = false;

  const svc = createMarketService({
    nowFn: () => now,
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      if (shouldFail) throw new Error('Upstream outage');
      return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('SBIN.NS', 8)) };
    }
  });

  try {
    // Tier 1: live
    const liveRes = await svc.getKlines('SBIN.NS', '1m');
    assert.equal(liveRes.meta.source, 'live');
    assert.equal(liveRes.meta.stale, false);

    // Tier 2: past 15s TTL, within 2m maxStaleMs -> stale cache
    now += 60 * 1000;
    shouldFail = true;
    const staleRes = await svc.getKlines('SBIN.NS', '1m');
    assert.equal(staleRes.source, 'cache');
    assert.equal(staleRes.meta.source, 'cache');
    assert.equal(staleRes.meta.stale, true);
    assert.ok(staleRes.meta.ageMs >= 60 * 1000);

    // Tier 3: beyond 2m maxStaleMs -> simulated fallback
    now += 3 * 60 * 1000;
    const simRes = await svc.getKlines('SBIN.NS', '1m');
    assert.equal(simRes.source, 'simulated');
    assert.equal(simRes.meta.source, 'simulated');
    assert.equal(simRes.meta.stale, false);
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('Friday 1d cache degrades to cache across Saturday, Sunday, and Monday holiday (<= 4 days) and derives latestTradingDay strictly from latestBarTime', async () => {
  // 2026-03-20 18:30 UTC is 2026-03-21 00:00 IST
  assert.equal(formatDateInTimezone(Date.parse('2026-03-20T18:30:00Z'), 'Asia/Kolkata'), '2026-03-21');

  // Historical bar from 2024-01-12 10:00 UTC (15:30 IST Friday) must never use wall-clock date
  const friday2024Sec = Math.floor(Date.parse('2024-01-12T10:00:00Z') / 1000);
  const histMeta = buildResponseMeta({
    source: 'cache',
    fetchedAt: Date.now() - 48 * 3600 * 1000,
    now: Date.now(),
    stale: true,
    provider: 'yahoo:query1',
    latestBarTime: friday2024Sec,
    market: 'in',
    resolvedSymbol: 'RELIANCE.NS',
    exchange: 'NSE'
  });
  assert.equal(histMeta.latestTradingDay, '2024-01-12');

  // Friday 15:30 IST = Friday 10:00 UTC
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

  try {
    await svc.getKlines('RELIANCE.NS', '1d');

    // 75 hours later (Monday 18:35 IST holiday + outage)
    now += 75 * 3600 * 1000;
    upstreamDown = true;

    const holidayOutageRes = await svc.getKlines('RELIANCE.NS', '1d');
    assert.equal(holidayOutageRes.source, 'cache', 'Friday cache on Monday holiday must NOT fall back to simulated');
    assert.equal(holidayOutageRes.meta.source, 'cache');
    assert.equal(holidayOutageRes.meta.stale, true);
    assert.equal(holidayOutageRes.meta.latestTradingDay, '2026-03-20');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
  }
});

test('Frontend status badge & AI analysis pipeline handle live, NSE->BSE fallback, cache/stale, and simulated (default blocked vs Demo Mode)', async () => {
  const { doc, MiniNode } = createMinimalDomForCopilot();
  const prevDoc = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevFetch = globalThis.fetch;

  globalThis.document = doc;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.requestAnimationFrame = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  try {
    const {
      formatFeedStatusDisplay,
      buildDataStatusPromptSection,
      applyDataStatusToReport,
      AICopilotController
    } = await import('../public/js/aiCopilot.js');

    const latestSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);

    // 1) Live + NSE->BSE fallback badge & report header
    const bseMeta = {
      source: 'live',
      stale: false,
      provider: 'yahoo:query1',
      latestBarTime: latestSec,
      exchangeTimezone: 'Asia/Kolkata',
      timezone: 'IST',
      resolvedSymbol: 'BSELTD.BO',
      exchange: 'BSE',
      exchangeFallback: true
    };
    const bseDisp = formatFeedStatusDisplay(bseMeta);
    assert.match(bseDisp.badgeText, /BSE\(回退\)/);
    assert.equal(bseDisp.showSimWatermark, false);
    const bseReport = applyDataStatusToReport('正文内容', bseMeta, '1d', latestSec);
    assert.match(bseReport, /自动回退至 BSE/);

    // 2) Stale cache badge, prompt cutoff, and report header
    const staleMeta = {
      source: 'cache',
      stale: true,
      ageMs: 185_000,
      provider: 'yahoo:query2',
      latestBarTime: latestSec,
      exchangeTimezone: 'Asia/Kolkata',
      timezone: 'IST',
      resolvedSymbol: 'RELIANCE.NS',
      exchange: 'NSE',
      exchangeFallback: false
    };
    const staleDisp = formatFeedStatusDisplay(staleMeta);
    assert.match(staleDisp.badgeText, /缓存\(陈旧\)/);
    assert.equal(staleDisp.showSimWatermark, false);
    const stalePrompt = buildDataStatusPromptSection(staleMeta, '1d', latestSec);
    assert.match(stalePrompt, /2026-03-20 15:30:00 IST/);
    assert.match(stalePrompt, /周期：1d/);
    const staleReport = applyDataStatusToReport('正文内容', staleMeta, '1d', latestSec);
    assert.match(staleReport, /^【数据状态提示：当前基于已陈旧缓存数据/);

    // 3) Simulated mode: watermark on, default blocked in AICopilotController.ask(), Demo Mode unlocks while keeping copyable text clean
    const simMeta = {
      source: 'simulated',
      stale: false,
      provider: 'simulated',
      latestBarTime: latestSec,
      exchangeTimezone: 'Asia/Kolkata',
      timezone: 'IST',
      resolvedSymbol: 'RELIANCE.NS',
      exchange: 'NSE'
    };
    const simDisp = formatFeedStatusDisplay(simMeta);
    assert.equal(simDisp.showSimWatermark, true);
    assert.equal(applyDataStatusToReport('纯正文', simMeta, '1d', latestSec), '纯正文');

    const mockCandles = Array.from({ length: 80 }, (_, i) => ({
      time: latestSec - (79 - i) * 86400,
      open: 1300 + i,
      high: 1315 + i,
      low: 1290 + i,
      close: 1305 + i,
      volume: 100000
    }));

    const chatFeed = new MiniNode('div');
    const welcomeEl = new MiniNode('div');
    const mockChart = {
      candles: mockCandles,
      indicators: { emaMap: {}, macd: { macd: [], signal: [], hist: [] } },
      instrument: { symbol: 'RELIANCE.NS', displaySymbol: 'RELIANCE', name: '信实工业', exchange: 'NSE', market: 'in' },
      interval: '1d',
      emaPeriods: [5, 10, 20],
      dataMeta: simMeta,
      captureSnapshot: () => ({ visibleStart: 0, visibleEnd: 79, cleanDataUrl: null }),
      setAIAnnotations: () => {}
    };

    const copilot = new AICopilotController({ chartEngine: mockChart, chatFeedEl: chatFeed, welcomeEl });
    copilot.setDataMeta(simMeta);

    // Default demoMode=false -> MUST block
    const blockedRes = await copilot.ask('分析支撑压力', { autoDraw: false, captureScreenshot: false });
    assert.deepEqual(blockedRes, { blocked: true, reason: 'simulated' });
    assert.ok(chatFeed.querySelector('.chat-error-box'), 'Blocked simulated call must show error notice');
    assert.equal(chatFeed.querySelector('.strict-report-body'), null, 'Blocked call must not produce report card');

    // Enable Demo Mode -> runs analysis, renders sim banner on card, keeps copyable reportText free of simulated disclaimer
    copilot.setDemoMode(true);
    await copilot.ask('演示模式分析', { autoDraw: false, captureScreenshot: false });
    const simCardBanner = chatFeed.querySelector('.ai-notice-sim');
    const reportPre = chatFeed.querySelector('.strict-report-body');
    assert.ok(simCardBanner, 'Demo mode analysis card must display UI sim banner');
    assert.ok(reportPre && reportPre.textContent.length > 20, 'Demo mode analysis must render report text');
    assert.equal(
      /基于模拟数据|仅供演示/.test(reportPre.textContent),
      false,
      'Demo disclaimer must stay in UI banner/watermark and NOT enter copyable reportText'
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLocalStorage;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.fetch = prevFetch;
  }
});

test('HTTP /api/klines, /api/quote, and /api/fundamentals expose complete meta object across live, cache, and simulated states', async () => {
  let now = Date.parse('2026-03-20T10:05:00Z');
  let mode = 'live';
  const fridayCloseSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);

  const svc = createMarketService({
    nowFn: () => now,
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      if (mode === 'down') throw new Error('All upstreams down');
      if (url.includes('BSEONLY.NS')) {
        return { ok: false, status: 404, text: async () => '{}' };
      }
      const sym = url.includes('BSEONLY.BO') ? 'BSEONLY.BO' : 'RELIANCE.NS';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload(sym, 8, fridayCloseSec - 7 * 86400))
      };
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    // 1) LIVE across all 3 endpoints
    const kLive = await httpGetJson(port, '/api/klines?symbol=RELIANCE.NS&interval=1d');
    assert.equal(kLive.status, 200);
    assertCompleteMetaContract(kLive.json.meta, 'live');
    assert.equal(kLive.json.meta.provider, 'yahoo:query1');
    assert.equal(kLive.json.meta.resolvedSymbol, 'RELIANCE.NS');
    assert.equal(kLive.json.meta.exchange, 'NSE');

    const qLive = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d');
    assert.equal(qLive.status, 200);
    assertCompleteMetaContract(qLive.json.meta, 'live');

    // /api/fundamentals hits cached 1d klines -> complete meta with source='cache'
    const fCache = await httpGetJson(port, '/api/fundamentals?symbol=RELIANCE.NS');
    assert.equal(fCache.status, 200);
    assertCompleteMetaContract(fCache.json.meta, 'cache');

    // 2) NSE -> BSE fallback over HTTP
    const bseLive = await httpGetJson(port, '/api/klines?symbol=BSEONLY.NS&interval=1d');
    assert.equal(bseLive.status, 200);
    assertCompleteMetaContract(bseLive.json.meta, 'live');
    assert.equal(bseLive.json.meta.resolvedSymbol, 'BSEONLY.BO');
    assert.equal(bseLive.json.meta.exchange, 'BSE');
    assert.equal(bseLive.json.meta.exchangeFallback, true);

    // 3) CACHE (fresh) across /api/klines and /api/quote
    const kCache = await httpGetJson(port, '/api/klines?symbol=RELIANCE.NS&interval=1d');
    assertCompleteMetaContract(kCache.json.meta, 'cache');
    assert.equal(kCache.json.meta.stale, false);

    const qCache = await httpGetJson(port, '/api/quote?symbol=RELIANCE.NS&interval=1d');
    assertCompleteMetaContract(qCache.json.meta, 'cache');
    assert.equal(qCache.json.meta.stale, false);

    // 4) SIMULATED across all 3 endpoints (uncached symbol while upstream down)
    mode = 'down';
    const kSim = await httpGetJson(port, '/api/klines?symbol=OFFLINE.NS&interval=1d');
    assertCompleteMetaContract(kSim.json.meta, 'simulated');
    assert.equal(kSim.json.meta.provider, 'simulated');

    const qSim = await httpGetJson(port, '/api/quote?symbol=OFFLINE.NS&interval=1d');
    assertCompleteMetaContract(qSim.json.meta, 'simulated');

    const fSim = await httpGetJson(port, '/api/fundamentals?symbol=OFFLINE.NS');
    assertCompleteMetaContract(fSim.json.meta, 'simulated');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('LruTtlCache periodic sweep preserves entries past ttl but within maxStaleMs (virtual clock)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_711_000_000_000 });
  const cache = new LruTtlCache({
    maxEntries: 10,
    defaultTtlMs: 10_000,
    defaultMaxStaleMs: 300_000,
    sweepIntervalMs: 15_000
  });

  try {
    cache.set('k1', { v: 1 }, 10_000, 300_000);
    t.mock.timers.tick(60_000);

    assert.equal(cache.get('k1'), undefined, 'Expired entry must not be returned as fresh');
    const staleHit = cache.getEntry('k1', { allowStale: true, maxStaleMs: 300_000 });
    assert.ok(staleHit, 'Periodic sweep must NOT delete entry past TTL while still within maxStaleMs');
    assert.equal(staleHit.stale, true);
    assert.deepEqual(staleHit.value, { v: 1 });
  } finally {
    cache.destroy();
  }
});

test('LruTtlCache full-capacity set() preserves stale-within-maxStaleMs entries while pruning entries past maxStaleMs', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_711_000_000_000 });
  const cache = new LruTtlCache({
    maxEntries: 3,
    defaultTtlMs: 10_000,
    defaultMaxStaleMs: 300_000
  });

  cache.set('stale_ok', { v: 'keep' }, 10_000, 300_000);
  cache.set('too_old', { v: 'drop' }, 10_000, 20_000);
  cache.set('fresh', { v: 'fresh' }, 100_000, 300_000);

  t.mock.timers.tick(30_000);

  cache.set('new_item', { v: 'new' }, 100_000, 300_000);

  assert.equal(cache.size, 3);
  assert.equal(cache.getEntry('too_old', { allowStale: true, maxStaleMs: 20_000 }), null);
  const retained = cache.getEntry('stale_ok', { allowStale: true, maxStaleMs: 300_000 });
  assert.ok(retained, 'Full-capacity set() must preserve entry still within maxStaleMs');
  assert.equal(retained.stale, true);
  assert.deepEqual(retained.value, { v: 'keep' });
  assert.deepEqual(cache.get('fresh'), { v: 'fresh' });
  assert.deepEqual(cache.get('new_item'), { v: 'new' });
});

test('LruTtlCache purges entries once age exceeds maxStaleMs during periodic sweep', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_711_000_000_000 });
  const cache = new LruTtlCache({
    maxEntries: 10,
    defaultTtlMs: 10_000,
    defaultMaxStaleMs: 60_000,
    sweepIntervalMs: 15_000
  });

  try {
    cache.set('k1', { v: 1 }, 10_000, 60_000);
    t.mock.timers.tick(45_000);
    assert.equal(cache.size, 1, 'Entry must remain retained before maxStaleMs expires');

    t.mock.timers.tick(30_000);
    assert.equal(cache.size, 0, 'Periodic sweep must purge entry after exceeding maxStaleMs');
    assert.equal(cache.getEntry('k1', { allowStale: true, maxStaleMs: 60_000 }), null);
  } finally {
    cache.destroy();
  }
});

test('HTTP /api/klines returns source=cache and stale=true after TTL + periodic sweeps when upstream fails within maxStaleMs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-03-20T10:05:00Z') });
  let upstreamDown = false;
  const fridayCloseSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000);

  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async () => {
      if (upstreamDown) throw new Error('Upstream unavailable');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 6, fridayCloseSec - 5 * 86400))
      };
    }
  });

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    const r1 = await httpGetJson(port, '/api/klines?symbol=RELIANCE.NS&interval=1d');
    assert.equal(r1.status, 200);
    assert.equal(r1.json.meta.source, 'live');
    assert.equal(r1.json.meta.stale, false);

    t.mock.timers.tick(15 * 60 * 1000);
    upstreamDown = true;

    const r2 = await httpGetJson(port, '/api/klines?symbol=RELIANCE.NS&interval=1d');
    assert.equal(r2.status, 200);
    assert.equal(r2.json.source, 'cache', 'HTTP /api/klines must degrade to stale cache instead of simulated');
    assert.equal(r2.json.meta.source, 'cache');
    assert.equal(r2.json.meta.stale, true);
    assert.ok(r2.json.meta.ageMs >= 15 * 60 * 1000);
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('meta.provider reports concrete upstream node (yahoo:query1/query2, binance:data-api/api) across unit and HTTP paths', async () => {
  const makeBinanceRows = () => [
    [1711008000000, '65000', '65500', '64800', '65200', '120.5'],
    [1711094400000, '65200', '66000', '65100', '65900', '145.2']
  ];

  let failYahooQuery1 = false;
  let failBinanceDataApi = false;

  const svc = createMarketService({
    sleepFn: async () => {},
    resilienceConfig: { retry: { maxRetriesPerNode: 0 } },
    fetchFn: async (url) => {
      if (url.includes('query1.finance.yahoo.com')) {
        if (failYahooQuery1) throw new Error('query1 down');
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('RELIANCE.NS', 6)) };
      }
      if (url.includes('query2.finance.yahoo.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeYahooPayload('TCS.NS', 6)) };
      }
      if (url.includes('data-api.binance.vision')) {
        if (failBinanceDataApi) throw new Error('data-api down');
        return { ok: true, status: 200, text: async () => JSON.stringify(makeBinanceRows()) };
      }
      if (url.includes('api.binance.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(makeBinanceRows()) };
      }
      throw new Error(`Unexpected url: ${url}`);
    }
  });

  const y1 = await svc.getKlines('RELIANCE.NS', '1d');
  assert.equal(y1.meta.provider, 'yahoo:query1');

  failYahooQuery1 = true;
  const y2 = await svc.getKlines('TCS.NS', '1d');
  assert.equal(y2.meta.provider, 'yahoo:query2');
  const y2Cached = await svc.getKlines('TCS.NS', '1d');
  assert.equal(y2Cached.meta.source, 'cache');
  assert.equal(y2Cached.meta.provider, 'yahoo:query2');

  const b1 = await svc.getKlines('BTCUSDT', '1d');
  assert.equal(b1.meta.provider, 'binance:data-api');

  failBinanceDataApi = true;
  const b2 = await svc.getKlines('ETHUSDT', '1d');
  assert.equal(b2.meta.provider, 'binance:api');

  const srv = createAppServer({ marketService: svc });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const kHttp = await httpGetJson(port, '/api/klines?symbol=INFY.NS&interval=1d');
    assert.equal(kHttp.status, 200);
    assert.equal(kHttp.json.meta.provider, 'yahoo:query2');

    const qHttp = await httpGetJson(port, '/api/quote?symbol=SOLUSDT&interval=1d');
    assert.equal(qHttp.status, 200);
    assert.equal(qHttp.json.meta.provider, 'binance:api');
  } finally {
    svc.klineCache.destroy();
    svc.quoteCache.destroy();
    svc.fundamentalsCache.destroy();
    svc.simCache.destroy();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
