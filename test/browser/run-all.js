#!/usr/bin/env node
const { findChromiumBinary } = require('./helpers');
const { runStep0BrowserTest } = require('./step0-security.browser');
const { runStep2BrowserTest } = require('./step2-status-watermark.browser');
const { runM1BrowserTest } = require('./m1-lwc-rendering.browser');
const { runM3BrowserTest } = require('./m3-annotations-alignment.browser');
const { runM5BrowserTest } = require('./m5-export-alignment.browser');

async function main() {
  const chromeBin = findChromiumBinary();
  if (!chromeBin) {
    console.log(
      '[test:browser] SKIP: 未检测到本地 Chromium / Google Chrome 可执行文件（可通过环境变量 CHROMIUM_BIN 指定路径）。跳过无头浏览器测试，不计为失败。'
    );
    process.exit(0);
  }

  console.log(`[test:browser] 使用 Chromium: ${chromeBin}`);

  console.log('[test:browser] 1/5 运行 Step 0 真实端到端 XSS 与 pre-wrap 浏览器验证...');
  const r0 = await runStep0BrowserTest(chromeBin);
  console.log('  ✔ Step 0 通过:', JSON.stringify(r0));

  console.log('[test:browser] 2/5 运行 Step 2 真实端到端状态徽标、演示模式与 SIMULATED 水印验证...');
  const r2 = await runStep2BrowserTest(chromeBin);
  console.log('  ✔ Step 2 通过:', JSON.stringify(r2));

  console.log('[test:browser] 3/5 运行 M1 真实端到端 Lightweight Charts 双窗格、序列与 IST 时区渲染验证...');
  const rm1 = await runM1BrowserTest(chromeBin);
  console.log('  ✔ M1 通过:', JSON.stringify(rm1));

  console.log('[test:browser] 4/5 运行 M3 原生 Series Primitive 标注像素对齐（5只NSE样本 ≤0.5px）与缩放/清除验证...');
  const rm3 = await runM3BrowserTest(chromeBin);
  console.log('  ✔ M3 通过:', JSON.stringify(rm3));

  console.log('[test:browser] 5/5 运行 M5 1600x900@2x 浅色导出、像素对齐（5只NSE样本 ≤0.5px）与界面恢复验证...');
  const rm5 = await runM5BrowserTest(chromeBin);
  console.log('  ✔ M5 通过:', JSON.stringify(rm5));

  console.log('[test:browser] 全部 5 项无头浏览器端到端验证通过！');
}

main().catch((err) => {
  console.error('[test:browser] FAIL:', err);
  process.exit(1);
});
