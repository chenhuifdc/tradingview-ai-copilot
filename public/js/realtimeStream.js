/**
 * M6 Realtime Stream & Disconnect Recovery Manager.
 * - WebSocket exponential backoff + random jitter reconnect
 * - Proactive seamless reconnect before Binance ~24h connection limit (23.5h)
 * - Post-reconnect gap backfill & timestamp-based deduplication/merge
 * - Page Visibility API pause when hidden, single backfill + resume when visible
 * - Stream state coordination ('connected' | 'reconnecting' | 'recovered' | 'paused')
 * - Never triggers patternEngine or AI analysis on tick/reconnect
 */

export const STREAM_CONFIG = {
  baseReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
  backoffFactor: 2,
  jitterRatio: 0.25,
  proactiveReconnectMs: 23.5 * 60 * 60 * 1000, // 23.5h before Binance 24h forced disconnect
  recoveredDisplayMs: 4000,
  pollIntervalRealMs: 5000,
  pollIntervalSimMs: 2500,
  wsBaseUrl: 'wss://stream.binance.com:9443/ws'
};

/**
 * Compute exponential backoff delay with +/- jitterRatio random jitter.
 */
export function computeReconnectDelayMs(attempt, config = STREAM_CONFIG, randomFn = Math.random) {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = Math.min(
    config.maxReconnectDelayMs,
    config.baseReconnectDelayMs * Math.pow(config.backoffFactor, safeAttempt)
  );
  const jitter = (randomFn() * 2 - 1) * (config.jitterRatio ?? 0.25);
  return Math.max(50, Math.round(raw * (1 + jitter)));
}

/**
 * Merge backfill/incoming candles into existing candles sorted ascending by timestamp (seconds).
 * Deduplicates by timestamp; incoming bars overwrite existing bars at the same timestamp
 * (so unclosed -> closed bar transitions and price corrections are preserved cleanly).
 */
export function mergeCandlesByTimestamp(existingCandles = [], incomingCandles = []) {
  const byTime = new Map();
  for (const c of existingCandles) {
    if (c && Number.isFinite(Number(c.time))) {
      byTime.set(Number(c.time), { ...c });
    }
  }
  let addedCount = 0;
  let updatedCount = 0;
  for (const c of incomingCandles) {
    if (!c || !Number.isFinite(Number(c.time))) continue;
    const t = Number(c.time);
    const normalized = {
      time: t,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0),
      ...(c.isClosed !== undefined ? { isClosed: Boolean(c.isClosed) } : {})
    };
    if (byTime.has(t)) {
      updatedCount++;
    } else {
      addedCount++;
    }
    byTime.set(t, normalized);
  }
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  return { merged, addedCount, updatedCount };
}

/**
 * Parse a Binance @kline frame into a normalized candle object with isClosed flag.
 */
export function parseBinanceKlineFrame(rawData) {
  try {
    const msg = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    const k = msg?.k;
    if (!k) return null;
    return {
      time: Math.floor(Number(k.t) / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      isClosed: Boolean(k.x)
    };
  } catch {
    return null;
  }
}

export class RealtimeStreamManager {
  constructor(options = {}) {
    this.config = { ...STREAM_CONFIG, ...(options.config || {}) };
    this.WebSocketClass = options.WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.doc = options.document !== undefined ? options.document : (typeof document !== 'undefined' ? document : null);
    this.randomFn = options.randomFn || Math.random;
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
    this.setIntervalFn = options.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn || ((id) => clearInterval(id));

    this.onCandle = options.onCandle || (() => {});
    this.onBackfillCandles = options.onBackfillCandles || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onPollTick = options.onPollTick || (async () => null);
    this.fetchBackfillFn = options.fetchBackfillFn || (async () => []);

    this.ws = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.proactiveTimer = null;
    this.recoveredTimer = null;

    this.running = false;
    this.paused = false;
    this.wsUrl = null;
    this.symbol = '';
    this.interval = '1d';
    this.isRealUpstream = true;
    this.lastBarTime = 0;

    this.reconnectAttempt = 0;
    this.needsBackfillOnOpen = false;
    this.streamState = 'idle'; // 'idle' | 'connected' | 'reconnecting' | 'recovered' | 'paused'
    this.proactiveSwaps = 0;
    this.backfillCount = 0;

    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  start({ symbol, interval, wsUrl = null, isRealUpstream = true, lastBarTime = 0 } = {}) {
    this.stop();
    this.running = true;
    this.paused = Boolean(this.doc?.hidden);
    this.symbol = symbol || '';
    this.interval = interval || '1d';
    this.wsUrl = wsUrl || null;
    this.isRealUpstream = Boolean(isRealUpstream);
    this.lastBarTime = Number(lastBarTime) || 0;
    this.reconnectAttempt = 0;
    this.needsBackfillOnOpen = false;

    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    if (this.paused) {
      this._emitStatus('paused', { reason: 'page_hidden' });
      return;
    }

    this._startTransport();
  }

  stop() {
    this.running = false;
    this._clearTimers();
    this._closeWs();
    if (this.doc && typeof this.doc.removeEventListener === 'function') {
      this.doc.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    this.streamState = 'idle';
  }

  _clearTimers() {
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.proactiveTimer) {
      this.clearTimeoutFn(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    if (this.recoveredTimer) {
      this.clearTimeoutFn(this.recoveredTimer);
      this.recoveredTimer = null;
    }
  }

  _closeWs() {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        old.close();
      } catch {
        // ignore close errors
      }
    }
  }

  _emitStatus(state, extra = {}) {
    this.streamState = state;
    this.onStatusChange({
      state,
      attempt: this.reconnectAttempt,
      proactiveSwaps: this.proactiveSwaps,
      backfillCount: this.backfillCount,
      ...extra
    });
  }

  _startTransport() {
    if (!this.running || this.paused) return;
    if (this.wsUrl && this.WebSocketClass) {
      this._connectWs();
    }
    this._startPolling();
  }

  _connectWs({ isProactiveSwap = false } = {}) {
    if (!this.running || this.paused || !this.wsUrl || !this.WebSocketClass) return;

    const prevWs = isProactiveSwap ? this.ws : null;
    if (!isProactiveSwap) {
      this._closeWs();
    }

    let ws;
    try {
      ws = new this.WebSocketClass(this.wsUrl);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = async () => {
      if (!this.running || this.paused || this.ws !== ws) {
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      if (prevWs) {
        try {
          prevWs.onopen = null;
          prevWs.onmessage = null;
          prevWs.onerror = null;
          prevWs.onclose = null;
          prevWs.close();
        } catch { /* ignore */ }
      }

      const wasReconnecting = this.needsBackfillOnOpen || this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.needsBackfillOnOpen = false;

      if (wasReconnecting) {
        await this._runBackfill('ws_reconnect');
        this._markRecovered('ws_reconnect');
      } else if (isProactiveSwap) {
        this.proactiveSwaps++;
        await this._runBackfill('proactive_24h_swap');
        this._emitStatus('connected', { reason: 'proactive_24h_swap' });
      } else {
        this._emitStatus('connected', { reason: 'ws_open' });
      }

      this._scheduleProactiveReconnect();
    };

    ws.onmessage = (evt) => {
      if (!this.running || this.paused || this.ws !== ws) return;
      const candle = parseBinanceKlineFrame(evt.data);
      if (!candle) return;
      if (candle.time > this.lastBarTime) {
        this.lastBarTime = candle.time;
      }
      this.onCandle(candle);
    };

    ws.onerror = () => {
      // Let onclose handle reconnect
    };

    ws.onclose = () => {
      if (!this.running || this.paused || this.ws !== ws) return;
      this.ws = null;
      this.needsBackfillOnOpen = true;
      this._scheduleReconnect();
    };
  }

  _scheduleProactiveReconnect() {
    if (this.proactiveTimer) {
      this.clearTimeoutFn(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    if (!this.running || this.paused || !this.wsUrl) return;
    if (!Number.isFinite(this.config.proactiveReconnectMs) || this.config.proactiveReconnectMs <= 0) return;

    this.proactiveTimer = this.setTimeoutFn(() => {
      if (!this.running || this.paused) return;
      this._connectWs({ isProactiveSwap: true });
    }, this.config.proactiveReconnectMs);
  }

  _scheduleReconnect() {
    if (!this.running || this.paused) return;
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt += 1;
    const delayMs = computeReconnectDelayMs(this.reconnectAttempt - 1, this.config, this.randomFn);
    this._emitStatus('reconnecting', { delayMs, attempt: this.reconnectAttempt });
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this._connectWs();
    }, delayMs);
  }

  _startPolling() {
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }
    const pollMs = this.isRealUpstream ? this.config.pollIntervalRealMs : this.config.pollIntervalSimMs;
    this.pollTimer = this.setIntervalFn(async () => {
      if (!this.running || this.paused) return;
      const openState = this.WebSocketClass?.OPEN ?? 1;
      if (this.ws && this.ws.readyState === openState) return;
      try {
        const tick = await this.onPollTick();
        if (tick?.candle && Number.isFinite(Number(tick.candle.time))) {
          if (Number(tick.candle.time) > this.lastBarTime) {
            this.lastBarTime = Number(tick.candle.time);
          }
        }
      } catch {
        // ignore intermittent poll errors
      }
    }, pollMs);
  }

  async _runBackfill(reason = 'reconnect') {
    try {
      const bars = await this.fetchBackfillFn({
        symbol: this.symbol,
        interval: this.interval,
        sinceTime: this.lastBarTime,
        reason
      });
      if (Array.isArray(bars) && bars.length) {
        this.backfillCount += 1;
        const latest = bars[bars.length - 1];
        if (latest && Number.isFinite(Number(latest.time)) && Number(latest.time) > this.lastBarTime) {
          this.lastBarTime = Number(latest.time);
        }
        this.onBackfillCandles(bars, { reason });
      }
    } catch {
      // backfill best-effort
    }
  }

  _markRecovered(reason = 'recovered') {
    this._emitStatus('recovered', { reason });
    if (this.recoveredTimer) {
      this.clearTimeoutFn(this.recoveredTimer);
    }
    this.recoveredTimer = this.setTimeoutFn(() => {
      this.recoveredTimer = null;
      if (this.running && !this.paused && this.streamState === 'recovered') {
        this._emitStatus('connected', { reason: 'steady' });
      }
    }, this.config.recoveredDisplayMs);
  }

  async _handleVisibilityChange() {
    if (!this.running || !this.doc) return;
    if (this.doc.hidden) {
      this.paused = true;
      this._clearTimers();
      this._closeWs();
      this._emitStatus('paused', { reason: 'page_hidden' });
    } else if (this.paused) {
      this.paused = false;
      this.needsBackfillOnOpen = false;
      await this._runBackfill('visibility_restored');
      this._markRecovered('visibility_restored');
      this._startTransport();
    }
  }
}
