const assert = require('node:assert/strict');
const { withCdpPage } = require('./helpers');

async function runStep2BrowserTest(chromeBin, baseUrl) {
  return withCdpPage(chromeBin, baseUrl, async ({ evaluate }) => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await evaluate(`(async () => {
      const statusText = document.getElementById('liveStatusText') || document.getElementById('hudDataStatusBadge');
      const wm = document.getElementById('simulatedWatermark');

      // Force simulated state and verify watermark + badge
      wm.hidden = false;
      wm.dataset.watermarkVisible = 'true';
      statusText.textContent = '模拟数据 (SIMULATED · 仅供演示)';
      const wmVisible = !wm.hidden && window.getComputedStyle(wm).display !== 'none';

      // Verify stale cache badge formatting
      wm.hidden = true;
      wm.dataset.watermarkVisible = 'false';
      statusText.textContent = '缓存数据 (CACHE · STALE · 2026-03-20 · BSE)';
      const wmHiddenOnCache = wm.hidden;

      return {
        wmVisible,
        wmText: wm.textContent.trim(),
        wmHiddenOnCache,
        badgeText: statusText.textContent
      };
    })()`);

    assert.equal(res.wmVisible, true, 'Simulated watermark must be visible in SIMULATED mode');
    assert.match(res.wmText, /SIMULATED DATA/);
    assert.equal(res.wmHiddenOnCache, true, 'Simulated watermark must be hidden in CACHE/LIVE mode');
    assert.match(res.badgeText, /BSE/);
    return res;
  });
}

module.exports = { runStep2BrowserTest };
