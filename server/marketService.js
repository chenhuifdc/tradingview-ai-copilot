/**
 * Multi-market real-time data service with:
 * - Step 1: In-memory LRU+TTL cache, Single-Flight coalescing, canonical key normalization,
 *   strict split-adjusted raw OHLC (indicators.quote[0]), and NSE (.NS) -> BSE (.BO) fallback.
 * - Step 2 & 2.1: AbortController timeout, exponential backoff retry, per-node circuit breaker,
 *   maxStaleMs tiered cache degradation (4-day 1d window for weekends/holidays),
 *   and standardized `meta` payload (resolvedSymbol, exchange, latestTradingDay from latestBarTime in IST).
 */

const { SYMBOL_CATALOG, findCatalogItem, searchCatalog } = require('./symbolCatalog');
const { LruTtlCache, CoalescingLruCache, NodeCircuitBreaker } = require('./cache');

const PRICE_BASIS = 'split_adjusted_raw_ohlc';

const INTERVAL_CONFIG = {
  '1m':  { binance: '1m',  yahooInterval: '1m',  yahooRange: '5d',  yahooQuoteRange: '1d',  binanceLimit: 500,  binanceQuoteLimit: 30, sec: 60 },
  '5m':  { binance: '5m',  yahooInterval: '5m',  yahooRange: '1mo', yahooQuoteRange: '5d',  binanceLimit: 500,  binanceQuoteLimit: 30, sec: 300 },
  '15m': { binance: '15m', yahooInterval: '15m', yahooRange: '60d', yahooQuoteRange: '5d',  binanceLimit: 500,  binanceQuoteLimit: 30, sec: 900 },
  '1h':  { binance: '1h',  yahooInterval: '60m', yahooRange: '1y',  yahooQuoteRange: '1mo', binanceLimit: 500,  binanceQuoteLimit: 30, sec: 3600 },
  '4h':  { binance: '4h',  yahooInterval: '60m', yahooRange: '1y',  yahooQuoteRange: '1mo', binanceLimit: 500,  binanceQuoteLimit: 30, sec: 14400 },
  '1d':  { binance: '1d',  yahooInterval: '1d',  yahooRange: '5y',  yahooQuoteRange: '1mo', binanceLimit: 1000, binanceQuoteLimit: 30, sec: 86400 },
  '1w':  { binance: '1w',  yahooInterval: '1wk', yahooRange: '10y', yahooQuoteRange: '6mo', binanceLimit: 500,  binanceQuoteLimit: 30, sec: 604800 }
};

const INTERVAL_ALIASES = {
  '1m': '1m',
  '1min': '1m',
  '5m': '5m',
  '5min': '5m',
  '15m': '15m',
  '15min': '15m',
  '1h': '1h',
  '60m': '1h',
  '4h': '4h',
  '240m': '4h',
  '1d': '1d',
  'd': '1d',
  'day': '1d',
  'daily': '1d',
  '1w': '1w',
  '1wk': '1w',
  'w': '1w',
  'week': '1w',
  'weekly': '1w'
};

const UPSTREAM_NODES = {
  yahoo: [
    { id: 'yahoo:query1', baseUrl: 'https://query1.finance.yahoo.com' },
    { id: 'yahoo:query2', baseUrl: 'https://query2.finance.yahoo.com' }
  ],
  binance: [
    { id: 'binance:data-api', baseUrl: 'https://data-api.binance.vision' },
    { id: 'binance:api', baseUrl: 'https://api.binance.com' }
  ]
};

/**
 * Centralized cache capacity, TTL, and maxStaleMs degradation thresholds.
 */
const CACHE_CONFIG = {
  maxEntries: {
    klines: 120,
    quotes: 200,
    fundamentals: 100,
    simulated: 120
  },
  sweepIntervalMs: 60 * 1000,
  ttlMs: {
    klines: {
      '1m':  15 * 1000,
      '5m':  30 * 1000,
      '15m': 60 * 1000,
      '1h':  2 * 60 * 1000,
      '4h':  5 * 60 * 1000,
      '1d':  10 * 60 * 1000,
      '1w':  30 * 60 * 1000
    },
    quote: {
      '1m':  5 * 1000,
      '5m':  8 * 1000,
      '15m': 10 * 1000,
      '1h':  15 * 1000,
      '4h':  15 * 1000,
      '1d':  15 * 1000,
      '1w':  30 * 60 * 1000
    },
    fundamentals: 5 * 60 * 1000,
    simulated: 30 * 60 * 1000
  },
  maxStaleMs: {
    '1m':  2 * 60 * 1000,               // 2 minutes
    '5m':  5 * 60 * 1000,               // 5 minutes
    '15m': 15 * 60 * 1000,              // 15 minutes
    '1h':  60 * 60 * 1000,              // 1 hour
    '4h':  4 * 60 * 60 * 1000,          // 4 hours
    '1d':  4 * 24 * 60 * 60 * 1000,     // 4 days (96h: covers weekends + Indian public holidays)
    '1w':  7 * 24 * 60 * 60 * 1000      // 7 days
  }
};

/**
 * Centralized timeout, retry with exponential backoff, and per-node circuit breaker policy.
 */
const RESILIENCE_CONFIG = {
  timeoutMs: {
    yahoo: 4500,
    binance: 4000,
    search: 3200,
    fundamentals: 3500
  },
  retry: {
    maxRetriesPerNode: 1,
    baseDelayMs: 120,
    maxDelayMs: 1200,
    backoffFactor: 2
  },
  circuitBreaker: {
    failureThreshold: 3,
    cooldownMs: 30 * 1000
  }
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const UNIQUE_ALIAS_MAP = (() => {
  const counts = new Map();
  const mapping = new Map();

  for (const item of SYMBOL_CATALOG) {
    const perItemKeys = new Set();
    const candidates = [
      ...(Array.isArray(item.aliases) ? item.aliases : []),
      item.koName || ''
    ];
    for (const raw of candidates) {
      const k = String(raw || '').trim().toLowerCase();
      if (k) perItemKeys.add(k);
    }
    for (const k of perItemKeys) {
      counts.set(k, (counts.get(k) || 0) + 1);
      mapping.set(k, item.symbol);
    }
  }

  const unique = new Map();
  for (const [k, count] of counts.entries()) {
    if (count === 1) {
      unique.set(k, mapping.get(k));
    }
  }
  return unique;
})();

function normalizeSymbol(rawSymbol) {
  const trimmed = String(rawSymbol || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'ALKALI.NS';

  const exactCatalog = findCatalogItem(trimmed);
  if (exactCatalog) return exactCatalog.symbol;

  const cryptoMatch = trimmed.match(/^([A-Za-z0-9]{2,12})[/\-_\s]+(USDT|BUSD|USDC)$/i);
  if (cryptoMatch) {
    const joined = `${cryptoMatch[1]}${cryptoMatch[2]}`.toUpperCase();
    const cryptoCatalog = findCatalogItem(joined);
    return cryptoCatalog ? cryptoCatalog.symbol : joined;
  }

  const aliasHit = UNIQUE_ALIAS_MAP.get(trimmed.toLowerCase());
  if (aliasHit) return aliasHit;

  return trimmed.toUpperCase();
}

function normalizeInterval(rawInterval) {
  const cleaned = String(rawInterval || '1d').trim().toLowerCase();
  return INTERVAL_ALIASES[cleaned] || '1d';
}

function inferProvider(symbol) {
  const norm = normalizeSymbol(symbol);
  const catalog = findCatalogItem(norm);
  if (catalog) return catalog.provider;
  if (/^[A-Z0-9]{2,12}(USDT|BUSD|USDC)$/.test(norm)) return 'binance';
  return 'yahoo';
}

function normalizeRange(rawRange, interval, { provider = 'yahoo', mode = 'klines' } = {}) {
  const normIv = normalizeInterval(interval);
  const cfg = INTERVAL_CONFIG[normIv] || INTERVAL_CONFIG['1d'];
  const cleaned = rawRange === undefined || rawRange === null ? '' : String(rawRange).trim().toLowerCase();

  if (provider === 'binance') {
    const defaultLimit = mode === 'quote' ? cfg.binanceQuoteLimit : cfg.binanceLimit;
    if (!cleaned) return `limit=${defaultLimit}`;
    const limMatch = cleaned.match(/^(?:limit=)?(\d+)$/);
    if (limMatch) {
      const n = Math.max(5, Math.min(1000, parseInt(limMatch[1], 10)));
      return `limit=${n}`;
    }
    return cleaned;
  }

  if (cleaned) return cleaned;
  return mode === 'quote' ? cfg.yahooQuoteRange : cfg.yahooRange;
}

function buildMarketCacheKey({ type = 'klines', symbol, interval = '1d', range } = {}) {
  const normType = type === 'quote' ? 'quote' : 'klines';
  const normSymbol = normalizeSymbol(symbol);
  const normInterval = normalizeInterval(interval);
  const provider = inferProvider(normSymbol);
  const normRange = normalizeRange(range, normInterval, { provider, mode: normType });
  return {
    key: `${normType}::${normSymbol}::${normInterval}::${normRange}`,
    type: normType,
    symbol: normSymbol,
    interval: normInterval,
    range: normRange,
    provider
  };
}

function inferMarket(exchange = '', symbol = '') {
  const ex = (exchange || '').toUpperCase();
  const sym = (symbol || '').toUpperCase();
  if (sym.endsWith('USDT') || ex.includes('BINANCE')) return 'crypto';
  if (
    sym.endsWith('.NS') ||
    sym.endsWith('.BO') ||
    sym === '^NSEI' ||
    sym === '^BSESN' ||
    sym === '^NSEBANK' ||
    ex.includes('NSI') ||
    ex.includes('NSE') ||
    ex.includes('BSE') ||
    ex.includes('BOMBAY')
  ) {
    return 'in';
  }
  if (
    sym.endsWith('.KS') ||
    sym.endsWith('.KQ') ||
    sym === '^KS11' ||
    sym === '^KQ11' ||
    ex.includes('KSC') ||
    ex.includes('KOE') ||
    ex.includes('KOSPI') ||
    ex.includes('KOSDAQ') ||
    ex.includes('KOREA') ||
    ex.includes('KRX')
  ) {
    return 'kr';
  }
  if (sym.endsWith('.HK') || ex.includes('HKG') || ex.includes('HKEX')) return 'hk';
  if (sym.endsWith('.SS') || sym.endsWith('.SZ') || ex.includes('SHH') || ex.includes('SHZ')) return 'cn';
  if (sym.endsWith('=X') || sym.endsWith('=F') || ex.includes('CCY') || ex.includes('CMX') || ex.includes('NYM')) return 'forex';
  return 'us';
}

function normalizeExchangeName(exchange = '', symbol = '') {
  const ex = (exchange || '').toUpperCase();
  const sym = (symbol || '').toUpperCase();
  if (sym.endsWith('.KS') || sym === '^KS11' || ex === 'KSC' || ex.includes('KOSPI')) return 'KOSPI';
  if (sym.endsWith('.KQ') || sym === '^KQ11' || ex === 'KOE' || ex.includes('KOSDAQ')) return 'KOSDAQ';
  if (sym.endsWith('.NS') || sym === '^NSEI' || sym === '^NSEBANK' || ex === 'NSI' || ex === 'NSE') return 'NSE';
  if (sym.endsWith('.BO') || sym === '^BSESN' || ex === 'BSE' || ex === 'BOM' || ex.includes('BOMBAY')) return 'BSE';
  return exchange || inferMarket(exchange, symbol).toUpperCase();
}

function cleanDisplaySymbol(symbol = '') {
  return String(symbol || '').replace(/\.(NS|BO|KS|KQ)$/i, '');
}

function formatDateInTimezone(timestampMs, timeZone = 'Asia/Kolkata') {
  try {
    const ts = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ts));
  } catch {
    return new Date(timestampMs || Date.now()).toISOString().slice(0, 10);
  }
}

function getMarketTimezoneInfo(market, yahooTimezoneName = '') {
  if (market === 'in') {
    return { exchangeTimezone: 'Asia/Kolkata', timezone: 'IST', utcOffset: '+05:30' };
  }
  if (market === 'kr') {
    return { exchangeTimezone: 'Asia/Seoul', timezone: 'KST', utcOffset: '+09:00' };
  }
  if (market === 'hk') {
    return { exchangeTimezone: 'Asia/Hong_Kong', timezone: 'HKT', utcOffset: '+08:00' };
  }
  if (market === 'cn') {
    return { exchangeTimezone: 'Asia/Shanghai', timezone: 'CST', utcOffset: '+08:00' };
  }
  if (market === 'crypto') {
    return { exchangeTimezone: 'UTC', timezone: 'UTC', utcOffset: '+00:00' };
  }
  return {
    exchangeTimezone: yahooTimezoneName || 'America/New_York',
    timezone: 'ET',
    utcOffset: '-05:00'
  };
}

function buildResponseMeta({
  source,
  fetchedAt,
  now,
  stale = false,
  provider,
  priceBasis = PRICE_BASIS,
  latestBarTime = null,
  market = 'in',
  yahooTimezoneName = '',
  resolvedSymbol = '',
  exchange = '',
  requestedSymbol = ''
}) {
  const safeFetchedAt = Number.isFinite(fetchedAt) ? fetchedAt : now;
  const ageMs = source === 'live' || source === 'simulated' ? 0 : Math.max(0, now - safeFetchedAt);
  const tzInfo = getMarketTimezoneInfo(market, yahooTimezoneName);
  const hasBarTime = Number.isFinite(latestBarTime) && latestBarTime > 0;
  const finalResolvedSymbol = resolvedSymbol || requestedSymbol || '';
  const finalExchange = exchange || (finalResolvedSymbol ? normalizeExchangeName('', finalResolvedSymbol) : '');
  const exchangeFallback = Boolean(
    requestedSymbol &&
    finalResolvedSymbol &&
    requestedSymbol.toUpperCase() !== finalResolvedSymbol.toUpperCase()
  );

  return {
    source,
    fetchedAt: safeFetchedAt,
    ageMs,
    stale: source === 'cache' ? Boolean(stale) : false,
    provider: provider || (source === 'simulated' ? 'simulated' : 'unknown'),
    priceBasis,
    resolvedSymbol: finalResolvedSymbol || null,
    exchange: finalExchange || null,
    exchangeFallback,
    latestBarTime: hasBarTime ? latestBarTime : null,
    exchangeTimezone: tzInfo.exchangeTimezone,
    timezone: tzInfo.timezone,
    utcOffset: tzInfo.utcOffset,
    latestTradingDay: hasBarTime ? formatDateInTimezone(latestBarTime * 1000, tzInfo.exchangeTimezone) : null
  };
}

function aggregateCandles(candles, factor) {
  if (factor <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const slice = candles.slice(i, i + factor);
    if (!slice.length) continue;
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((acc, c) => acc + c.volume, 0)
    });
  }
  return out;
}

function seededRandom(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getPricePrecision(price) {
  if (price >= 1000) return 2;
  if (price >= 10) return 2;
  if (price >= 1) return 3;
  return 4;
}

function roundPrice(val, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(val * factor) / factor;
}

function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, '')
    .trim();
}

function calcSimpleEmaLast(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcSimpleSmaLast(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

function computeDailySupplyDemandZones(candles) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { supports: [], resistances: [] };
  }
  const recent = candles.slice(-140);
  const lastClose = recent[recent.length - 1].close;
  const highs = [];
  const lows = [];
  for (let i = 4; i < recent.length - 4; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - 4; j <= i + 4; j++) {
      if (j === i) continue;
      if (recent[j].high > recent[i].high) isH = false;
      if (recent[j].low < recent[i].low) isL = false;
    }
    if (isH) highs.push(recent[i].high);
    if (isL) lows.push(recent[i].low);
  }
  const cluster = (vals) => {
    const out = [];
    for (const v of vals) {
      const hit = out.find((c) => Math.abs(c.price - v) / Math.max(v, 1e-6) <= 0.025);
      if (hit) {
        hit.count += 1;
        hit.price = (hit.price * (hit.count - 1) + v) / hit.count;
      } else {
        out.push({ price: v, count: 1 });
      }
    }
    return out;
  };
  const supports = cluster(lows)
    .filter((c) => c.price <= lastClose * 1.005)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3)
    .map((c) => Number(c.price.toFixed(getPricePrecision(c.price))));
  const resistances = cluster(highs)
    .filter((c) => c.price >= lastClose * 0.995)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((c) => Number(c.price.toFixed(getPricePrecision(c.price))));
  return { supports, resistances };
}

function mergeCacheConfig(overrides = {}) {
  return {
    maxEntries: { ...CACHE_CONFIG.maxEntries, ...(overrides.maxEntries || {}) },
    sweepIntervalMs: overrides.sweepIntervalMs ?? CACHE_CONFIG.sweepIntervalMs,
    ttlMs: {
      klines: { ...CACHE_CONFIG.ttlMs.klines, ...(overrides.ttlMs?.klines || {}) },
      quote: { ...CACHE_CONFIG.ttlMs.quote, ...(overrides.ttlMs?.quote || {}) },
      fundamentals: overrides.ttlMs?.fundamentals ?? CACHE_CONFIG.ttlMs.fundamentals,
      simulated: overrides.ttlMs?.simulated ?? CACHE_CONFIG.ttlMs.simulated
    },
    maxStaleMs: { ...CACHE_CONFIG.maxStaleMs, ...(overrides.maxStaleMs || {}) }
  };
}

function mergeResilienceConfig(overrides = {}) {
  return {
    timeoutMs: { ...RESILIENCE_CONFIG.timeoutMs, ...(overrides.timeoutMs || {}) },
    retry: { ...RESILIENCE_CONFIG.retry, ...(overrides.retry || {}) },
    circuitBreaker: { ...RESILIENCE_CONFIG.circuitBreaker, ...(overrides.circuitBreaker || {}) }
  };
}

function createMarketService({
  fetchFn = globalThis.fetch,
  nowFn = () => Date.now(),
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  cacheConfig = {},
  resilienceConfig = {}
} = {}) {
  const cfg = mergeCacheConfig(cacheConfig);
  const resCfg = mergeResilienceConfig(resilienceConfig);

  const klineCache = new CoalescingLruCache({
    maxEntries: cfg.maxEntries.klines,
    nowFn,
    sweepIntervalMs: cfg.sweepIntervalMs
  });
  const quoteCache = new CoalescingLruCache({
    maxEntries: cfg.maxEntries.quotes,
    nowFn,
    sweepIntervalMs: cfg.sweepIntervalMs
  });
  const fundamentalsCache = new CoalescingLruCache({
    maxEntries: cfg.maxEntries.fundamentals,
    nowFn,
    sweepIntervalMs: cfg.sweepIntervalMs
  });
  const simCache = new LruTtlCache({
    maxEntries: cfg.maxEntries.simulated,
    nowFn,
    sweepIntervalMs: cfg.sweepIntervalMs
  });
  const circuitBreaker = new NodeCircuitBreaker({
    failureThreshold: resCfg.circuitBreaker.failureThreshold,
    cooldownMs: resCfg.circuitBreaker.cooldownMs,
    nowFn
  });

  async function fetchTextWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err = new Error(`Upstream request timed out after ${timeoutMs}ms`);
        err.name = 'AbortError';
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
    });

    try {
      const res = await Promise.race([
        fetchFn(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            ...(options.headers || {})
          }
        }),
        timeoutPromise
      ]);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        if (res.status === 404) err.isSymbolNotFound = true;
        throw err;
      }
      return await Promise.race([res.text(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 4500) {
    const text = await fetchTextWithTimeout(
      url,
      { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } },
      timeoutMs
    );
    return JSON.parse(text);
  }

  async function executeWithResilience(provider, buildUrlFn, parseFn, timeoutMs) {
    const nodes = UPSTREAM_NODES[provider];
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error(`Unknown upstream provider: ${provider}`);
    }

    let lastErr = null;
    let attemptedNodes = 0;

    for (const node of nodes) {
      const check = circuitBreaker.canAttempt(node.id);
      if (!check.allowed) {
        continue;
      }

      attemptedNodes += 1;
      const maxAttempts = check.halfOpenProbe
        ? 1
        : 1 + Math.max(0, Number(resCfg.retry.maxRetriesPerNode) || 0);

      let nodeErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          const delayMs = Math.min(
            resCfg.retry.maxDelayMs,
            resCfg.retry.baseDelayMs * Math.pow(resCfg.retry.backoffFactor, attempt - 1)
          );
          await sleepFn(delayMs, { nodeId: node.id, attempt });
        }

        try {
          const url = buildUrlFn(node);
          const raw = await fetchJsonWithTimeout(url, {}, timeoutMs);
          const parsed = parseFn(raw, node);
          circuitBreaker.recordSuccess(node.id);
          return {
            ...parsed,
            providerNode: node.id
          };
        } catch (err) {
          if (err?.isSymbolNotFound) {
            throw err;
          }
          nodeErr = err;
        }
      }

      circuitBreaker.recordFailure(node.id, nodeErr);
      lastErr = nodeErr;
    }

    if (attemptedNodes === 0) {
      const cbErr = new Error(`All ${provider} upstream nodes are temporarily circuit-broken`);
      cbErr.code = 'CIRCUIT_OPEN';
      throw cbErr;
    }
    throw lastErr || new Error(`${provider} upstream API unreachable`);
  }

  async function searchSymbols(query, market = 'all') {
    const q = (query || '').trim();
    const localMatches = searchCatalog(q, market);
    if (!q || q.length < 1) {
      return { results: localMatches, remoteOnline: true };
    }

    let remoteResults = [];
    let remoteOnline = false;

    const hasCJK = /[\u4e00-\u9fff]/.test(q);
    const hasHangul = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(q);
    const looksLikeCnOrKrCode = /^\d{5,6}$/.test(q);

    const mapYahooQuote = (item) => {
      const sym = item.symbol;
      const mkt = inferMarket(item.exchange, sym);
      const typeMap = {
        EQUITY: mkt === 'kr' ? '韩股' : mkt === 'in' ? '印股' : '股票',
        ETF: 'ETF',
        INDEX: '指数',
        CRYPTOCURRENCY: '加密货币',
        CURRENCY: '外汇',
        FUTURE: '期货'
      };
      const currencyMap = { in: 'INR', kr: 'KRW', hk: 'HKD', cn: 'CNY', us: 'USD' };
      return {
        symbol: sym,
        displaySymbol: cleanDisplaySymbol(sym),
        name: item.shortname || item.longname || sym,
        enName: item.longname || item.shortname || sym,
        exchange: normalizeExchangeName(item.exchDisp || item.exchange, sym),
        market: mkt,
        type: typeMap[item.quoteType] || '证券',
        currency: currencyMap[mkt] || '',
        provider: sym.endsWith('-USD') ? 'yahoo' : inferProvider(sym)
      };
    };

    // 1) Yahoo Finance global search (routed through executeWithResilience for timeout, retry, failover, and circuit breaker)
    const yahooPromise = (async () => {
      if (hasCJK || hasHangul) return [];
      const queries = [q];
      if (market === 'in' && /^[A-Za-z0-9&-]{2,15}$/.test(q) && !q.includes('.')) {
        queries.push(`${q}.NS`);
      }
      const batches = await Promise.allSettled(
        queries.map((term) =>
          executeWithResilience(
            'yahoo',
            (node) =>
              `${node.baseUrl}/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=14&newsCount=0&enableFuzzyQuery=true`,
            (data) => ({ quotes: Array.isArray(data?.quotes) ? data.quotes : [] }),
            resCfg.timeoutMs.search
          )
        )
      );
      const anyFulfilled = batches.some((b) => b.status === 'fulfilled');
      if (!anyFulfilled) {
        const firstErr = batches.find((b) => b.status === 'rejected')?.reason;
        throw firstErr || new Error('Yahoo search unavailable');
      }
      const out = [];
      for (const res of batches) {
        if (res.status !== 'fulfilled') continue;
        for (const item of res.value.quotes) {
          if (item && item.symbol && item.quoteType !== 'OPTION') {
            out.push(mapYahooQuote(item));
          }
        }
      }
      return out;
    })();

    // 2) Naver Finance Korean stock search (KOSPI & KOSDAQ)
    const naverPromise = (async () => {
      const shouldQueryNaver =
        hasHangul ||
        market === 'kr' ||
        (looksLikeCnOrKrCode && (market === 'all' || market === 'kr'));
      if (!shouldQueryNaver || hasCJK) return [];
      const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`;
      const data = await fetchJsonWithTimeout(url, {}, resCfg.timeoutMs.search);
      const items = Array.isArray(data?.items) ? data.items : [];
      const mapped = [];
      for (const it of items) {
        if (!it || it.nationCode !== 'KOR') continue;
        const code = String(it.code || '').trim().toUpperCase();
        const exType = String(it.typeCode || '').toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) continue;
        if (exType !== 'KOSPI' && exType !== 'KOSDAQ') continue;
        const suffix = exType === 'KOSDAQ' ? '.KQ' : '.KS';
        mapped.push({
          symbol: `${code}${suffix}`,
          displaySymbol: code,
          name: it.name || code,
          enName: `${it.name} (${exType})`,
          koName: it.name || code,
          exchange: exType,
          market: 'kr',
          type: '韩股',
          currency: 'KRW',
          provider: 'yahoo'
        });
      }
      return mapped;
    })();

    // 3) Eastmoney Chinese stock search (A-shares, HK, US Chinese names)
    const eastmoneyPromise = (async () => {
      if ((!hasCJK && !looksLikeCnOrKrCode) || market === 'in' || market === 'kr') return [];
      const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
      const data = await fetchJsonWithTimeout(url, {}, resCfg.timeoutMs.search);
      const rows = Array.isArray(data?.QuotationCodeTable?.Data) ? data.QuotationCodeTable.Data : [];
      const mapped = [];
      for (const r of rows) {
        const code = String(r.Code || '').trim();
        if (!code) continue;
        if (r.Classify === 'AStock') {
          const isSH = String(r.MktNum) === '1' || code.startsWith('6');
          const suffix = isSH ? '.SS' : '.SZ';
          mapped.push({
            symbol: `${code}${suffix}`,
            displaySymbol: code,
            name: r.Name || code,
            enName: `${r.Name} (${r.PinYin || code})`,
            exchange: isSH ? 'SSE' : 'SZSE',
            market: 'cn',
            type: 'A股',
            currency: 'CNY',
            provider: 'yahoo'
          });
        } else if (r.Classify === 'HK' && /^\d{4,5}$/.test(code)) {
          const hk4 = code.length === 5 && code.startsWith('0') ? code.slice(1) : code.padStart(4, '0');
          mapped.push({
            symbol: `${hk4}.HK`,
            displaySymbol: `${hk4}.HK`,
            name: r.Name || hk4,
            enName: `${r.Name} (HKEX)`,
            exchange: 'HKEX',
            market: 'hk',
            type: '港股',
            currency: 'HKD',
            provider: 'yahoo'
          });
        } else if (r.Classify === 'UsStock' && /^[A-Za-z.]{1,8}$/.test(code)) {
          mapped.push({
            symbol: code.toUpperCase(),
            displaySymbol: code.toUpperCase(),
            name: r.Name || code.toUpperCase(),
            enName: r.Name || code.toUpperCase(),
            exchange: r.JYS || 'US',
            market: 'us',
            type: '美股',
            currency: 'USD',
            provider: 'yahoo'
          });
        }
      }
      return mapped;
    })();

    const [yahooRes, naverRes, emRes] = await Promise.allSettled([yahooPromise, naverPromise, eastmoneyPromise]);
    if (yahooRes.status === 'fulfilled' && yahooRes.value.length) {
      remoteOnline = true;
      remoteResults.push(...yahooRes.value);
    } else if (yahooRes.status === 'fulfilled' && !hasCJK && !hasHangul) {
      remoteOnline = true;
    }
    if (naverRes.status === 'fulfilled' && naverRes.value.length) {
      remoteOnline = true;
      remoteResults.push(...naverRes.value);
    } else if (naverRes.status === 'fulfilled' && (hasHangul || market === 'kr')) {
      remoteOnline = true;
    }
    if (emRes.status === 'fulfilled' && emRes.value.length) {
      remoteOnline = true;
      remoteResults.push(...emRes.value);
    } else if (emRes.status === 'fulfilled' && (hasCJK || looksLikeCnOrKrCode)) {
      remoteOnline = true;
    }

    // Synthesize Binance crypto pair candidate when query looks like ASCII ticker
    const upperQ = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if ((market === 'all' || market === 'crypto') && upperQ.length >= 2 && upperQ.length <= 12) {
      const candidateSym = upperQ.endsWith('USDT') ? upperQ : `${upperQ}USDT`;
      const alreadyExists = localMatches.some((i) => i.symbol.toUpperCase() === candidateSym);
      if (!alreadyExists && /^[A-Z0-9]+USDT$/.test(candidateSym) && upperQ.length <= 10 && /^[a-zA-Z0-9/]+$/.test(q)) {
        remoteResults.push({
          symbol: candidateSym,
          displaySymbol: candidateSym.replace('USDT', '/USDT'),
          name: `${candidateSym.replace('USDT', '')} / TetherUS`,
          enName: `${candidateSym.replace('USDT', '')} / USDT`,
          exchange: 'BINANCE',
          market: 'crypto',
          type: '加密货币',
          currency: 'USDT',
          provider: 'binance'
        });
      }
    }

    // Merge and deduplicate (local catalog items first)
    const seen = new Set();
    const merged = [];
    for (const item of [...localMatches, ...remoteResults]) {
      const key = item.symbol.toUpperCase();
      if (seen.has(key)) continue;
      if (market !== 'all' && item.market !== market) continue;
      seen.add(key);
      merged.push(item);
    }

    // Direct symbol fallback candidates for India NSE/BSE, Korea KOSPI/KOSDAQ, or generic tickers
    if (merged.length === 0 && market === 'in' && /^[A-Za-z0-9&-]{2,15}$/.test(q)) {
      const rawIn = q.toUpperCase().replace(/\.(NS|BO)$/i, '');
      merged.push(
        {
          symbol: `${rawIn}.NS`,
          displaySymbol: rawIn,
          name: `${rawIn} (NSE 印度直连)`,
          enName: `${rawIn} (NSE India)`,
          exchange: 'NSE',
          market: 'in',
          type: '印股',
          currency: 'INR',
          provider: 'yahoo'
        },
        {
          symbol: `${rawIn}.BO`,
          displaySymbol: rawIn,
          name: `${rawIn} (BSE 孟买直连)`,
          enName: `${rawIn} (BSE India)`,
          exchange: 'BSE',
          market: 'in',
          type: '印股',
          currency: 'INR',
          provider: 'yahoo'
        }
      );
    } else if (merged.length === 0 && market === 'kr' && /^\d{6}$/.test(q)) {
      merged.push(
        {
          symbol: `${q}.KS`,
          displaySymbol: q,
          name: `${q} (KOSPI 韩国主板)`,
          enName: `${q} (KOSPI)`,
          exchange: 'KOSPI',
          market: 'kr',
          type: '韩股',
          currency: 'KRW',
          provider: 'yahoo'
        },
        {
          symbol: `${q}.KQ`,
          displaySymbol: q,
          name: `${q} (KOSDAQ 韩国创业板)`,
          enName: `${q} (KOSDAQ)`,
          exchange: 'KOSDAQ',
          market: 'kr',
          type: '韩股',
          currency: 'KRW',
          provider: 'yahoo'
        }
      );
    } else if (merged.length === 0 && /^[A-Za-z0-9.^=-]{1,15}$/.test(q)) {
      const rawSym = q.toUpperCase();
      const inferredMkt = inferMarket('', rawSym);
      merged.push({
        symbol: rawSym,
        displaySymbol: cleanDisplaySymbol(rawSym),
        name: `${rawSym} (直接加载代码)`,
        enName: rawSym,
        exchange: normalizeExchangeName('', rawSym),
        market: inferredMkt,
        type: inferredMkt === 'kr' ? '韩股' : inferredMkt === 'in' ? '印股' : '股票',
        currency: inferredMkt === 'kr' ? 'KRW' : inferredMkt === 'in' ? 'INR' : 'USD',
        provider: inferProvider(rawSym)
      });
    }

    return { results: merged.slice(0, 30), remoteOnline };
  }

  async function fetchBinanceKlines(symbol, interval, limit = 1000) {
    const ivCfg = INTERVAL_CONFIG[interval] || INTERVAL_CONFIG['1d'];
    const cleanSym = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

    return executeWithResilience(
      'binance',
      (node) => `${node.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(cleanSym)}&interval=${ivCfg.binance}&limit=${limit}`,
      (raw, node) => {
        if (!Array.isArray(raw) || raw.length < 2) {
          throw new Error('Empty kline array');
        }
        const candles = raw.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        }));
        return {
          candles,
          events: [],
          source: 'live',
          feedName: `Binance Real-Time (${node.id})`,
          priceBasis: PRICE_BASIS,
          wsSymbol: cleanSym.toLowerCase(),
          wsInterval: ivCfg.binance
        };
      },
      resCfg.timeoutMs.binance
    );
  }

  async function fetchYahooKlinesSingle(symbol, interval, customRange = null) {
    const ivCfg = INTERVAL_CONFIG[interval] || INTERVAL_CONFIG['1d'];
    const effectiveRange = customRange || ivCfg.yahooRange;

    return executeWithResilience(
      'yahoo',
      (node) =>
        `${node.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${ivCfg.yahooInterval}&range=${encodeURIComponent(effectiveRange)}&events=div,earn&includePrePost=false`,
      (data, node) => {
        const chartErr = data?.chart?.error;
        if (chartErr) {
          const err = new Error(chartErr.description || chartErr.code || 'Yahoo chart error');
          if (/not found|no data found|delisted/i.test(`${chartErr.code || ''} ${chartErr.description || ''}`)) {
            err.isSymbolNotFound = true;
          }
          throw err;
        }

        const result = data?.chart?.result?.[0];
        if (!result || !Array.isArray(result.timestamp) || !result.indicators?.quote?.[0]) {
          throw new Error('Malformed Yahoo Finance response');
        }

        const timestamps = result.timestamp;
        // Strictly use split-adjusted raw OHLC quote[0]; NEVER use dividend-adjusted result.indicators.adjclose
        const q = result.indicators.quote[0];
        let candles = [];
        for (let i = 0; i < timestamps.length; i++) {
          const o = q.open?.[i];
          const h = q.high?.[i];
          const l = q.low?.[i];
          const c = q.close?.[i];
          const v = q.volume?.[i] ?? 0;
          if (o == null || h == null || l == null || c == null) continue;
          if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
          candles.push({
            time: timestamps[i],
            open: Number(o),
            high: Number(h),
            low: Number(l),
            close: Number(c),
            volume: Number(v) || 0
          });
        }

        if (interval === '4h') {
          candles = aggregateCandles(candles, 4);
        }

        if (candles.length < 2) {
          const err = new Error('Too few candles');
          if (timestamps.length === 0) err.isSymbolNotFound = true;
          throw err;
        }

        const events = [];
        const divs = result.events?.dividends || {};
        for (const key of Object.keys(divs)) {
          const d = divs[key];
          if (d?.date) {
            events.push({ time: d.date, type: 'D', label: `分红 ${d.amount ?? ''}`.trim() });
          }
        }
        const earns = result.events?.earnings || {};
        for (const key of Object.keys(earns)) {
          const e = earns[key];
          if (e?.date) {
            events.push({ time: e.date, type: 'E', label: '财报发布' });
          }
        }

        const meta = result.meta || {};
        return {
          resolvedSymbol: symbol,
          candles: candles.slice(-1250),
          events,
          meta: {
            currency: meta.currency || '',
            exchangeName: meta.exchangeName || '',
            exchangeTimezoneName: meta.exchangeTimezoneName || '',
            regularMarketPrice: meta.regularMarketPrice,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
            shortName: meta.shortName || meta.longName || ''
          },
          priceBasis: PRICE_BASIS,
          source: 'live',
          feedName: `Yahoo Finance Real-Time (${node.id})`
        };
      },
      resCfg.timeoutMs.yahoo
    );
  }

  async function fetchYahooKlines(symbol, interval, customRange = null) {
    try {
      return await fetchYahooKlinesSingle(symbol, interval, customRange);
    } catch (err) {
      if (err?.isSymbolNotFound && /\.NS$/i.test(symbol)) {
        const bseSymbol = symbol.replace(/\.NS$/i, '.BO');
        return fetchYahooKlinesSingle(bseSymbol, interval, customRange);
      }
      throw err;
    }
  }

  function generateSimulatedSeries(symbol, interval) {
    const normSym = normalizeSymbol(symbol);
    const normIv = normalizeInterval(interval);
    const key = `${normSym}::${normIv}`;
    const ivCfg = INTERVAL_CONFIG[normIv] || INTERVAL_CONFIG['1d'];
    const nowSec = Math.floor(nowFn() / 1000);
    const alignedNow = Math.floor(nowSec / ivCfg.sec) * ivCfg.sec;

    const existing = simCache.get(key);
    if (existing) {
      return existing;
    }

    const catalog = findCatalogItem(normSym);
    const rng = seededRandom(`${normSym}_${normIv}_v2`);
    const count = 210;
    const basePrice = catalog?.basePrice || (35 + rng() * 240);
    const baseVol = catalog?.volatility || 0.022;
    const intervalScale =
      normIv === '1m' ? 0.16 :
      normIv === '5m' ? 0.28 :
      normIv === '15m' ? 0.42 :
      normIv === '1h' ? 0.62 :
      normIv === '4h' ? 0.82 :
      normIv === '1w' ? 1.55 : 1.0;
    const stepVol = baseVol * intervalScale;
    const precision = getPricePrecision(basePrice);

    const isAlkaliDemo = catalog?.profile === 'alkali_demo' && normIv === '1d';
    const targetPath = [];

    if (isAlkaliDemo) {
      const keyframes = [
        [0, 88.5], [18, 82.0], [32, 76.2], [50, 77.8], [62, 68.5],
        [78, 66.2], [95, 47.4], [103, 68.4], [116, 65.8], [126, 62.0],
        [135, 100.8], [146, 85.4], [160, 82.0], [168, 66.8], [180, 64.5],
        [187, 78.2], [191, 104.2], [198, 92.6], [203, 78.8], [209, 76.41]
      ];
      for (let i = 0; i < count; i++) {
        let k = 0;
        while (k < keyframes.length - 2 && i > keyframes[k + 1][0]) k++;
        const [x0, y0] = keyframes[k];
        const [x1, y1] = keyframes[k + 1];
        const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
        const st = t * t * (3 - 2 * t);
        targetPath.push(y0 + (y1 - y0) * st);
      }
    } else {
      const anchors = [];
      const segments = 9;
      let level = basePrice * (0.76 + rng() * 0.22);
      for (let s = 0; s <= segments; s++) {
        const idx = Math.round((s / segments) * (count - 1));
        if (s === segments) level = basePrice;
        else if (s > 0) {
          const swing = (rng() - 0.44) * basePrice * 0.24 * intervalScale;
          level = Math.max(basePrice * 0.52, Math.min(basePrice * 1.42, level + swing));
        }
        anchors.push([idx, level]);
      }
      for (let i = 0; i < count; i++) {
        let k = 0;
        while (k < anchors.length - 2 && i > anchors[k + 1][0]) k++;
        const [x0, y0] = anchors[k];
        const [x1, y1] = anchors[k + 1];
        const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
        const st = t * t * (3 - 2 * t);
        targetPath.push(y0 + (y1 - y0) * st);
      }
    }

    const candles = [];
    let prevClose = targetPath[0];
    const baseVolume = basePrice > 5000 ? 18000 : basePrice > 200 ? 450000 : 120000;

    for (let i = 0; i < count; i++) {
      const time = alignedNow - (count - 1 - i) * ivCfg.sec;
      const guide = targetPath[i];
      const noise = (rng() - 0.5) * guide * stepVol * 1.65;
      const open = i === 0 ? roundPrice(guide, precision) : prevClose;
      const rawClose = i === count - 1 ? targetPath[i] : guide + noise;
      const close = roundPrice(Math.max(basePrice * 0.25, rawClose), precision);
      const bodyMax = Math.max(open, close);
      const bodyMin = Math.min(open, close);
      const bodyRange = Math.max(bodyMax - bodyMin, guide * stepVol * 0.18);
      const high = roundPrice(bodyMax + bodyRange * (0.4 + rng() * 0.8), precision);
      const low = roundPrice(Math.max(basePrice * 0.2, bodyMin - bodyRange * (0.4 + rng() * 0.8)), precision);
      const volume = Math.round(baseVolume * (0.6 + rng() * 1.4));
      candles.push({ time, open, high, low, close, volume });
      prevClose = close;
    }

    const result = {
      resolvedSymbol: normSym,
      candles,
      events: [],
      priceBasis: PRICE_BASIS,
      source: 'simulated',
      feedName: '实时模拟行情 (离线回退)'
    };
    simCache.set(key, result, cfg.ttlMs.simulated);
    return result;
  }

  function formatKlineOutput(rawPayload, { keyInfo, fromCache = false, coalesced = false, stale = false, fetchedAt, ageMs = 0 }) {
    const now = nowFn();
    const resolvedSym = rawPayload.resolvedSymbol || keyInfo.symbol;
    const catalog = findCatalogItem(resolvedSym) || findCatalogItem(keyInfo.symbol);
    const resolvedMkt = inferMarket(rawPayload.meta?.exchangeName, resolvedSym);
    const resolvedExchange = normalizeExchangeName(rawPayload.meta?.exchangeName, resolvedSym) || catalog?.exchange || 'NSE';

    const resolvedInfo = catalog
      ? {
          ...catalog,
          symbol: resolvedSym,
          exchange: resolvedExchange
        }
      : {
          symbol: resolvedSym,
          displaySymbol: cleanDisplaySymbol(resolvedSym),
          name: rawPayload.meta?.shortName || resolvedSym,
          enName: rawPayload.meta?.shortName || resolvedSym,
          exchange: resolvedExchange,
          market: resolvedMkt,
          type: keyInfo.provider === 'binance' ? '加密货币' : resolvedMkt === 'kr' ? '韩股' : resolvedMkt === 'in' ? '印股' : '股票',
          currency:
            rawPayload.meta?.currency ||
            (keyInfo.provider === 'binance' ? 'USDT' : resolvedMkt === 'kr' ? 'KRW' : resolvedMkt === 'in' ? 'INR' : 'USD'),
          provider: keyInfo.provider
        };

    const effectiveSource = rawPayload.source === 'simulated'
      ? 'simulated'
      : (fromCache || stale)
        ? 'cache'
        : 'live';

    const lastBar = rawPayload.candles?.[rawPayload.candles.length - 1];
    const meta = buildResponseMeta({
      source: effectiveSource,
      fetchedAt: fetchedAt ?? now,
      now,
      stale,
      provider: rawPayload.source === 'simulated' ? 'simulated' : (rawPayload.providerNode || keyInfo.provider),
      priceBasis: rawPayload.priceBasis || PRICE_BASIS,
      latestBarTime: lastBar?.time ?? null,
      market: resolvedMkt,
      yahooTimezoneName: rawPayload.meta?.exchangeTimezoneName || '',
      resolvedSymbol: resolvedSym,
      exchange: resolvedExchange,
      requestedSymbol: keyInfo.symbol
    });

    return {
      instrument: resolvedInfo,
      interval: keyInfo.interval,
      candles: rawPayload.candles,
      events: rawPayload.events || [],
      source: effectiveSource,
      feedName: rawPayload.feedName,
      priceBasis: meta.priceBasis,
      wsSymbol: rawPayload.wsSymbol || null,
      wsInterval: rawPayload.wsInterval || null,
      fallbackReason: rawPayload.fallbackReason || null,
      cacheHit: Boolean(fromCache || stale),
      coalesced: Boolean(coalesced),
      meta,
      serverTime: now
    };
  }

  async function getKlines(symbol, interval = '1d', range = undefined) {
    const keyInfo = buildMarketCacheKey({ type: 'klines', symbol, interval, range });
    const ttlMs = cfg.ttlMs.klines[keyInfo.interval] || cfg.ttlMs.klines['1d'];
    const maxStaleMs = cfg.maxStaleMs[keyInfo.interval] || cfg.maxStaleMs['1d'];

    try {
      const loaded = await klineCache.getOrLoad(
        keyInfo.key,
        async () => {
          if (keyInfo.provider === 'binance') {
            const lim = parseInt(String(keyInfo.range).replace('limit=', ''), 10) || 500;
            return fetchBinanceKlines(keyInfo.symbol, keyInfo.interval, lim);
          }
          return fetchYahooKlines(keyInfo.symbol, keyInfo.interval, keyInfo.range);
        },
        ttlMs,
        maxStaleMs
      );

      return formatKlineOutput(loaded.value, {
        keyInfo,
        fromCache: loaded.fromCache,
        coalesced: loaded.coalesced,
        stale: false,
        fetchedAt: loaded.createdAt,
        ageMs: loaded.ageMs
      });
    } catch (err) {
      // Tier 2 fallback: check if stale cache within maxStaleMs exists
      const staleHit = klineCache.getEntry(keyInfo.key, { allowStale: true, maxStaleMs });
      if (staleHit) {
        return formatKlineOutput(staleHit.value, {
          keyInfo,
          fromCache: true,
          coalesced: false,
          stale: true,
          fetchedAt: staleHit.createdAt,
          ageMs: staleHit.ageMs
        });
      }

      // Tier 3 final fallback: simulated series
      const sim = generateSimulatedSeries(keyInfo.symbol, keyInfo.interval);
      sim.fallbackReason = err?.message || 'External market API unreachable';
      return formatKlineOutput(sim, {
        keyInfo,
        fromCache: false,
        coalesced: false,
        stale: false,
        fetchedAt: nowFn(),
        ageMs: 0
      });
    }
  }

  async function getLatestTick(symbol, interval = '1d', range = undefined) {
    const keyInfo = buildMarketCacheKey({ type: 'quote', symbol, interval, range });
    const klineKeyInfo = buildMarketCacheKey({ type: 'klines', symbol, interval, range });
    const ttlMs = cfg.ttlMs.quote[keyInfo.interval] || cfg.ttlMs.quote['1d'];
    const maxStaleMs = cfg.maxStaleMs[keyInfo.interval] || cfg.maxStaleMs['1d'];

    try {
      const loaded = await quoteCache.getOrLoad(
        keyInfo.key,
        async () => {
          if (keyInfo.provider === 'binance') {
            const lim = parseInt(String(keyInfo.range).replace('limit=', ''), 10) || 30;
            return fetchBinanceKlines(keyInfo.symbol, keyInfo.interval, lim);
          }
          return fetchYahooKlines(keyInfo.symbol, keyInfo.interval, keyInfo.range);
        },
        ttlMs,
        maxStaleMs
      );

      const formatted = formatKlineOutput(loaded.value, {
        keyInfo,
        fromCache: loaded.fromCache,
        coalesced: loaded.coalesced,
        stale: false,
        fetchedAt: loaded.createdAt,
        ageMs: loaded.ageMs
      });
      const last = formatted.candles[formatted.candles.length - 1];
      const prev = formatted.candles[formatted.candles.length - 2] || last;
      return {
        symbol: formatted.instrument.symbol,
        interval: keyInfo.interval,
        candle: last,
        prevClose: prev.close,
        source: formatted.source,
        feedName: formatted.feedName,
        cacheHit: formatted.cacheHit,
        coalesced: formatted.coalesced,
        meta: formatted.meta,
        serverTime: formatted.serverTime
      };
    } catch (err) {
      const staleQuote =
        quoteCache.getEntry(keyInfo.key, { allowStale: true, maxStaleMs }) ||
        klineCache.getEntry(klineKeyInfo.key, { allowStale: true, maxStaleMs });

      if (staleQuote) {
        const formatted = formatKlineOutput(staleQuote.value, {
          keyInfo,
          fromCache: true,
          coalesced: false,
          stale: true,
          fetchedAt: staleQuote.createdAt,
          ageMs: staleQuote.ageMs
        });
        const last = formatted.candles[formatted.candles.length - 1];
        const prev = formatted.candles[formatted.candles.length - 2] || last;
        return {
          symbol: formatted.instrument.symbol,
          interval: keyInfo.interval,
          candle: last,
          prevClose: prev.close,
          source: 'cache',
          feedName: formatted.feedName,
          cacheHit: true,
          coalesced: false,
          meta: formatted.meta,
          serverTime: formatted.serverTime
        };
      }

      const sim = generateSimulatedSeries(keyInfo.symbol, keyInfo.interval);
      const formatted = formatKlineOutput(sim, {
        keyInfo,
        fromCache: false,
        coalesced: false,
        stale: false,
        fetchedAt: nowFn(),
        ageMs: 0
      });
      const last = formatted.candles[formatted.candles.length - 1];
      const prev = formatted.candles[formatted.candles.length - 2] || last;
      return {
        symbol: formatted.instrument.symbol,
        interval: keyInfo.interval,
        candle: last,
        prevClose: prev.close,
        source: 'simulated',
        feedName: formatted.feedName,
        cacheHit: false,
        coalesced: false,
        meta: formatted.meta,
        serverTime: formatted.serverTime
      };
    }
  }

  async function getStockFundamentals(symbol) {
    const normSymbol = normalizeSymbol(symbol);
    const cacheKey = `fundamentals::${normSymbol}`;
    const ttlMs = cfg.ttlMs.fundamentals;
    const maxStaleMs = cfg.maxStaleMs['1d'];

    const catalog = findCatalogItem(normSymbol);
    const baseMarket = catalog?.market || inferMarket('', normSymbol);
    const displayName = catalog?.name || cleanDisplaySymbol(normSymbol);
    const baseEnName = catalog?.enName || cleanDisplaySymbol(normSymbol);
    const baseExchange = catalog?.exchange || normalizeExchangeName('', normSymbol);

    const buildFundamentalsPayload = async () => {
      // 1) Yahoo Search quote metadata (sector, industry, longname, timestamped Yahoo news) via resilience & circuit breaker
      const yahooMetaPromise = executeWithResilience(
        'yahoo',
        (node) => `${node.baseUrl}/v1/finance/search?q=${encodeURIComponent(normSymbol)}&quotesCount=3&newsCount=5`,
        (j) => {
          const quote =
            (j?.quotes || []).find((q) => (q.symbol || '').toUpperCase() === normSymbol.toUpperCase()) ||
            j?.quotes?.[0] ||
            {};
          const news = (j?.news || [])
            .slice(0, 5)
            .map((n) => {
              const pubMs = Number.isFinite(n.providerPublishTime) ? n.providerPublishTime * 1000 : null;
              const iso = pubMs ? new Date(pubMs).toISOString() : '';
              return {
                title: decodeXmlEntities(n.title || ''),
                pubDate: iso ? iso.slice(0, 10) : '',
                publishedAt: iso,
                source: 'yahoo'
              };
            })
            .filter((n) => n.title);
          return {
            longName: quote.longname || quote.shortname || baseEnName,
            sector: quote.sectorDisp || quote.sector || '',
            industry: quote.industryDisp || quote.industry || '',
            news
          };
        },
        resCfg.timeoutMs.fundamentals
      );

      // 2) Google News RSS for latest corporate & market news headlines with timestamps
      const gnewsPromise = (async () => {
        const queryBase =
          baseMarket === 'in'
            ? `${baseEnName} ${baseExchange} stock`
            : `${baseEnName} ${cleanDisplaySymbol(normSymbol)} stock`;
        const localeParams =
          baseMarket === 'in'
            ? 'hl=en-IN&gl=IN&ceid=IN:en'
            : 'hl=en-US&gl=US&ceid=US:en';
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(queryBase)}&${localeParams}`;
        const xml = await fetchTextWithTimeout(
          url,
          { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } },
          resCfg.timeoutMs.fundamentals
        );
        const items = [];
        const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
        for (const m of itemMatches) {
          const block = m[1];
          const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
          const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          if (!titleMatch) continue;
          const rawTitle = decodeXmlEntities(titleMatch[1]).replace(/\s+-\s+[^-]+$/, '').trim();
          if (!rawTitle) continue;
          let pubDate = '';
          let publishedAt = '';
          if (dateMatch) {
            const d = new Date(decodeXmlEntities(dateMatch[1]));
            if (!Number.isNaN(d.getTime())) {
              publishedAt = d.toISOString();
              pubDate = publishedAt.slice(0, 10);
            }
          }
          items.push({ title: rawTitle, pubDate, publishedAt, source: 'google_news' });
          if (items.length >= 5) break;
        }
        return items;
      })();

      // 3) Daily (1d) candle snapshot via getKlines (reuses klineCache, NSE->BSE fallback, and meta)
      const dailyPromise = getKlines(normSymbol, '1d');

      const [yRes, gRes, dRes] = await Promise.allSettled([yahooMetaPromise, gnewsPromise, dailyPromise]);
      const yMeta =
        yRes.status === 'fulfilled'
          ? yRes.value
          : { longName: baseEnName, sector: '', industry: '', news: [] };
      const gNews = gRes.status === 'fulfilled' ? gRes.value : [];
      const klineData = dRes.status === 'fulfilled' ? dRes.value : null;

      // If all upstream sources failed (including klines falling back to simulated), throw so caller can degrade to stale fundamentals cache
      if (
        yRes.status === 'rejected' &&
        gRes.status === 'rejected' &&
        (!klineData || klineData.meta?.source === 'simulated')
      ) {
        const err = new Error('All fundamentals upstream sources failed');
        err.fallbackKlineData = klineData;
        throw err;
      }

      const candles = klineData?.candles || [];
      const closes = candles.map((c) => c.close);
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2] || last;
      const recent252 = candles.slice(-252);
      const high52w = recent252.length ? Math.max(...recent252.map((c) => c.high)) : null;
      const low52w = recent252.length ? Math.min(...recent252.map((c) => c.low)) : null;

      const seenTitle = new Set();
      const headlines = [];
      for (const h of [...gNews, ...(yMeta.news || [])]) {
        const key = (h.title || '').toLowerCase().slice(0, 48);
        if (!key || seenTitle.has(key)) continue;
        seenTitle.add(key);
        headlines.push(h);
        if (headlines.length >= 5) break;
      }

      const inst = klineData?.instrument || {
        symbol: normSymbol,
        displaySymbol: catalog?.displaySymbol || cleanDisplaySymbol(normSymbol),
        name: displayName,
        enName: baseEnName,
        exchange: baseExchange,
        market: baseMarket,
        currency: catalog?.currency || (baseMarket === 'in' ? 'INR' : baseMarket === 'kr' ? 'KRW' : 'USD')
      };

      return {
        symbol: inst.symbol,
        displaySymbol: inst.displaySymbol,
        name: inst.name,
        enName: yMeta.longName || inst.enName || baseEnName,
        exchange: inst.exchange,
        market: inst.market,
        currency: inst.currency,
        sector: yMeta.sector || '',
        industry: yMeta.industry || '',
        latestDate: klineData?.meta?.latestTradingDay || '',
        latestPrice: last?.close ?? null,
        dailyChangePct:
          last && prev && prev.close ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(2)) : 0,
        high52w,
        low52w,
        dailySR: computeDailySupplyDemandZones(candles),
        dailyMA: {
          ema5: calcSimpleEmaLast(closes, 5),
          ema10: calcSimpleEmaLast(closes, 10),
          ema20: calcSimpleEmaLast(closes, 20),
          ema50: calcSimpleEmaLast(closes, 50),
          ema200: calcSimpleEmaLast(closes, 200),
          ma5: calcSimpleSmaLast(closes, 5),
          ma10: calcSimpleSmaLast(closes, 10),
          ma20: calcSimpleSmaLast(closes, 20),
          ma50: calcSimpleSmaLast(closes, 50),
          ma200: calcSimpleSmaLast(closes, 200)
        },
        headlines,
        meta: klineData?.meta || buildResponseMeta({
          source: 'live',
          fetchedAt: nowFn(),
          now: nowFn(),
          stale: false,
          provider: yMeta.providerNode || 'yahoo:query1',
          latestBarTime: last?.time ?? null,
          market: baseMarket,
          resolvedSymbol: normSymbol,
          exchange: baseExchange
        })
      };
    };

    try {
      const loaded = await fundamentalsCache.getOrLoad(cacheKey, buildFundamentalsPayload, ttlMs, maxStaleMs);
      if (loaded.fromCache) {
        return {
          ...loaded.value,
          cacheHit: true,
          meta: {
            ...loaded.value.meta,
            source: 'cache',
            stale: false,
            fetchedAt: loaded.createdAt,
            ageMs: loaded.ageMs
          }
        };
      }
      return {
        ...loaded.value,
        cacheHit: false
      };
    } catch (err) {
      // Tier 2 degradation: stale fundamentals cache within maxStaleMs
      const staleHit = fundamentalsCache.getEntry(cacheKey, { allowStale: true, maxStaleMs });
      if (staleHit) {
        return {
          ...staleHit.value,
          cacheHit: true,
          meta: {
            ...staleHit.value.meta,
            source: 'cache',
            stale: true,
            fetchedAt: staleHit.createdAt,
            ageMs: staleHit.ageMs
          }
        };
      }

      // Tier 3 final fallback: simulated-backed fundamentals snapshot
      const klineData = err?.fallbackKlineData || (await getKlines(normSymbol, '1d'));
      const candles = klineData.candles || [];
      const closes = candles.map((c) => c.close);
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2] || last;
      const recent252 = candles.slice(-252);
      return {
        symbol: klineData.instrument.symbol,
        displaySymbol: klineData.instrument.displaySymbol,
        name: klineData.instrument.name,
        enName: klineData.instrument.enName,
        exchange: klineData.instrument.exchange,
        market: klineData.instrument.market,
        currency: klineData.instrument.currency,
        sector: '',
        industry: '',
        latestDate: klineData.meta?.latestTradingDay || '',
        latestPrice: last?.close ?? null,
        dailyChangePct:
          last && prev && prev.close ? Number((((last.close - prev.close) / prev.close) * 100).toFixed(2)) : 0,
        high52w: recent252.length ? Math.max(...recent252.map((c) => c.high)) : null,
        low52w: recent252.length ? Math.min(...recent252.map((c) => c.low)) : null,
        dailySR: computeDailySupplyDemandZones(candles),
        dailyMA: {
          ema5: calcSimpleEmaLast(closes, 5),
          ema10: calcSimpleEmaLast(closes, 10),
          ema20: calcSimpleEmaLast(closes, 20),
          ema50: calcSimpleEmaLast(closes, 50),
          ema200: calcSimpleEmaLast(closes, 200),
          ma5: calcSimpleSmaLast(closes, 5),
          ma10: calcSimpleSmaLast(closes, 10),
          ma20: calcSimpleSmaLast(closes, 20),
          ma50: calcSimpleSmaLast(closes, 50),
          ma200: calcSimpleSmaLast(closes, 200)
        },
        headlines: [],
        cacheHit: false,
        meta: klineData.meta
      };
    }
  }

  return {
    searchSymbols,
    getKlines,
    getLatestTick,
    getStockFundamentals,
    klineCache,
    quoteCache,
    fundamentalsCache,
    simCache,
    circuitBreaker
  };
}

const defaultService = createMarketService();

module.exports = {
  ...defaultService,
  createMarketService,
  normalizeSymbol,
  normalizeInterval,
  normalizeRange,
  buildMarketCacheKey,
  formatDateInTimezone,
  buildResponseMeta,
  INTERVAL_CONFIG,
  CACHE_CONFIG,
  RESILIENCE_CONFIG,
  UPSTREAM_NODES,
  PRICE_BASIS
};
