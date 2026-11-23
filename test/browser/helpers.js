const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createAppServer } = require('../../server');

/**
 * Locate an installed Chromium / Chrome binary across common paths or env override.
 * Returns null if none is installed so browser tests can skip gracefully.
 */
function findChromiumBinary() {
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) {
    return process.env.CHROMIUM_BIN;
  }

  const playWrightRoot = path.join(process.env.HOME || '/home/antigravity', '.cache', 'ms-playwright');
  if (fs.existsSync(playWrightRoot)) {
    try {
      const entries = fs.readdirSync(playWrightRoot).sort().reverse();
      for (const dir of entries) {
        if (dir.startsWith('chromium-')) {
          const candidate = path.join(playWrightRoot, dir, 'chrome-linux', 'chrome');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }

  const whichCandidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const bin of whichCandidates) {
    const res = spawnSync('which', [bin], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  }

  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Start an in-process ChartCopilot HTTP server with injectable mock marketService / aiProxy
 * so all browser E2E tests are 100% deterministic and offline-reproducible.
 */
async function startMockAppServer(serverOptions = {}) {
  const srv = createAppServer(serverOptions);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    }
  };
}

function makeMockCandles({ count = 120, endSec = Math.floor(Date.parse('2026-03-20T10:00:00Z') / 1000), stepSec = 86400, basePrice = 1360 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const wave = Math.sin(i / 6) * 28 + Math.cos(i / 13) * 14;
    const open = Number((basePrice + wave).toFixed(2));
    const close = Number((open + Math.sin(i / 3) * 11).toFixed(2));
    const high = Number((Math.max(open, close) + 8 + (i % 5)).toFixed(2));
    const low = Number((Math.min(open, close) - 8 - (i % 4)).toFixed(2));
    return {
      time: endSec - (count - 1 - i) * stepSec,
      open,
      high,
      low,
      close,
      volume: 150000 + i * 1200
    };
  });
}

async function withCdpPage(chromeBin, targetUrl, fn, { width = 1440, height = 900, deviceScaleFactor = 1 } = {}) {
  const debugPort = await getFreePort();
  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    let wsUrl = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }
    if (!wsUrl) throw new Error('Failed to connect to headless Chromium CDP');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];
    const pageExceptions = [];

    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      } else if (data.method === 'Runtime.consoleAPICalled') {
        if (data.params?.type === 'error') {
          const text = (data.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
          consoleErrors.push(text);
        }
      } else if (data.method === 'Runtime.exceptionThrown') {
        const desc =
          data.params?.exceptionDetails?.exception?.description ||
          data.params?.exceptionDetails?.text ||
          'Unknown page exception';
        pageExceptions.push(desc);
      }
    });

    const sendCdp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await sendCdp('Runtime.enable');
    await sendCdp('Page.enable');
    if (deviceScaleFactor !== 1) {
      await sendCdp('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: false
      });
    }
    await sendCdp('Page.navigate', { url: targetUrl });

    const evaluate = async (expression) => {
      const res = await sendCdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error(`Browser eval exception: ${JSON.stringify(res.exceptionDetails)}`);
      }
      return res.result?.value;
    };

    const waitForAppReady = async (timeoutMs = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const ready = await evaluate(
          `Boolean(window.__chartCopilot && window.__chartCopilot.chart && window.__chartCopilot.chart.candles && window.__chartCopilot.chart.candles.length > 0)`
        );
        if (ready) return;
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error('Timed out waiting for window.__chartCopilot initial chart load');
    };

    await waitForAppReady();

    const result = await fn({ sendCdp, evaluate, consoleErrors, pageExceptions });
    ws.close();
    return result;
  } finally {
    try {
      chrome.kill('SIGTERM');
    } catch {}
  }
}

module.exports = {
  findChromiumBinary,
  startMockAppServer,
  makeMockCandles,
  withCdpPage
};
