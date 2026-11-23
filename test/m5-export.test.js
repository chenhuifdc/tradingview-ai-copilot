import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPORT_CONFIG, detectChartFontSupport } from '../public/js/screenshotAnnotator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('M5.1: EXPORT_CONFIG enforces 1600x900 @ 2x DPR, light theme, English chart text, and zero chartEngine.js dependency', () => {
  assert.equal(EXPORT_CONFIG.width, 1600);
  assert.equal(EXPORT_CONFIG.height, 900);
  assert.equal(EXPORT_CONFIG.dpr, 2);
  assert.equal(EXPORT_CONFIG.theme, 'light');
  assert.equal(EXPORT_CONFIG.language, 'en');
  assert.equal(EXPORT_CONFIG.headerHeight + EXPORT_CONFIG.chartHeight + EXPORT_CONFIG.footerHeight, 900);

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'screenshotAnnotator.js'), 'utf8');
  assert.equal(src.includes('chartEngine.js'), false, 'screenshotAnnotator.js must not import chartEngine.js');
});

test('M5.2: detectChartFontSupport handles missing CJK font by falling back to English ASCII with explicit reason', () => {
  const res = detectChartFontSupport('zh-CN');
  assert.equal(res.cjkSupported, false);
  assert.equal(res.effectiveLang, 'en');
  assert.ok(res.fontFallbackReason && res.fontFallbackReason.includes('CJK'));
});
