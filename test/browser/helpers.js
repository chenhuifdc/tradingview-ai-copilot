const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

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

async function startAppServer(envOverrides = {}) {
  const port = await getFreePort();
  const serverPath = path.join(__dirname, '..', '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App server start timeout')), 5000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}`));
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  };
}

async function withCdpPage(chromeBin, targetUrl, fn) {
  const debugPort = await getFreePort();
  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
      `--remote-debugging-port=${debugPort}`,
      targetUrl
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
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
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
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

    const result = await fn({ sendCdp, evaluate });
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
  startAppServer,
  withCdpPage
};
