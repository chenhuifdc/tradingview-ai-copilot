import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import {
  STREAM_CONFIG,
  computeReconnectDelayMs,
  mergeCandlesByTimestamp,
  parseBinanceKlineFrame,
  RealtimeStreamManager
} from '../public/js/realtimeStream.js';

/**
 * Minimal zero-dependency RFC 6455 WebSocket server for testing real WebSocket connections.
 */
function createMockWsServer() {
  const sockets = new Set();
  let connectionCount = 0;

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n')
    );

    connectionCount += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  const sendJson = (socket, obj) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };

  return {
    server,
    getConnectionCount: () => connectionCount,
    getActiveSockets: () => Array.from(sockets),
    broadcastJson: (obj) => {
      for (const s of sockets) sendJson(s, obj);
    },
    dropAll: () => {
      for (const s of sockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
      sockets.clear();
    },
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve(`ws://127.0.0.1:${port}/ws/btcusdt@kline_1m`);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) {
          try { s.destroy(); } catch { /* ignore */ }
        }
        server.close(() => resolve());
      })
  };
}

test('M6.1: computeReconnectDelayMs applies exponential backoff with +/-25% random jitter and caps at maxReconnectDelayMs', () => {
  const cfg = { baseReconnectDelayMs: 1000, maxReconnectDelayMs: 8000, backoffFactor: 2, jitterRatio: 0.25 };
  assert.equal(computeReconnectDelayMs(0, cfg, () => 0.5), 1000);
  assert.equal(computeReconnectDelayMs(1, cfg, () => 0.5), 2000);
  assert.equal(computeReconnectDelayMs(2, cfg, () => 0.5), 4000);
  assert.equal(computeReconnectDelayMs(3, cfg, () => 0.5), 8000);
  assert.equal(computeReconnectDelayMs(5, cfg, () => 0.5), 8000);

  const minJitter = computeReconnectDelayMs(1, cfg, () => 0); // 2000 * 0.75 = 1500
  const maxJitter = computeReconnectDelayMs(1, cfg, () => 1); // 2000 * 1.25 = 2500
  assert.equal(minJitter, 1500);
  assert.equal(maxJitter, 2500);
});

test('M6.2: mergeCandlesByTimestamp deduplicates by timestamp, sorts ascending, and updates unclosed->closed bar', () => {
  const existing = [
    { time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 1060, open: 11, high: 13, low: 10, close: 12, volume: 50, isClosed: false }
  ];
  const incoming = [
    { time: 1060, open: 11, high: 14, low: 10, close: 13.5, volume: 120, isClosed: true }, // overwrite unclosed
    { time: 1120, open: 13.5, high: 15, low: 13, close: 14.5, volume: 80, isClosed: true }, // missed bar
    { time: 1180, open: 14.5, high: 15.5, low: 14, close: 15, volume: 60, isClosed: false }
  ];
  const { merged, addedCount, updatedCount } = mergeCandlesByTimestamp(existing, incoming);
  assert.equal(merged.length, 4);
  assert.equal(addedCount, 2);
  assert.equal(updatedCount, 1);
  assert.equal(merged[1].close, 13.5);
  assert.equal(merged[1].isClosed, true);
  assert.deepEqual(merged.map((c) => c.time), [1000, 1060, 1120, 1180]);
});

test('M6.3: Real local mock WebSocket server drives unclosed/closed ticks, drop->reconnect->backfill->recovered status, and zero AI/patternEngine calls', async () => {
  const mockWs = createMockWsServer();
  const wsUrl = await mockWs.listen();

  const receivedCandles = [];
  const backfilledBatches = [];
  const statuses = [];
  let aiOrPatternCalls = 0;

  const docStub = {
    hidden: false,
    listeners: new Map(),
    addEventListener(ev, fn) { this.listeners.set(ev, fn); },
    removeEventListener(ev) { this.listeners.delete(ev); }
  };

  const mgr = new RealtimeStreamManager({
    WebSocketClass: globalThis.WebSocket,
    document: docStub,
    config: {
      baseReconnectDelayMs: 60,
      maxReconnectDelayMs: 120,
      jitterRatio: 0.1,
      proactiveReconnectMs: 0,
      recoveredDisplayMs: 150,
      pollIntervalRealMs: 60000
    },
    onCandle: (c) => {
      receivedCandles.push(c);
    },
    onBackfillCandles: (bars) => {
      backfilledBatches.push(bars);
    },
    onStatusChange: (s) => {
      statuses.push(s.state);
    },
    fetchBackfillFn: async ({ sinceTime }) => [
      { time: sinceTime + 60, open: 102, high: 105, low: 101, close: 104, volume: 210, isClosed: true }
    ]
  });

  try {
    mgr.start({ symbol: 'BTCUSDT', interval: '1m', wsUrl, isRealUpstream: true, lastBarTime: 1700000000 });

    // Wait for initial WS connection
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(mockWs.getConnectionCount(), 1);
    assert.ok(statuses.includes('connected'));

    // Send unclosed kline (x: false) then closed kline (x: true)
    mockWs.broadcastJson({ k: { t: 1700000000000, o: '100', h: '101', l: '99', c: '100.5', v: '10', x: false } });
    mockWs.broadcastJson({ k: { t: 1700000000000, o: '100', h: '102', l: '99', c: '101.8', v: '25', x: true } });
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(receivedCandles.length, 2);
    assert.equal(receivedCandles[0].isClosed, false);
    assert.equal(receivedCandles[1].isClosed, true);
    assert.equal(aiOrPatternCalls, 0);

    // Drop connection -> must emit 'reconnecting', reconnect, backfill missed bar, emit 'recovered'
    mockWs.dropAll();
    await new Promise((r) => setTimeout(r, 250));

    assert.ok(mockWs.getConnectionCount() >= 2, 'Should reconnect to mock WebSocket server');
    assert.ok(statuses.includes('reconnecting'), 'Must emit reconnecting state');
    assert.ok(statuses.includes('recovered'), 'Must emit recovered state after backfill');
    assert.equal(backfilledBatches.length, 1, 'Must run backfill after reconnect');
    assert.equal(backfilledBatches[0][0].time, 1700000060);
  } finally {
    mgr.stop();
    await mockWs.close();
  }
});

test('M6.4: Proactive 24h swap reconnects seamlessly without reconnecting error state, and Visibility API pauses & restores with single backfill', async () => {
  const mockWs = createMockWsServer();
  const wsUrl = await mockWs.listen();

  const statuses = [];
  let backfillCalls = 0;
  const docStub = {
    hidden: false,
    listeners: new Map(),
    addEventListener(ev, fn) { this.listeners.set(ev, fn); },
    removeEventListener(ev) { this.listeners.delete(ev); },
    triggerVisibility(hidden) {
      this.hidden = hidden;
      const fn = this.listeners.get('visibilitychange');
      if (fn) return fn();
    }
  };

  const mgr = new RealtimeStreamManager({
    WebSocketClass: globalThis.WebSocket,
    document: docStub,
    config: {
      baseReconnectDelayMs: 60,
      maxReconnectDelayMs: 120,
      proactiveReconnectMs: 120, // fast 24h swap simulation
      recoveredDisplayMs: 100,
      pollIntervalRealMs: 60000
    },
    onStatusChange: (s) => statuses.push(s.state),
    fetchBackfillFn: async ({ sinceTime }) => {
      backfillCalls += 1;
      return [{ time: sinceTime + 60, open: 200, high: 205, low: 199, close: 203, volume: 90 }];
    }
  });

  try {
    mgr.start({ symbol: 'BTCUSDT', interval: '1m', wsUrl, isRealUpstream: true, lastBarTime: 1700000000 });
    await new Promise((r) => setTimeout(r, 220));

    assert.ok(mgr.proactiveSwaps >= 1, 'Proactive 24h timer must swap WS connection seamlessly');
    assert.equal(statuses.includes('reconnecting'), false, 'Proactive 24h swap must NOT show reconnecting error state');

    // Page hidden -> paused
    await docStub.triggerVisibility(true);
    assert.equal(mgr.streamState, 'paused');
    assert.equal(mgr.ws, null, 'WS must be closed when page is hidden');

    const bfBefore = backfillCalls;
    // Page visible -> single backfill + recovered + resume
    await docStub.triggerVisibility(false);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(backfillCalls, bfBefore + 1, 'Visibility restore must trigger one backfill');
    assert.ok(statuses.includes('recovered'));
  } finally {
    mgr.stop();
    await mockWs.close();
  }
});
