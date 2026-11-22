#!/usr/bin/env node
const { findChromiumBinary, startAppServer } = require('./helpers');
const { runStep0BrowserTest } = require('./step0-security.browser');
const { runStep2BrowserTest } = require('./step2-status-watermark.browser');
const { runM1BrowserTest } = require('./m1-lwc-rendering.browser');

async function main() {
  const chromeBin = findChromiumBinary();
  if (!chromeBin) {
    console.log(
      '[test:browser] SKIP: 未检测到本地 Chromium / Google Chrome 可执行文件（可通过环境变量 CHROMIUM_BIN 指定路径）。跳过无头浏览器测试，不计为失败。'
    );
    process.exit(0);
  }

  console.log(`[test:browser] 使用 Chromium: ${chromeBin}`);
  const app = await startAppServer();

  try {
    console.log('[test:browser] 1/3 运行 Step 0 XSS 与 pre-wrap 浏览器验证...');
    const r0 = await runStep0BrowserTest(chromeBin, app.baseUrl);
    console.log('  ✔ Step 0 通过:', JSON.stringify(r0));

    console.log('[test:browser] 2/3 运行 Step 2 状态徽标与 SIMULATED 水印验证...');
    const r2 = await runStep2BrowserTest(chromeBin, app.baseUrl);
    console.log('  ✔ Step 2 通过:', JSON.stringify(r2));

    console.log('[test:browser] 3/3 运行 M1 Lightweight Charts 双窗格与 IST 时区渲染验证...');
    const rm1 = await runM1BrowserTest(chromeBin, app.baseUrl);
    console.log('  ✔ M1 通过:', JSON.stringify(rm1));

    console.log('[test:browser] 全部 3 项无头浏览器端到端验证通过！');
  } finally {
    app.close();
  }
}

main().catch((err) => {
  console.error('[test:browser] FAIL:', err);
  process.exit(1);
});
