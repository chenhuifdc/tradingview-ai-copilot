/**
 * Universal BYOK OpenAI-compatible AI Proxy with SSRF protection,
 * connect-time DNS rebinding defense, server-side ALLOW_LOCAL_LLM gate,
 * redirect blocking, and API key secret redaction.
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { URL } = require('node:url');

/**
 * Classify an IPv4 or IPv6 address into:
 * - 'loopback'
 * - 'private'
 * - 'link-local'
 * - 'reserved'
 * - 'public'
 * - 'invalid'
 */
function classifyIp(ipInput) {
  if (typeof ipInput !== 'string') return 'invalid';
  let ip = ipInput.trim().replace(/^\[|\]$/g, '');
  if (!ip) return 'invalid';

  // Strip IPv6 zone index if present (e.g. fe80::1%eth0)
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    return classifyIp(v4MappedMatch[1]);
  }
  const v4MappedHexMatch = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHexMatch) {
    const hi = parseInt(v4MappedHexMatch[1], 16);
    const lo = parseInt(v4MappedHexMatch[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return classifyIp(ipv4);
  }

  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
      return 'invalid';
    }
    const [a, b, c] = parts;
    if (a === 127) return 'loopback';
    if (a === 0) return 'reserved';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
    if (a === 198 && (b === 18 || b === 19)) return 'private';
    if (a === 198 && b === 51 && c === 100) return 'reserved';
    if (a === 203 && b === 0 && c === 113) return 'reserved';
    if (a >= 224) return 'reserved'; // Multicast & broadcast
    return 'public';
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback';
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'reserved';
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]:/i.test(lower) || lower.startsWith('fe80:')) return 'link-local';
    // fc00::/7 Unique Local Addresses (fc00:: - fdff::)
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return 'private';
    // ff00::/8 multicast
    if (/^ff[0-9a-f]{2}:/i.test(lower)) return 'reserved';
    // 2001:db8::/32 documentation
    if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return 'reserved';
    return 'public';
  }

  return 'invalid';
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  return classifyIp(h) === 'loopback';
}

function isSuspiciousNumericHost(hostname) {
  const h = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (/^\d+$/.test(h)) return true; // Decimal integer IP like 2130706433
  if (/^0x[0-9a-f]+$/i.test(h)) return true; // Hex IP like 0x7f000001
  if (/^0\d+\./.test(h)) return true; // Octal dotted IP like 0177.0.0.1
  return false;
}

/**
 * Strip raw API keys, Bearer tokens, Authorization headers, and JSON secret fields from any error message or log string.
 */
function redactSecrets(text, explicitKey = '') {
  if (text === null || text === undefined) return '';
  let out = String(text);

  if (explicitKey && typeof explicitKey === 'string' && explicitKey.trim().length >= 4) {
    const escaped = explicitKey.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }

  // Redact Bearer tokens
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{6,}/gi, 'Bearer [REDACTED]');
  // Redact sk- / pk- / rk- / gsk_ / AIza style keys
  out = out.replace(/\b(sk|pk|rk|gsk)-[A-Za-z0-9_\-]{6,}\b/g, '$1-[REDACTED]');
  // Redact JSON or query fields named apiKey, api_key, authorization, token, secret
  out = out.replace(
    /(["']?(?:apiKey|api_key|authorization|x-api-key|secret|token)["']?\s*[:=]\s*["']?)([^"'\s,}]+)(["']?)/gi,
    '$1[REDACTED]$3'
  );

  return out;
}

function normalizeBaseUrl(rawUrl) {
  let url = (rawUrl || 'https://api.deepseek.com/v1').trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  url = url.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return url;
}

/**
 * Validate user-supplied `baseUrl` against SSRF rules:
 * - Only HTTPS allowed by default; HTTP is permitted ONLY when `allowLocal === true` AND `serverAllowLocal === true` AND target is loopback.
 * - Rejects credentials in URL, non-standard control characters, numeric IP encodings, private/link-local/reserved IPs.
 * - Resolves DNS via `lookupFn` and verifies every resolved address.
 */
async function validateBaseUrl(
  rawUrl,
  {
    allowLocal = false,
    serverAllowLocal = true,
    lookupFn = dns.promises.lookup
  } = {}
) {
  const rawStr = String(rawUrl || '').trim();
  if (!rawStr) {
    throw new Error('Base URL 不能为空');
  }

  let parsed;
  try {
    parsed = new URL(rawStr);
  } catch {
    throw new Error('Base URL 格式无效，请输入合法的 URL');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Base URL 不允许包含用户名或密码凭据');
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('Base URL 仅支持 https 协议');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new Error('Base URL 缺少有效主机名');
  }

  if (isSuspiciousNumericHost(hostname)) {
    throw new Error('Base URL 禁止使用非标准数值编码 IP 地址');
  }

  if (allowLocal && !serverAllowLocal) {
    throw new Error('当前服务端未开启本地模型访问权限 (ALLOW_LOCAL_LLM)，禁止访问回环或本地地址');
  }

  const effectiveAllowLocal = Boolean(allowLocal && serverAllowLocal);
  const directIpKind = classifyIp(hostname);

  if (protocol === 'http:') {
    if (!effectiveAllowLocal) {
      throw new Error('出于安全限制，云端模型 Base URL 必须使用 https://（本地 Ollama 需开启本地模式并指向回环地址）');
    }
    const isLocalTarget = hostname === 'localhost' || directIpKind === 'loopback';
    if (!isLocalTarget) {
      throw new Error('http:// 协议仅允许用于本地回环地址 (127.0.0.1 / ::1 / localhost)');
    }
  }

  if (directIpKind !== 'invalid') {
    if (directIpKind === 'loopback') {
      if (!effectiveAllowLocal) {
        throw new Error('禁止访问本地回环地址 (Loopback SSRF 拦截)');
      }
      return { url: normalizeBaseUrl(rawStr), parsed, hostname, resolvedIps: [hostname], allowLocal: effectiveAllowLocal };
    }
    if (directIpKind !== 'public') {
      throw new Error(`禁止访问内网或保留地址 (${directIpKind} SSRF 拦截)`);
    }
    return { url: normalizeBaseUrl(rawStr), parsed, hostname, resolvedIps: [hostname], allowLocal: effectiveAllowLocal };
  }

  // Hostname is a domain name -> resolve DNS and verify all records
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (!effectiveAllowLocal) {
      throw new Error('禁止访问 localhost 回环地址');
    }
    return { url: normalizeBaseUrl(rawStr), parsed, hostname, resolvedIps: ['127.0.0.1'], allowLocal: effectiveAllowLocal };
  }

  let records;
  try {
    const res = await lookupFn(hostname, { all: true, verbatim: true });
    records = Array.isArray(res) ? res : [res];
  } catch (err) {
    throw new Error(`域名解析失败 (${hostname})：${err.message}`);
  }

  if (!records.length) {
    throw new Error(`域名未能解析到有效 IP (${hostname})`);
  }

  const resolvedIps = [];
  for (const rec of records) {
    const addr = typeof rec === 'string' ? rec : rec?.address;
    const kind = classifyIp(addr);
    if (kind === 'loopback') {
      if (!effectiveAllowLocal) {
        throw new Error(`域名 ${hostname} 解析到了本地回环地址 (${addr})，已被安全策略拦截`);
      }
    } else if (kind !== 'public') {
      throw new Error(`域名 ${hostname} 解析到了内网或保留地址 (${addr} [${kind}])，已被安全策略拦截`);
    }
    resolvedIps.push(addr);
  }

  return {
    url: normalizeBaseUrl(rawStr),
    parsed,
    hostname,
    resolvedIps,
    allowLocal: effectiveAllowLocal
  };
}

/**
 * Create a connect-time custom `lookup` callback for `http.request` / `https.request`
 * that validates every resolved IP right at socket connection time, eliminating DNS Rebinding TOCTOU
 * while keeping the original hostname in the URL/TLS SNI.
 */
function createSafeLookup({ allowLocal = false, serverAllowLocal = true, lookupFn = dns.lookup } = {}) {
  const effectiveAllowLocal = Boolean(allowLocal && serverAllowLocal);

  const invokeUnderlyingLookup = (hostname, opts) =>
    new Promise((resolve, reject) => {
      if (lookupFn.length >= 3 || lookupFn === dns.lookup) {
        lookupFn(hostname, opts, (err, address, family) => {
          if (err) return reject(err);
          resolve({ address, family });
        });
      } else {
        Promise.resolve(lookupFn(hostname, opts))
          .then((res) => {
            if (Array.isArray(res)) {
              resolve({ address: res, family: res[0]?.family || 4 });
            } else if (res && typeof res === 'object' && 'address' in res) {
              resolve({ address: res.address, family: res.family || 4 });
            } else {
              resolve({ address: res, family: net.isIP(String(res)) || 4 });
            }
          })
          .catch(reject);
      }
    });

  return function safeLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    const wantAll = Boolean(opts.all);

    invokeUnderlyingLookup(hostname, { ...opts, all: true })
      .then(({ address }) => {
        const list = Array.isArray(address)
          ? address.map((item) =>
              typeof item === 'string'
                ? { address: item, family: net.isIP(item) || 4 }
                : { address: item.address, family: item.family || net.isIP(item.address) || 4 }
            )
          : [{ address: String(address), family: net.isIP(String(address)) || 4 }];

        if (!list.length || !list[0].address) {
          throw new Error(`DNS lookup returned no address for ${hostname}`);
        }

        for (const entry of list) {
          const kind = classifyIp(entry.address);
          if (kind === 'loopback') {
            if (!effectiveAllowLocal) {
              throw new Error(`DNS Rebinding 拦截：${hostname} 解析到了回环地址 ${entry.address}`);
            }
          } else if (kind !== 'public') {
            throw new Error(`DNS Rebinding 拦截：${hostname} 解析到了内网或保留地址 ${entry.address} (${kind})`);
          }
        }

        if (wantAll) {
          cb(null, list);
        } else {
          cb(null, list[0].address, list[0].family);
        }
      })
      .catch((err) => {
        cb(err);
      });
  };
}

function buildHeaders(apiKey, baseUrl) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  if (/openrouter\.ai/i.test(baseUrl)) {
    headers['HTTP-Referer'] = 'https://chartcopilot.local';
    headers['X-Title'] = 'ChartCopilot TradingView AI';
  }
  return headers;
}

function formatProviderError(status, bodyText, apiKey = '') {
  let parsedMsg = '';
  try {
    const j = JSON.parse(bodyText);
    parsedMsg = j?.error?.message || j?.message || j?.detail || '';
  } catch {
    parsedMsg = bodyText?.slice(0, 260) || '';
  }
  parsedMsg = redactSecrets(parsedMsg, apiKey);

  if (status === 401) {
    return `API Key 认证失败 (401)：请检查您的 API Key 是否正确或已过期。${parsedMsg ? ` [${parsedMsg}]` : ''}`;
  }
  if (status === 402) {
    return `账户余额不足 (402)：请检查 API 服务商额度。${parsedMsg ? ` [${parsedMsg}]` : ''}`;
  }
  if (status === 404) {
    return `接口或模型未找到 (404)：请核对 Base URL 和模型名称是否正确。${parsedMsg ? ` [${parsedMsg}]` : ''}`;
  }
  if (status === 429) {
    return `请求触发限流 (429)：请稍后重试或切换模型。${parsedMsg ? ` [${parsedMsg}]` : ''}`;
  }
  return `模型服务返回错误 (HTTP ${status})：${parsedMsg || '未知错误'}`;
}

/**
 * Perform single-resolution HTTP/HTTPS POST request using native `http.request` / `https.request`
 * with connect-time `createSafeLookup` and strict redirect rejection.
 */
function executeNativePostRequest(endpointUrl, { headers, bodyStr, timeoutMs = 75000, lookup, requestImpl }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpointUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = requestImpl || (isHttps ? https.request : http.request);

    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(bodyStr, 'utf8')
      },
      lookup,
      servername: isHttps && net.isIP(parsed.hostname) === 0 ? parsed.hostname : undefined
    };

    const req = transport(reqOptions, (res) => {
      const status = res.statusCode || 500;
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      res.on('end', () => {
        clearTimeout(timer);
        const rawText = Buffer.concat(chunks).toString('utf8');
        resolve({ status, headers: res.headers || {}, rawText });
      });
    });

    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Request timed out'), { name: 'AbortError' }));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('close', () => {
      clearTimeout(timer);
    });

    req.write(bodyStr);
    req.end();
  });
}

async function callChatCompletion({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature = 0.25,
  maxTokens = 3200,
  allowLocal = false,
  serverAllowLocal = true,
  lookupFn,
  requestImpl
}) {
  // Pre-validate URL structure, protocol, and direct IP literals without performing a separate DNS lookup
  // when connect-time safeLookup is used, so DNS is resolved strictly ONCE at connect time!
  await validateBaseUrl(baseUrl || 'https://api.deepseek.com/v1', {
    allowLocal,
    serverAllowLocal,
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }]
  });

  const cleanBase = normalizeBaseUrl(baseUrl);
  const endpoint = `${cleanBase}/chat/completions`;

  const body = {
    model: (model || 'deepseek-chat').trim(),
    messages,
    max_tokens: maxTokens
  };

  const isReasoningModel = /(reasoner|^o1|^o3|r1)/i.test(body.model);
  if (!isReasoningModel && typeof temperature === 'number') {
    body.temperature = temperature;
  }

  const safeLookup = createSafeLookup({
    allowLocal,
    serverAllowLocal,
    lookupFn: lookupFn || dns.lookup
  });

  const startedAt = Date.now();

  try {
    const { status, rawText } = await executeNativePostRequest(endpoint, {
      headers: buildHeaders(apiKey, cleanBase),
      bodyStr: JSON.stringify(body),
      timeoutMs: 75000,
      lookup: safeLookup,
      requestImpl
    });

    if (status >= 300 && status < 400) {
      throw new Error(`上游返回了重定向 (HTTP ${status})，请检查 Base URL`);
    }

    if (status < 200 || status >= 300) {
      throw new Error(formatProviderError(status, rawText, apiKey));
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error('模型返回了非 JSON 格式的响应，请检查 Base URL 是否指向 OpenAI 兼容接口。');
    }

    const choice = json?.choices?.[0];
    const message = choice?.message || {};
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p) => p?.text || '').join('\n')
        : '';

    const reasoning = message.reasoning_content || '';

    return {
      content,
      reasoning,
      model: json?.model || body.model,
      usage: json?.usage || null,
      latencyMs: Date.now() - startedAt
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('模型请求超时（超过 75 秒），请检查网络连接或更换响应更快的模型。');
    }
    throw new Error(redactSecrets(err.message || '调用模型失败', apiKey));
  }
}

async function testConnection({
  apiKey,
  baseUrl,
  model,
  allowLocal = false,
  serverAllowLocal = true,
  lookupFn,
  requestImpl
}) {
  const result = await callChatCompletion({
    apiKey,
    baseUrl,
    model,
    allowLocal,
    serverAllowLocal,
    lookupFn,
    requestImpl,
    messages: [{ role: 'user', content: 'Reply with OK only.' }],
    temperature: 0,
    maxTokens: 16
  });

  return {
    ok: true,
    model: result.model,
    latencyMs: result.latencyMs,
    reply: (result.content || 'OK').trim().slice(0, 60)
  };
}

module.exports = {
  callChatCompletion,
  testConnection,
  normalizeBaseUrl,
  classifyIp,
  validateBaseUrl,
  createSafeLookup,
  redactSecrets,
  isLoopbackHost
};
