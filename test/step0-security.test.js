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
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

test('0.1 server.js defaults to 127.0.0.1 and honours HOST env override', () => {
  const defaultCfg = getListenConfig({});
  assert.equal(defaultCfg.host, '127.0.0.1');
  assert.equal(defaultCfg.allowLocalLlm, true);

  const customCfg = getListenConfig({ HOST: '0.0.0.0', PORT: '8080' });
  assert.equal(customCfg.host, '0.0.0.0');
  assert.equal(customCfg.port, 8080);
  assert.equal(customCfg.allowLocalLlm, false);

  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('0.1b Server-side ALLOW_LOCAL_LLM gate prevents client allowLocal bypass when HOST=0.0.0.0', async () => {
  assert.equal(getListenConfig({ HOST: '127.0.0.1' }).allowLocalLlm, true);
  assert.equal(getListenConfig({ HOST: '0.0.0.0' }).allowLocalLlm, false);
  assert.equal(getListenConfig({ HOST: '0.0.0.0', ALLOW_LOCAL_LLM: 'true' }).allowLocalLlm, true);
  assert.equal(getListenConfig({ HOST: '127.0.0.1', ALLOW_LOCAL_LLM: 'false' }).allowLocalLlm, false);

  await assert.rejects(
    () =>
      validateBaseUrl('http://127.0.0.1:11434/v1', {
        allowLocal: true,
        serverAllowLocal: getListenConfig({ HOST: '0.0.0.0' }).allowLocalLlm
      }),
    (err) => {
      assert.match(err.message, /ALLOW_LOCAL_LLM|禁止访问/);
      return true;
    }
  );

  const cfg = getListenConfig({ HOST: '0.0.0.0' });
  const srv = createAppServer({ allowLocalLlm: cfg.allowLocalLlm });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    const res = await postJson(port, '/api/ai/test', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen2.5',
      allowLocal: true
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /ALLOW_LOCAL_LLM|禁止访问/);
  } finally {
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('0.2 SSRF IP classifier blocks loopback, RFC1918, link-local, metadata, IPv6 unique-local/link-local', () => {
  const blocked = [
    '127.0.0.1',
    '127.0.0.53',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456:789a::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1'
  ];
  for (const ip of blocked) {
    assert.notEqual(classifyIp(ip), 'public', `Expected IP ${ip} to be non-public`);
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '104.18.32.47', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(classifyIp(ip), 'public', `Expected IP ${ip} to be public`);
  }
});

test('0.3 validateBaseUrl blocks non-https, private/metadata IPs, and DNS rebinding to private IPs', async () => {
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
    'https://[fd00::1]/v1'
  ]) {
    await assert.rejects(() => validateBaseUrl(target, { allowLocal: false }));
  }

  await assert.rejects(
    () =>
      validateBaseUrl('https://evil-rebind.example.com/v1', {
        allowLocal: false,
        lookupFn: async () => [{ address: '169.254.169.254', family: 4 }]
      }),
    (err) => /内网或保留地址/.test(err.message)
  );

  const localRes = await validateBaseUrl('http://127.0.0.1:11434/v1', {
    allowLocal: true,
    serverAllowLocal: true
  });
  assert.equal(localRes.allowLocal, true);

  await assert.rejects(() =>
    validateBaseUrl('http://192.168.1.50:11434/v1', {
      allowLocal: true,
      serverAllowLocal: true
    })
  );
});

test('0.4 Single-resolution connect-time lookup prevents TOCTOU DNS rebinding (public on 1st lookup, private on connect)', async () => {
  let lookupCallCount = 0;
  const rebindingLookup = async () => {
    lookupCallCount += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  };

  const mockRequestImpl = (options, cb) => {
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
    (err) => {
      assert.match(err.message, /回环|内网|安全策略拦截/);
      return true;
    }
  );
  assert.equal(lookupCallCount, 1, 'Connect-time lookup must be invoked once and block the private/loopback IP');
});

test('0.5 Redirect responses (301/302/307/308) are rejected with explicit Chinese message', async () => {
  const mockRedirectRequestImpl = (options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
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
    (err) => {
      assert.match(err.message, /上游返回了重定向.*请检查 Base URL/);
      return true;
    }
  );
});

test('0.6 redactSecrets scrubs apiKey, Bearer tokens, and sk-* patterns from errors and logs', async () => {
  const rawKey = 'sk-proj-SuperSecretKey1234567890ABCDEF';
  const sample = `Upstream failed: Authorization: Bearer ${rawKey}, key=${rawKey}`;
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

test('0.7 Frontend XSS protection: sanitize.js escapes HTML/scripts and aiCopilot.js uses textContent for report rendering', async () => {
  const sanitizeMod = await import('../public/js/sanitize.js');
  const malicious = `<img src=x onerror="window.__xss=1"><script>alert(1)</script><a href="javascript:alert(2)">click</a>`;
  const escaped = sanitizeMod.escapeHtml(malicious);

  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('<img'), false);
  assert.match(escaped, /&lt;img src=x onerror=&quot;window\.__xss=1&quot;&gt;/);
  assert.equal(sanitizeMod.sanitizeImageDataUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeMod.sanitizeImageDataUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(
    sanitizeMod.sanitizeImageDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'),
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'
  );

  const copilotJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'aiCopilot.js'), 'utf8');
  assert.equal(
    copilotJs.includes('innerHTML = formatMarkdown'),
    false,
    'aiCopilot.js must not inject report text via innerHTML'
  );
  assert.match(copilotJs, /reportPre\.textContent\s*=\s*cleanReportText/);
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

  // Standard dotted-quad loopback remains permitted when allowLocal && serverAllowLocal
  const okLocal = await validateBaseUrl('http://127.0.0.1:11434/v1', {
    allowLocal: true,
    serverAllowLocal: true
  });
  assert.equal(okLocal.allowLocal, true);

  // Multi-record DNS containing one public IP and one private IP must be rejected
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


