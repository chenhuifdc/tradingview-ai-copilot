const assert = require('node:assert/strict');
const { startMockAppServer, makeMockCandles, withCdpPage } = require('./helpers');
const aiProxy = require('../../server/aiProxy');

async function runStep0BrowserTest(chromeBin) {
  const scriptPayload = '<script>window.__xss=1</script>';
  const imgPayload = '<img src=x onerror="window.__xss=2">';
  const mockCandles = makeMockCandles({ count: 120 });
  const nowSec = mockCandles[mockCandles.length - 1].time;

  const mockMarketService = {
    searchSymbols: async () => ({
      remoteOnline: true,
      results: [
        {
          symbol: 'TEST.NS',
          displaySymbol: `TEST ${scriptPayload}`,
          name: `TestCorp ${imgPayload}`,
          enName: `TestCorp EN ${scriptPayload}`,
          exchange: 'NSE',
          market: 'in',
          type: '印股'
        }
      ]
    }),
    getKlines: async (symbol, interval) => ({
      symbol,
      interval,
      source: 'live',
      feedName: 'Mock Live Feed',
      instrument: {
        symbol,
        displaySymbol: symbol.replace('.NS', ''),
        name: `Alkali ${imgPayload}`,
        enName: 'Alkali Metals',
        exchange: 'NSE',
        market: 'in',
        currency: 'INR'
      },
      candles: mockCandles,
      events: [],
      meta: {
        source: 'live',
        fetchedAt: nowSec * 1000,
        ageMs: 0,
        stale: false,
        provider: 'yahoo:query1',
        priceBasis: 'split_adjusted_raw_ohlc',
        latestBarTime: nowSec,
        exchangeTimezone: 'Asia/Kolkata',
        timezone: 'IST',
        utcOffset: '+05:30',
        latestTradingDay: '2026-03-20',
        resolvedSymbol: symbol,
        exchange: 'NSE',
        exchangeFallback: false
      }
    }),
    getLatestTick: async (symbol, interval) => ({
      symbol,
      interval,
      source: 'live',
      candle: mockCandles[mockCandles.length - 1],
      prevClose: mockCandles[mockCandles.length - 2].close,
      meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: nowSec, exchange: 'NSE' }
    }),
    getStockFundamentals: async (symbol) => ({
      symbol,
      headlines: [{ title: `Breaking news ${scriptPayload} ${imgPayload}`, pubDate: '2026-03-20' }],
      meta: { source: 'live', stale: false, provider: 'yahoo:query1', latestBarTime: nowSec, exchange: 'NSE' }
    })
  };

  const mockAiProxy = {
    ...aiProxy,
    callChatCompletion: async () => ({
      model: 'mock-xss-model',
      latencyMs: 95,
      content: JSON.stringify({
        bias: 'neutral',
        confidence: 78,
        summary: `Summary ${scriptPayload}`,
        reportText: `测试公司是行业代表企业${scriptPayload}。但受${imgPayload}影响，基本面平稳。\n\n技术面来看，震荡整理${imgPayload}。\n\n支撑位： 1320.00\n阻力位： 1410.00\n\n操作建议：保持观察${scriptPayload}。`,
        annotations: {
          horizontalLevels: [
            { type: 'support', price: 1320.0, startIndex: 20, endIndex: 119, label: '支撑位' },
            { type: 'resistance', price: 1410.0, startIndex: 20, endIndex: 119, label: '阻力位' }
          ],
          trendlines: [],
          patterns: []
        }
      })
    })
  };

  const srv = await startMockAppServer({ marketService: mockMarketService, aiProxy: mockAiProxy });
  try {
    return await withCdpPage(chromeBin, srv.baseUrl, async ({ evaluate, consoleErrors, pageExceptions }) => {
      const res = await evaluate(`(async () => {
        const app = window.__chartCopilot;

        // 1) Drive real SymbolSearchModal -> /api/search -> render()
        app.searchModal.open('TEST');
        await new Promise((r) => setTimeout(r, 350));
        const searchHtml = document.getElementById('symbolSearchResults').innerHTML;
        const searchNameText = document.querySelector('#symbolSearchResults .search-name')?.textContent || '';
        app.searchModal.close();

        // 2) Configure mock BYOK key and drive real app.copilot.ask() -> /api/ai/chat -> DOM render
        app.copilot.updateSettings({
          provider: 'deepseek',
          apiKey: 'sk-mock-123456',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          enableVision: false
        });
        await app.copilot.ask('分析一下 <script>window.__xss=3</script>');
        await new Promise((r) => setTimeout(r, 300));

        const reportEl = document.querySelector('.strict-report-body');
        const reportStyle = reportEl ? getComputedStyle(reportEl) : null;
        const reportRect = reportEl ? reportEl.getBoundingClientRect() : null;
        const reportText = reportEl?.textContent || '';
        const reportInnerText = reportEl?.innerText || '';
        const reportHtml = reportEl?.innerHTML || '';
        const userBubbleHtml = document.querySelector('.chat-bubble-user')?.innerHTML || '';
        const paragraphs = reportInnerText.split(/\\n\\s*\\n/).filter(Boolean);

        return {
          xssTriggered: window.__xss ?? null,
          searchNameText,
          searchHasRawImgTag: /<img\\b/i.test(searchHtml),
          searchHasRawScriptTag: /<script\\b/i.test(searchHtml),
          reportChildCount: reportEl ? reportEl.children.length : -1,
          reportHasLiteralPayloads:
            reportText.includes('<script>window.__xss=1</script>') &&
            reportText.includes('<img src=x onerror="window.__xss=2">'),
          reportHasRawTags: /<(script|img)\\b/i.test(reportHtml),
          userBubbleHasRawScript: /<script\\b/i.test(userBubbleHtml),
          reportWhiteSpace: reportStyle?.whiteSpace || '',
          reportParagraphCount: paragraphs.length,
          reportPreservesSRNewline: /支撑位：[^\\n]+\\n阻力位：/.test(reportInnerText),
          reportHeightPx: Math.round(reportRect?.height || 0),
          reportNoHorizontalOverflow: Boolean(reportEl && reportEl.scrollWidth <= reportEl.clientWidth + 2),
          hasOllamaPresetBtn: Boolean(document.querySelector('[data-provider-preset="ollama"]')),
          hasCustomPresetBtn: Boolean(document.querySelector('[data-provider-preset="custom"]'))
        };
      })()`);

      assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
      assert.equal(pageExceptions.length, 0, `Expected 0 page exceptions, got: ${pageExceptions.join('; ')}`);
      assert.equal(res.xssTriggered, null, 'XSS payload must NEVER execute');
      assert.match(res.searchNameText, /TestCorp <img src=x/);
      assert.equal(res.searchHasRawImgTag, false, 'SymbolSearchModal must not inject raw <img> tag');
      assert.equal(res.searchHasRawScriptTag, false, 'SymbolSearchModal must not inject raw <script> tag');
      assert.equal(res.reportChildCount, 0, 'Report <pre> must render strictly via textContent with 0 child elements');
      assert.equal(res.reportHasLiteralPayloads, true, 'Escaped XSS payloads must appear verbatim as safe text');
      assert.equal(res.reportHasRawTags, false, 'Report HTML must not contain raw <script> or <img> elements');
      assert.equal(res.userBubbleHasRawScript, false, 'User bubble must not contain raw <script> tag');
      assert.equal(res.reportWhiteSpace, 'pre-wrap', 'strict-report-body must keep white-space: pre-wrap');
      assert.ok(res.reportParagraphCount >= 4, `Expected >=4 readable paragraphs, got ${res.reportParagraphCount}`);
      assert.equal(res.reportPreservesSRNewline, true, 'Support and resistance lines must remain adjacent with newline');
      assert.ok(res.reportHeightPx > 50, `Expected multiline report height > 50px, got ${res.reportHeightPx}`);
      assert.equal(res.reportNoHorizontalOverflow, true, 'Report text must wrap without horizontal overflow');
      assert.equal(res.hasOllamaPresetBtn, true);
      assert.equal(res.hasCustomPresetBtn, true);
      return res;
    });
  } finally {
    await srv.close();
  }
}

module.exports = { runStep0BrowserTest };
