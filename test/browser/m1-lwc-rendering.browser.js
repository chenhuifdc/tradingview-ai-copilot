const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withCdpPage } = require('./helpers');

async function runM1BrowserTest(chromeBin, baseUrl) {
  return withCdpPage(chromeBin, baseUrl, async ({ sendCdp, evaluate }) => {
    await new Promise((r) => setTimeout(r, 2500));

    const res = await evaluate(`(async () => {
      const lwcLoaded = typeof window.LightweightCharts !== 'undefined' &&
                        typeof window.LightweightCharts.createChart === 'function';
      const lwcContainer = document.getElementById('lwcChartContainer');
      const canvases = lwcContainer ? lwcContainer.querySelectorAll('canvas').length : 0;
      const attrLink = document.querySelector('a[href*="tradingview.com"]');

      // Verify IST timezone formatting directly inside the browser runtime
      const mod = await import('/js/lwcAdapter.js');
      const istCrosshair = mod.formatLwcCrosshairTime(
        Math.floor(Date.parse('2026-03-20T03:45:00Z') / 1000),
        { interval: '15m', timeZone: 'Asia/Kolkata', tzAbbr: 'IST' }
      );
      const istTick = mod.formatLwcTickMark(
        Math.floor(Date.parse('2026-03-20T03:45:00Z') / 1000),
        3,
        { interval: '15m', timeZone: 'Asia/Kolkata' }
      );

      return {
        lwcLoaded,
        lwcVersion: window.LightweightCharts?.version ? window.LightweightCharts.version() : '5.2.1',
        canvases,
        attributionHref: attrLink ? attrLink.href : null,
        istCrosshair,
        istTick
      };
    })()`);

    assert.equal(res.lwcLoaded, true, 'window.LightweightCharts must be loaded');
    assert.ok(res.canvases >= 2, 'Lightweight Charts multi-pane container must render main + MACD canvas elements');
    assert.match(res.attributionHref || '', /tradingview\.com/);
    assert.equal(res.istCrosshair, '2026-03-20 09:15 IST');
    assert.equal(res.istTick, '09:15');

    if (process.env.SCREENSHOT_DIR) {
      const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.data) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        const outPath = path.join(process.env.SCREENSHOT_DIR, 'm1_lwc_chart.png');
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        res.screenshotPath = outPath;
      }
    }

    return res;
  });
}

module.exports = { runM1BrowserTest };
