const assert = require('node:assert/strict');
const { withCdpPage } = require('./helpers');

async function runStep0BrowserTest(chromeBin, baseUrl) {
  return withCdpPage(chromeBin, baseUrl, async ({ evaluate }) => {
    await new Promise((r) => setTimeout(r, 1500));

    const res = await evaluate(`(() => {
      window.__xssTriggered = false;
      const list = document.getElementById('copilotChatFeed') || document.body;
      const card = document.createElement('div');
      card.className = 'chat-msg assistant';
      const reportEl = document.createElement('pre');
      reportEl.className = 'strict-report-body';
      const payload = '<img src=x onerror="window.__xssTriggered=true"><script>window.__xssTriggered=true</script>第一段：基本面稳健。\\n\\n第二段：支撑位 125.50 / 120.00';
      reportEl.textContent = payload;
      card.appendChild(reportEl);
      list.appendChild(card);

      const cs = window.getComputedStyle(reportEl);
      const rect = reportEl.getBoundingClientRect();
      return {
        xssTriggered: window.__xssTriggered,
        childElementCount: reportEl.children.length,
        whiteSpace: cs.whiteSpace,
        renderedHeight: rect.height,
        textIncludesNewline: reportEl.textContent.includes('\\n\\n')
      };
    })()`);

    assert.equal(res.xssTriggered, false, 'XSS payload must not execute');
    assert.equal(res.childElementCount, 0, 'textContent must not create child HTML elements');
    assert.equal(res.whiteSpace, 'pre-wrap', 'strict-report-body must preserve line breaks with white-space: pre-wrap');
    assert.ok(res.renderedHeight > 30, 'Multi-paragraph report must render across multiple lines');
    return res;
  });
}

module.exports = { runStep0BrowserTest };
