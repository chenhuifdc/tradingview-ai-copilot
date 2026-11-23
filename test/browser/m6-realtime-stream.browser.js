const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startMockAppServer, makeMockCandles, withCdpPage } = require('./helpers');

function createLocalMockWsServer() {
  const sockets = new Set();
  let connections = 0;

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

    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  const sendJson = (socket, obj) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header =
      payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : (() => {
            const b = Buffer.alloc(4);
            b[0] = 0x81;
            b[1] = 126;
            b.writeUInt16BE(payload.length, 2);
            return b;
          })();
    socket.write(Buffer.concat([header, payload]));
  };

  return {
    getConnections: () => connections,
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
          resolve(`ws://127.0.0.1:${port}/ws`);
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

async function runM6BrowserTest(chromeBin) {
  const mockWs = createLocalMockWsServer();
  const wsBaseUrl = await mockWs.listen();

  const baseCandles = makeMockCandles({ count: 100, intervalSec: 60 });
  const lastBar = baseCandles[baseCandles.length - 1];
  let backfillActive = false;

  const mockMarketService = {
    searchSymbols: async () => ({ remoteOnline: true, results: [] }),
    getKlines: async (symbol, interval) => {
      const candles = backfillActive
        ? [
            ...baseCandles,
            {
              time: lastBar.time + 60,
              open: lastBar.close,
              high: lastBar.close + 12,
              low: lastBar.close - 5,
              close: lastBar.close + 8,
              volume: 500
            }
          ]
        : baseCandles;
      return {
        symbol,
        interval: interval || '1m',
        source: 'live',
        feedName: 'Binance Mock WS',
        wsSymbol: 'btcusdt',
        wsInterval: '1m',
        instrument: {
          symbol: 'BTCUSDT',
          displaySymbol: 'BTC/USDT',
          name: 'Bitcoin',
          enName: 'Bitcoin',
          exchange: 'BINANCE',
          market: 'crypto'
        },
        candles,
        meta: {
          source: 'live',
          stale: false,
          provider: 'binance:data-api',
          latestBarTime: candles[candles.length - 1].time,
          exchangeTimezone: 'UTC',
          timezone: 'UTC',
          resolvedSymbol: 'BTCUSDT',
          exchange: 'BINANCE'
        }
      };
    },
    getLatestTick: async () => ({
      symbol: 'BTCUSDT',
      interval: '1m',
      source: 'live',
      candle: lastBar,
      prevClose: baseCandles[baseCandles.length - 2].close,
      meta: { source: 'live', stale: false, provider: 'binance:data-api', latestBarTime: lastBar.time, exchange: 'BINANCE' }
    }),
    getStockFundamentals: async () => ({ symbol: 'BTCUSDT', headlines: [], meta: { source: 'live' } })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService });
  try {
    return await withCdpPage(chromeBin, srv.baseUrl, async ({ evaluate, consoleErrors, pageExceptions }) => {
      await evaluate(`(() => {
        window.__WS_BASE_URL = ${JSON.stringify(wsBaseUrl)};
        const app = window.__chartCopilot;
        app.streamManager.config.baseReconnectDelayMs = 120;
        app.streamManager.config.maxReconnectDelayMs = 250;
        app.streamManager.config.recoveredDisplayMs = 5000;
        window.__aiCallCount = 0;
        const origAsk = app.copilot.ask.bind(app.copilot);
        app.copilot.ask = (...args) => { window.__aiCallCount++; return origAsk(...args); };
      })()`);

      await evaluate(`window.__chartCopilot.loadSymbol('BTCUSDT', '1m')`);
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(mockWs.getConnections(), 1, 'Browser must connect to local mock WebSocket server');

      // 1) Push unclosed kline (same timestamp) -> in-place series.update(), length stays 100
      mockWs.broadcastJson({
        k: {
          t: lastBar.time * 1000,
          o: String(lastBar.open),
          h: String(lastBar.high + 5),
          l: String(lastBar.low),
          c: String(lastBar.close + 3),
          v: String(lastBar.volume + 50),
          x: false
        }
      });
      await new Promise((r) => setTimeout(r, 80));
      const afterUnclosed = await evaluate(`({
        len: window.__chartCopilot.chart.candles.length,
        close: window.__chartCopilot.chart.candles[window.__chartCopilot.chart.candles.length - 1].close,
        aiCalls: window.__aiCallCount
      })`);
      assert.equal(afterUnclosed.len, 100, 'Unclosed kline must update in-place without appending');
      assert.equal(afterUnclosed.close, lastBar.close + 3);
      assert.equal(afterUnclosed.aiCalls, 0, 'AI must not rerun on WS tick');

      // 2) Drop WS -> verify UI shows '重连中', then enable backfill & let reconnect -> verify '已恢复' + merged bar
      backfillActive = true;
      mockWs.dropAll();
      await new Promise((r) => setTimeout(r, 50));
      const reconnectingUi = await evaluate(`({
        badgeText: document.getElementById('liveStatusText')?.textContent || '',
        streamState: document.getElementById('liveStatusBadge')?.dataset?.streamState || ''
      })`);

      await new Promise((r) => setTimeout(r, 350));
      const recoveredUi = await evaluate(`({
        badgeText: document.getElementById('liveStatusText')?.textContent || '',
        hudText: document.getElementById('hudDataStatusBadge')?.textContent || '',
        streamState: document.getElementById('liveStatusBadge')?.dataset?.streamState || '',
        len: window.__chartCopilot.chart.candles.length,
        lastTime: window.__chartCopilot.chart.candles[window.__chartCopilot.chart.candles.length - 1].time,
        aiCalls: window.__aiCallCount
      })`);

      assert.equal(reconnectingUi.streamState, 'reconnecting');
      assert.ok(reconnectingUi.badgeText.includes('重连中'), `Expected 重连中 in badgeText, got ${reconnectingUi.badgeText}`);

      assert.ok(mockWs.getConnections() >= 2, 'Browser must reconnect to local mock WS');
      assert.equal(recoveredUi.streamState, 'recovered');
      assert.ok(recoveredUi.badgeText.includes('已恢复'), `Expected 已恢复 in badgeText, got ${recoveredUi.badgeText}`);
      assert.ok(recoveredUi.hudText.includes('已恢复'), `Expected 已恢复 in hudText, got ${recoveredUi.hudText}`);
      assert.equal(recoveredUi.len, 101, 'Backfill must merge missed bar and deduplicate existing bars');
      assert.equal(recoveredUi.lastTime, lastBar.time + 60);
      assert.equal(recoveredUi.aiCalls, 0, 'AI must not rerun on reconnect/backfill');

      assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
      assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);

      return {
        connections: mockWs.getConnections(),
        reconnectingText: reconnectingUi.badgeText,
        recoveredText: recoveredUi.badgeText,
        candleCountAfterBackfill: recoveredUi.len,
        aiCalls: recoveredUi.aiCalls
      };
    });
  } finally {
    await srv.close();
    await mockWs.close();
  }
}

module.exports = { runM6BrowserTest };
