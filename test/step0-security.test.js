const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const { getListenConfig, createAppServer } = require('../server');
const {
  classifyIp,
  validateBaseUrl,
  createSafeLookup,
  redactSecrets,
  isLoopbackHost,
  callChatCompletion,
  testConnection
} = require('../server/aiProxy');

function postJson(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
          Connection: 'close'
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, raw: text, json: JSON.parse(text) });
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function createStrictMockDom() {
  const innerHtmlWrites = [];
  class MockNode {
    constructor(tagName = 'div') {
      this.tagName = String(tagName).toUpperCase();
      this.className = '';
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.children = [];
      this.listeners = {};
      this._textContent = '';
      this.src = '';
      this.alt = '';
      this.title = '';
      this.type = '';
      this.value = '';
      this.scrollTop = 0;
      this.scrollHeight = 100;
      this.classList = {
        _set: new Set(),
        add: (...cls) => cls.forEach((c) => this.classList._set.add(c)),
        remove: (...cls) => cls.forEach((c) => this.classList._set.delete(c)),
        toggle: (c, force) => {
          if (force === undefined) {
            if (this.classList._set.has(c)) this.classList._set.delete(c);
            else this.classList._set.add(c);
          } else if (force) this.classList._set.add(c);
          else this.classList._set.delete(c);
        }
      };
    }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
    }
    get innerHTML() {
      return this.textContent;
    }
    set innerHTML(v) {
      innerHtmlWrites.push({ tagName: this.tagName, className: this.className, value: String(v) });
      throw new Error(`innerHTML mutation is forbidden in XSS-safe components: <${this.tagName}.${this.className}>`);
    }
    appendChild(child) {
      if (child && child.isFragment) {
        for (const item of child.children) this.children.push(item);
        child.children = [];
      } else if (child) {
        this.children.push(child);
      }
      return child;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    addEventListener(ev, fn) {
      this.listeners[ev] = this.listeners[ev] || [];
      this.listeners[ev].push(fn);
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    remove() {}
    scrollIntoView() {}
    focus() {}
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const results = [];
      const matches = (node) => {
        if (sel.startsWith('#')) return node.id === sel.slice(1);
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          return String(node.className || '').split(/\s+/).includes(cls);
        }
        return node.tagName.toLowerCase() === sel.toLowerCase();
      };
      const walk = (n) => {
        for (const c of n.children) {
          if (matches(c)) results.push(c);
          walk(c);
        }
      };
      walk(this);
      return results;
    }
  }

  const doc = {
    createElement: (tag) => new MockNode(tag),
    createDocumentFragment: () => Object.assign(new MockNode('#fragment'), { isFragment: true })
  };

  return { doc, MockNode, innerHtmlWrites };
}

test('getListenConfig defaults HOST=127.0.0.1 and ties default ALLOW_LOCAL_LLM to loopback host', () => {
  const defaultCfg = getListenConfig({});
  assert.equal(defaultCfg.host, '127.0.0.1');
  assert.equal(defaultCfg.port, 3456);
  assert.equal(defaultCfg.allowLocalLlm, true);

  assert.equal(getListenConfig({ HOST: 'localhost' }).allowLocalLlm, true);
  assert.equal(getListenConfig({ HOST: '::1' }).allowLocalLlm, true);

  const exposedCfg = getListenConfig({ HOST: '0.0.0.0', PORT: '8080' });
  assert.equal(exposedCfg.host, '0.0.0.0');
  assert.equal(exposedCfg.port, 8080);
  assert.equal(exposedCfg.allowLocalLlm, false);

  assert.equal(getListenConfig({ HOST: '0.0.0.0', ALLOW_LOCAL_LLM: 'true' }).allowLocalLlm, true);
  assert.equal(getListenConfig({ HOST: '127.0.0.1', ALLOW_LOCAL_LLM: 'false' }).allowLocalLlm, false);

  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('classifyIp distinguishes loopback, private, link-local, reserved, and public IPs (IPv4 & IPv6)', () => {
  assert.equal(classifyIp('127.0.0.1'), 'loopback');
  assert.equal(classifyIp('127.0.0.53'), 'loopback');
  assert.equal(classifyIp('::1'), 'loopback');
  assert.equal(classifyIp('::ffff:127.0.0.1'), 'loopback');

  for (const priv of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', 'fc00::1', 'fd12:3456:789a::1', '::ffff:10.0.0.1']) {
    assert.equal(classifyIp(priv), 'private', `Expected ${priv} to be private`);
  }

  for (const ll of ['169.254.169.254', 'fe80::1', '::ffff:169.254.169.254']) {
    assert.equal(classifyIp(ll), 'link-local', `Expected ${ll} to be link-local`);
  }

  for (const res of ['0.0.0.0', '::', '224.0.0.1', '255.255.255.255', 'ff02::1']) {
    assert.equal(classifyIp(res), 'reserved', `Expected ${res} to be reserved`);
  }

  for (const pub of ['1.1.1.1', '8.8.8.8', '104.18.32.47', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(classifyIp(pub), 'public', `Expected ${pub} to be public`);
  }
});

test('validateBaseUrl blocks loopback, private, link-local, IPv6 internal, numeric IP, and non-local HTTP', async () => {
  await assert.rejects(
    () => validateBaseUrl('http://api.openai.com/v1', { allowLocal: false }),
    (err) => /https/i.test(err.message)
  );

  for (const target of [
    'https://127.0.0.1/v1',
    'https://localhost/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.8/v1',
    'https://172.16.5.4/v1',
    'https://192.168.0.10/v1',
    'https://[::1]/v1',
    'https://[fe80::1]/v1',
    'https://[fd00::1]/v1',
    'https://2130706433/v1',
    'https://0x7f000001/v1',
    'https://0177.0.0.1/v1',
    'https://127.1/v1',
    'https://user:pass@api.openai.com/v1'
  ]) {
    await assert.rejects(() => validateBaseUrl(target, { allowLocal: false }), `Should block ${target}`);
  }

  await assert.rejects(
    () =>
      validateBaseUrl('http://192.168.1.50:11434/v1', {
        allowLocal: true,
        serverAllowLocal: true
      }),
    (err) => /回环/.test(err.message)
  );

  await assert.rejects(
    () =>
      validateBaseUrl('https://evil-rebind.example.com/v1', {
        allowLocal: false,
        lookupFn: async () => [{ address: '169.254.169.254', family: 4 }]
      }),
    (err) => /内网或保留地址/.test(err.message)
  );

  // Server-side ALLOW_LOCAL_LLM=false blocks client allowLocal=true
  await assert.rejects(
    () =>
      validateBaseUrl('http://127.0.0.1:11434/v1', {
        allowLocal: true,
        serverAllowLocal: false
      }),
    (err) => /ALLOW_LOCAL_LLM|禁止访问/.test(err.message)
  );
});

test('validateBaseUrl permits public HTTPS and explicit local loopback HTTP (allowLocal: true)', async () => {
  const pubRes = await validateBaseUrl('https://api.deepseek.com/v1', {
    allowLocal: false,
    serverAllowLocal: false,
    lookupFn: async () => [{ address: '104.18.32.47', family: 4 }]
  });
  assert.equal(pubRes.url, 'https://api.deepseek.com/v1');
  assert.equal(pubRes.allowLocal, false);

  const localIpRes = await validateBaseUrl('http://127.0.0.1:11434/v1', {
    allowLocal: true,
    serverAllowLocal: true
  });
  assert.equal(localIpRes.url, 'http://127.0.0.1:11434/v1');
  assert.equal(localIpRes.allowLocal, true);

  const localNameRes = await validateBaseUrl('http://localhost:11434/v1', {
    allowLocal: true,
    serverAllowLocal: true
  });
  assert.equal(localNameRes.url, 'http://localhost:11434/v1');
  assert.equal(localNameRes.allowLocal, true);
});

test('DNS rebinding: connect-time custom lookup blocks private IP even if earlier lookup returned public IP, and preserves TLS SNI', async () => {
  let stage = 0;
  // Simulate classic TOCTOU DNS rebinding: 1st resolution returns public IP, connect-time resolution flips to private metadata IP
  const rebindingLookup = async () => {
    stage += 1;
    if (stage === 1) return [{ address: '104.18.32.47', family: 4 }];
    return [{ address: '169.254.169.254', family: 4 }];
  };

  // Pre-check succeeds on 1st resolution
  const pre = await validateBaseUrl('https://rebind-test.example.com/v1', {
    allowLocal: false,
    serverAllowLocal: false,
    lookupFn: rebindingLookup
  });
  assert.deepEqual(pre.resolvedIps, ['104.18.32.47']);

  // Now connect-time lookup runs (2nd resolution returns 169.254.169.254) -> MUST be blocked while preserving SNI/hostname
  let capturedReqOptions = null;
  const mockRequestImpl = (options, cb) => {
    capturedReqOptions = options;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (err) => req.emit('error', err);
    req.end = () => {
      options.lookup(options.hostname, { all: true }, (err) => {
        if (err) {
          req.emit('error', err);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
        res.emit('end');
      });
    };
    return req;
  };

  await assert.rejects(
    () =>
      testConnection({
        baseUrl: 'https://rebind-test.example.com/v1',
        apiKey: 'sk-test-1234567890',
        model: 'deepseek-chat',
        allowLocal: false,
        serverAllowLocal: false,
        lookupFn: rebindingLookup,
        requestImpl: mockRequestImpl
      }),
    (err) => /DNS Rebinding|内网或保留地址/.test(err.message)
  );

  assert.equal(stage, 2, 'Connect-time lookup must trigger the 2nd resolution and catch the rebind');
  assert.equal(capturedReqOptions.hostname, 'rebind-test.example.com', 'Host header hostname must be preserved');
  assert.equal(capturedReqOptions.servername, 'rebind-test.example.com', 'TLS SNI servername must be preserved');
});

test('callChatCompletion performs strictly ONE connect-time DNS lookup (zero double-resolution) and preserves SNI', async () => {
  let lookupCallCount = 0;
  let capturedOptions = null;

  const lookupFn = async (hostname) => {
    lookupCallCount += 1;
    assert.equal(hostname, 'api.deepseek.com');
    return [{ address: '104.18.32.47', family: 4 }];
  };

  const mockRequestImpl = (options, cb) => {
    capturedOptions = options;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      options.lookup(options.hostname, { all: true }, (err, list) => {
        if (err) return req.emit('error', err);
        assert.equal(list[0].address, '104.18.32.47');
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit(
          'data',
          Buffer.from(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: 'OK' } }] }))
        );
        res.emit('end');
      });
    };
    return req;
  };

  const result = await callChatCompletion({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-1234567890',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'ping' }],
    allowLocal: false,
    serverAllowLocal: false,
    lookupFn,
    requestImpl: mockRequestImpl
  });

  assert.equal(result.content, 'OK');
  assert.equal(lookupCallCount, 1, 'callChatCompletion must perform strictly 1 DNS lookup at connect time');
  assert.equal(capturedOptions.hostname, 'api.deepseek.com', 'Original hostname must be preserved for Host header');
  assert.equal(capturedOptions.servername, 'api.deepseek.com', 'TLS SNI servername must match original hostname');
});

test('createSafeLookup supports both { all: true } and single-address callback styles', async () => {
  const safeLookup = createSafeLookup({
    allowLocal: false,
    serverAllowLocal: false,
    lookupFn: async () => [
      { address: '104.18.32.47', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 }
    ]
  });

  // { all: true } style
  const allList = await new Promise((resolve, reject) => {
    safeLookup('api.example.com', { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
  assert.ok(Array.isArray(allList) && allList.length === 2);
  assert.equal(allList[0].address, '104.18.32.47');
  assert.equal(allList[1].family, 6);

  // Single-address (hostname, callback) style
  const single = await new Promise((resolve, reject) => {
    safeLookup('api.example.com', (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  assert.equal(single.address, '104.18.32.47');
  assert.equal(single.family, 4);

  // Private IP rejected in single-address style as well
  const blockedLookup = createSafeLookup({
    allowLocal: false,
    serverAllowLocal: false,
    lookupFn: async () => [{ address: '10.0.0.12', family: 4 }]
  });
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        blockedLookup('internal.example.com', (err, addr) => (err ? reject(err) : resolve(addr)));
      }),
    /DNS Rebinding/
  );
});

test('real native http.request connects to local loopback server using connect-time custom lookup', async () => {
  let receivedHostHeader = '';
  let receivedAuthHeader = '';
  let receivedPath = '';

  const localLlm = http.createServer((req, res) => {
    receivedHostHeader = req.headers.host || '';
    receivedAuthHeader = req.headers.authorization || '';
    receivedPath = req.url || '';
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(
        JSON.stringify({
          model: 'qwen2.5:14b',
          choices: [{ message: { content: 'NATIVE_LOOPBACK_OK' } }]
        })
      );
    });
  });

  await new Promise((r) => localLlm.listen(0, '127.0.0.1', r));
  const { port } = localLlm.address();

  let lookupHits = 0;
  try {
    const out = await callChatCompletion({
      baseUrl: `http://localhost:${port}/v1`,
      apiKey: '',
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: 'hi' }],
      allowLocal: true,
      serverAllowLocal: true,
      lookupFn: (host, opts, cb) => {
        lookupHits += 1;
        const callback = typeof opts === 'function' ? opts : cb;
        const wantAll = typeof opts === 'object' && opts?.all;
        if (wantAll) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      }
      // Deliberately NO requestImpl -> exercises real Node.js native http.request!
    });

    assert.equal(out.content, 'NATIVE_LOOPBACK_OK');
    assert.equal(lookupHits, 1, 'Native http.request must invoke custom lookup exactly once');
    assert.equal(receivedHostHeader, `localhost:${port}`, 'Host header must preserve original localhost:port');
    assert.equal(receivedPath, '/v1/chat/completions');
    assert.equal(receivedAuthHeader, '');
  } finally {
    if (typeof localLlm.closeAllConnections === 'function') localLlm.closeAllConnections();
    await new Promise((r) => localLlm.close(r));
  }
});

test('callChatCompletion rejects upstream 3xx redirects without following and returns explicit error message', async () => {
  for (const statusCode of [301, 302, 307, 308]) {
    let reqCount = 0;
    const mockRedirectRequestImpl = (options, cb) => {
      reqCount += 1;
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.headers = { location: 'http://169.254.169.254/latest/meta-data/' };
        cb(res);
        res.emit('end');
      };
      return req;
    };

    await assert.rejects(
      () =>
        callChatCompletion({
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-secret-key-9876543210abcdef',
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          lookupFn: async () => [{ address: '104.18.32.47', family: 4 }],
          requestImpl: mockRedirectRequestImpl
        }),
      (err) => /上游返回了重定向.*请检查 Base URL/.test(err.message),
      `HTTP ${statusCode} redirect must be rejected with explicit Chinese message`
    );
    assert.equal(reqCount, 1, `HTTP ${statusCode} redirect must NOT be followed`);
  }
});

test('redactSecrets strips raw API keys, Bearer tokens, Authorization headers, and JSON key fields', async () => {
  const rawKey = 'sk-proj-SuperSecretKey1234567890ABCDEF';
  const sample = `Upstream failed: Authorization: Bearer ${rawKey}, "apiKey":"${rawKey}", key=${rawKey}`;
  const scrubbed = redactSecrets(sample, rawKey);

  assert.equal(scrubbed.includes(rawKey), false);
  assert.match(scrubbed, /REDACTED/);

  const mockErrorRequestImpl = (options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 401;
      res.headers = {};
      cb(res);
      res.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${rawKey}.`
            }
          })
        )
      );
      res.emit('end');
    };
    return req;
  };

  await assert.rejects(
    () =>
      callChatCompletion({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: rawKey,
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        lookupFn: async () => [{ address: '104.18.32.47', family: 4 }],
        requestImpl: mockErrorRequestImpl
      }),
    (err) => {
      assert.equal(err.message.includes(rawKey), false, 'Error message must not leak raw API key');
      assert.match(err.message, /REDACTED/);
      return true;
    }
  );
});

test('HTTP /api/ai/test and /api/ai/chat enforce SSRF policy, server-side ALLOW_LOCAL_LLM gate, and secret redaction', async () => {
  const rawKey = 'sk-http-SuperSecretLeakTest99887766';
  const mock401Impl = (options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 401;
      res.headers = {};
      cb(res);
      res.emit('data', Buffer.from(`{"error":{"message":"Invalid token Bearer ${rawKey}"}}`));
      res.emit('end');
    };
    return req;
  };

  const cfg = getListenConfig({ HOST: '0.0.0.0' });
  assert.equal(cfg.allowLocalLlm, false);

  const srv = createAppServer({
    allowLocalLlm: cfg.allowLocalLlm,
    lookupFn: async () => [{ address: '104.18.32.47', family: 4 }],
    requestImpl: mock401Impl
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    // 1) Server ALLOW_LOCAL_LLM=false blocks client allowLocal=true on BOTH /api/ai/test and /api/ai/chat
    const localTestRes = await postJson(port, '/api/ai/test', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen2.5',
      allowLocal: true
    });
    assert.equal(localTestRes.status, 400);
    assert.match(localTestRes.json.error, /ALLOW_LOCAL_LLM|禁止访问/);

    const localChatRes = await postJson(port, '/api/ai/chat', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen2.5',
      allowLocal: true,
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(localChatRes.status, 400);
    assert.match(localChatRes.json.error, /ALLOW_LOCAL_LLM|禁止访问/);

    // 2) Metadata SSRF blocked with HTTP 400 on /api/ai/chat
    const ssrfRes = await postJson(port, '/api/ai/chat', {
      baseUrl: 'https://169.254.169.254/latest/meta-data',
      apiKey: rawKey,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(ssrfRes.status, 400);
    assert.equal(ssrfRes.raw.includes(rawKey), false);

    // 3) Upstream 401 secret redaction on BOTH /api/ai/test and /api/ai/chat
    const leakTestRes = await postJson(port, '/api/ai/test', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: rawKey,
      model: 'gpt-4o-mini'
    });
    assert.equal(leakTestRes.status, 502);
    assert.equal(leakTestRes.raw.includes(rawKey), false, '/api/ai/test must redact raw API key');
    assert.match(leakTestRes.json.error, /REDACTED/);

    const leakChatRes = await postJson(port, '/api/ai/chat', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: rawKey,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(leakChatRes.status, 502);
    assert.equal(leakChatRes.raw.includes(rawKey), false, '/api/ai/chat must redact raw API key');
    assert.match(leakChatRes.json.error, /REDACTED/);
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('sanitize.js escapes <script> and <img onerror> payloads and blocks unsafe image URLs', async () => {
  const sanitizeMod = await import('../public/js/sanitize.js');
  const malicious = `<img src=x onerror="window.__xss=1"><script>alert(1)</script><a href="javascript:alert(2)">click</a>`;
  const escaped = sanitizeMod.escapeHtml(malicious);

  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('<img'), false);
  assert.match(escaped, /&lt;img src=x onerror=&quot;window\.__xss=1&quot;&gt;/);
  assert.equal(sanitizeMod.sanitizeImageDataUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeMod.sanitizeImageDataUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeMod.sanitizeImageDataUrl('https://evil.example.com/a.png'), null);
  assert.equal(
    sanitizeMod.sanitizeImageDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'),
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'
  );
});

test('AICopilotController and SymbolSearchModal render untrusted reportText and symbol names via textContent without innerHTML', async () => {
  const { doc, MockNode, innerHtmlWrites } = createStrictMockDom();
  const prevDoc = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = doc;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.requestAnimationFrame = () => {};

  try {
    const { SymbolSearchModal } = await import('../public/js/symbolSearch.js');
    const { AICopilotController, PROVIDER_PRESETS } = await import('../public/js/aiCopilot.js');

    // Verify Ollama vs Custom preset separation
    assert.equal(PROVIDER_PRESETS.ollama.allowLocal, true);
    assert.equal(PROVIDER_PRESETS.custom.allowLocal, false);
    assert.match(PROVIDER_PRESETS.ollama.baseUrl, /^http:\/\/127\.0\.0\.1/);
    assert.match(PROVIDER_PRESETS.custom.baseUrl, /^https:\/\//);

    // 1) SymbolSearchModal.render() with malicious XSS symbol & name
    const modalEl = new MockNode('div');
    const inputEl = Object.assign(new MockNode('input'), { id: 'symbolSearchInput' });
    const closeBtn = Object.assign(new MockNode('button'), { id: 'symbolSearchClose' });
    const resultsEl = Object.assign(new MockNode('div'), { id: 'symbolSearchResults' });
    const statusEl = Object.assign(new MockNode('div'), { id: 'symbolSearchStatus' });
    modalEl.append(inputEl, closeBtn, resultsEl, statusEl);

    const searchModal = new SymbolSearchModal(modalEl);
    const xssPayload = '<img src=x onerror="window.__xss=1"><script>alert(1)</script>';
    searchModal.items = [
      {
        symbol: 'EVIL.NS',
        displaySymbol: `EVIL ${xssPayload}`,
        name: `Corp ${xssPayload}`,
        enName: `Corp EN ${xssPayload}`,
        exchange: 'NSE',
        market: 'in',
        type: '印股'
      }
    ];
    searchModal.render();

    assert.equal(innerHtmlWrites.length, 0, 'SymbolSearchModal.render must never assign innerHTML');
    const renderedName = resultsEl.querySelector('.search-name');
    assert.ok(renderedName, 'Rendered symbol name element must exist');
    assert.equal(renderedName.textContent, `Corp ${xssPayload}`);

    // 2) AICopilotController._appendUserMessage & _appendAssistantMessage with untrusted payloads
    const chatFeed = new MockNode('div');
    const welcomeEl = new MockNode('div');
    const copilot = new AICopilotController({
      chartEngine: { candles: [], instrument: { symbol: 'RELIANCE.NS' }, interval: '1d' },
      chatFeedEl: chatFeed,
      welcomeEl
    });

    copilot._appendUserMessage(`分析 ${xssPayload}`);
    const cardEl = copilot._appendAssistantMessage({
      analysisResult: {
        bias: 'bullish',
        confidence: 80,
        summary: `Summary ${xssPayload}`,
        reportText: `第一段 ${xssPayload}\n\n支撑位： 1300.00\n阻力位： 1400.00`
      },
      annotations: { horizontalLevels: [], trendlines: [], patterns: [] },
      snapshot: null,
      annotatedImageUrl: 'javascript:alert(1)',
      modelLabel: 'mock-model',
      fallbackNotice: '',
      usedDemoMode: false
    });

    assert.equal(innerHtmlWrites.length, 0, 'AICopilotController must never assign innerHTML');
    const reportPre = cardEl.querySelector('.strict-report-body');
    assert.ok(reportPre, 'Report <pre class="strict-report-body"> must be created');
    assert.equal(reportPre.tagName, 'PRE');
    assert.equal(reportPre.children.length, 0, 'textContent must not create child HTML nodes');
    assert.ok(reportPre.textContent.includes(xssPayload));
    assert.ok(reportPre.textContent.includes('\n\n'));
    assert.equal(cardEl.querySelector('.screenshot-preview-img'), null, 'Unsafe javascript: image URL must be blocked');
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLocalStorage;
    globalThis.requestAnimationFrame = prevRaf;
  }
});

test('render.yaml and Dockerfile explicitly set HOST=0.0.0.0 for container and Render deployments', () => {
  const renderYamlPath = path.join(__dirname, '..', 'render.yaml');
  const dockerfilePath = path.join(__dirname, '..', 'Dockerfile');

  const renderLines = fs.readFileSync(renderYamlPath, 'utf8').split(/\r?\n/);
  const renderEnv = {};
  for (let i = 0; i < renderLines.length; i++) {
    const keyMatch = renderLines[i].match(/^\s*-\s*key:\s*(\S+)\s*$/);
    if (keyMatch) {
      const valMatch = (renderLines[i + 1] || '').match(/^\s*value:\s*["']?([^"'\s#]+)["']?\s*$/);
      if (valMatch) {
        renderEnv[keyMatch[1]] = valMatch[1];
      }
    }
  }
  assert.equal(renderEnv.HOST, '0.0.0.0', 'render.yaml envVars must define HOST=0.0.0.0');

  const dockerLines = fs.readFileSync(dockerfilePath, 'utf8').split(/\r?\n/);
  const dockerEnv = {};
  for (const line of dockerLines) {
    const m = line.match(/^\s*ENV\s+(.+)$/);
    if (!m) continue;
    for (const pair of m[1].trim().split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        dockerEnv[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, '');
      }
    }
  }
  assert.equal(dockerEnv.HOST, '0.0.0.0', 'Dockerfile must define ENV HOST=0.0.0.0');

  const cfgFromDocker = getListenConfig(dockerEnv);
  assert.equal(cfgFromDocker.host, '0.0.0.0');
  assert.equal(cfgFromDocker.allowLocalLlm, false);
});

test('validateBaseUrl rejects raw numeric-encoded hosts (decimal/hex/octal/shorthand) before URL normalization even when allowLocal=true, and rejects mixed public+private DNS records', async () => {
  const numericHosts = ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.0.0.1', '127.0.1'];

  for (const host of numericHosts) {
    await assert.rejects(
      () => validateBaseUrl(`https://${host}/v1`, { allowLocal: false, serverAllowLocal: false }),
      (err) => /数值编码/.test(err.message),
      `Cloud mode must reject numeric host ${host} as suspicious numeric encoding`
    );

    await assert.rejects(
      () => validateBaseUrl(`http://${host}:11434/v1`, { allowLocal: true, serverAllowLocal: true }),
      (err) => /数值编码/.test(err.message),
      `Local mode (allowLocal=true) must ALSO reject numeric host ${host}`
    );
  }

  const okLocal = await validateBaseUrl('http://127.0.0.1:11434/v1', {
    allowLocal: true,
    serverAllowLocal: true
  });
  assert.equal(okLocal.allowLocal, true);

  await assert.rejects(
    () =>
      validateBaseUrl('https://dual-dns.example.com/v1', {
        allowLocal: false,
        serverAllowLocal: false,
        lookupFn: async () => [
          { address: '104.18.32.47', family: 4 },
          { address: '10.0.0.5', family: 4 }
        ]
      }),
    (err) => /内网或保留地址/.test(err.message)
  );
});
