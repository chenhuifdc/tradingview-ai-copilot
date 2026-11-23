/**
 * ChartCopilot — TradingView-style Real-Time K-Line + BYOK AI Copilot Server
 * Zero external npm dependencies (uses Node.js built-in http, fs, path, fetch).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const marketService = require('./server/marketService');
const aiProxy = require('./server/aiProxy');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/**
 * Resolve server bind HOST, PORT, and whether local loopback LLMs (ALLOW_LOCAL_LLM) are permitted.
 * - Default HOST is '127.0.0.1'.
 * - Default ALLOW_LOCAL_LLM is true ONLY when HOST is a loopback address ('127.0.0.1', '::1', 'localhost').
 * - When HOST is '0.0.0.0' or a non-loopback address, ALLOW_LOCAL_LLM defaults to false unless explicitly enabled via env.
 */
function getListenConfig(env = process.env) {
  const host = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const port = parseInt(env.PORT || '3456', 10);
  const hostIsLoopback = aiProxy.isLoopbackHost(host);

  let allowLocalLlm = hostIsLoopback;
  if (env.ALLOW_LOCAL_LLM !== undefined && String(env.ALLOW_LOCAL_LLM).trim() !== '') {
    const raw = String(env.ALLOW_LOCAL_LLM).trim().toLowerCase();
    allowLocalLlm = raw === 'true' || raw === '1' || raw === 'yes';
  }

  return { host, port, allowLocalLlm };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  try {
    reqPath = decodeURIComponent(reqPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate'
    });
    fs.createReadStream(fullPath).pipe(res);
  });
}

function createAppServer(options = {}) {
  const svc = options.marketService || marketService;
  const proxy = options.aiProxy || aiProxy;
  const listenCfg = getListenConfig(options.env || process.env);
  const serverAllowLocal =
    options.allowLocalLlm !== undefined ? Boolean(options.allowLocalLlm) : listenCfg.allowLocalLlm;

  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = parsedUrl;

    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, time: Date.now() });
      }

      if (pathname === '/api/search' && req.method === 'GET') {
        const q = searchParams.get('q') || '';
        const market = searchParams.get('market') || 'all';
        const data = await svc.searchSymbols(q, market);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/klines' && req.method === 'GET') {
        const symbol = searchParams.get('symbol') || 'ALKALI.NS';
        const interval = searchParams.get('interval') || '1d';
        const range = searchParams.get('range') || undefined;
        const data = await svc.getKlines(symbol, interval, range);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/quote' && req.method === 'GET') {
        const symbol = searchParams.get('symbol') || 'ALKALI.NS';
        const interval = searchParams.get('interval') || '1d';
        const range = searchParams.get('range') || undefined;
        const data = await svc.getLatestTick(symbol, interval, range);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/fundamentals' && req.method === 'GET') {
        const symbol = searchParams.get('symbol') || 'ALKALI.NS';
        const data = await svc.getStockFundamentals(symbol);
        return sendJson(res, 200, data);
      }

      if (pathname === '/api/ai/test' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await proxy.testConnection({
            apiKey: body.apiKey,
            baseUrl: body.baseUrl,
            model: body.model,
            allowLocal: Boolean(body.allowLocal),
            serverAllowLocal,
            lookupFn: options.lookupFn,
            requestImpl: options.requestImpl
          });
          return sendJson(res, 200, result);
        } catch (err) {
          const msg = proxy.redactSecrets(err?.message || '连接测试失败', body.apiKey);
          const isClientErr = /(禁止访问|仅支持 https|出于安全限制|Base URL|未开启本地模型|域名解析失败|重定向)/i.test(msg);
          return sendJson(res, isClientErr ? 400 : 502, { error: msg });
        }
      }

      if (pathname === '/api/ai/chat' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return sendJson(res, 400, { error: 'messages 不能为空' });
        }
        try {
          const result = await proxy.callChatCompletion({
            apiKey: body.apiKey,
            baseUrl: body.baseUrl,
            model: body.model,
            messages: body.messages,
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            allowLocal: Boolean(body.allowLocal),
            serverAllowLocal,
            lookupFn: options.lookupFn,
            requestImpl: options.requestImpl
          });
          return sendJson(res, 200, result);
        } catch (err) {
          const msg = proxy.redactSecrets(err?.message || 'AI 请求失败', body.apiKey);
          const isClientErr = /(禁止访问|仅支持 https|出于安全限制|Base URL|未开启本地模型|域名解析失败|重定向)/i.test(msg);
          return sendJson(res, isClientErr ? 400 : 502, { error: msg });
        }
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(req, res, pathname);
      }

      sendJson(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
      sendJson(res, 500, {
        error: aiProxy.redactSecrets(err?.message || 'Internal Server Error')
      });
    }
  });
}

if (require.main === module) {
  const { host, port, allowLocalLlm } = getListenConfig(process.env);
  const server = createAppServer({ allowLocalLlm });
  server.listen(port, host, () => {
    console.log(`[ChartCopilot] Running on http://${host}:${port} (ALLOW_LOCAL_LLM=${allowLocalLlm})`);
  });

  function shutdown(signal) {
    console.log(`[ChartCopilot] Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  createAppServer,
  getListenConfig
};
