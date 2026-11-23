/**
 * M7 Batch Generation Pipeline.
 * - Configurable concurrency & rate-limit delay
 * - Single-symbol fault isolation (one failure never aborts the batch)
 * - Checkpoint resume (skips already succeeded symbols from previous manifest)
 * - Skips 'simulated' data by default and records it in manifest.json
 * - Packages PNG + analysis text + manifest.json into a zero-dependency .zip
 */

import { computeAllIndicators } from './indicators.js';
import { extractChartContext } from './localAnalyzer.js';
import { runM4Pipeline } from './m4Pipeline.js';
import { applyDataStatusToReport } from './aiCopilot.js';
import { buildZipArchive, base64ToUint8Array } from './zipBuilder.js';

export const BATCH_CONFIG = {
  concurrency: 1,
  delayBetweenMs: 200,
  allowSimulated: false,
  interval: '1d'
};

export function parseSymbolList(rawText = '') {
  const seen = new Set();
  const out = [];
  for (const token of String(rawText || '').split(/[\s,;]+/)) {
    const sym = token.trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

export function sanitizeFileBase(symbol) {
  return String(symbol || 'CHART').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Default browser/server market data fetcher using /api/klines + /api/fundamentals.
 */
export async function defaultFetchMarketData(symbol, interval = '1d', fetchFn = globalThis.fetch) {
  const kRes = await fetchFn(
    `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
  );
  if (!kRes.ok) {
    throw new Error(`HTTP ${kRes.status} fetching klines for ${symbol}`);
  }
  const kData = await kRes.json();
  if (!kData || !Array.isArray(kData.candles) || kData.candles.length < 10) {
    throw new Error(`Insufficient candles for ${symbol}`);
  }

  let fundamentals = null;
  try {
    const fRes = await fetchFn(`/api/fundamentals?symbol=${encodeURIComponent(kData.meta?.resolvedSymbol || symbol)}`);
    if (fRes.ok) {
      fundamentals = await fRes.json();
    }
  } catch {
    // optional fundamentals
  }

  return { kData, fundamentals };
}

export async function runBatchPipeline({
  symbols = [],
  config = {},
  resumeManifest = null,
  fetchMarketFn = null,
  renderAndExportFn = null,
  callModelFn = null,
  onProgress = () => {},
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  shouldCancelFn = () => false
} = {}) {
  const cfg = { ...BATCH_CONFIG, ...config };
  const list = Array.isArray(symbols) ? symbols : parseSymbolList(symbols);
  const concurrency = Math.max(1, Math.min(4, Math.floor(Number(cfg.concurrency) || 1)));
  const delayMs = Math.max(0, Math.floor(Number(cfg.delayBetweenMs) || 0));
  const interval = cfg.interval || '1d';
  const fetcher = fetchMarketFn || ((sym, iv) => defaultFetchMarketData(sym, iv));

  const prevBySymbol = new Map();
  const prevFilesBySymbol = new Map();
  if (resumeManifest && Array.isArray(resumeManifest.items)) {
    for (const item of resumeManifest.items) {
      if (item && item.symbol) {
        prevBySymbol.set(item.symbol, item);
        if (item._artifacts) prevFilesBySymbol.set(item.symbol, item._artifacts);
      }
    }
  }

  const results = new Array(list.length);
  const artifactMap = new Map();
  let completed = 0;

  const processItem = async (sym, idx) => {
    if (shouldCancelFn()) {
      results[idx] = {
        symbol: sym,
        status: 'cancelled',
        validationPassed: false,
        usedFallback: false,
        failureReason: 'BATCH_CANCELLED',
        generatedAt: new Date().toISOString()
      };
      return;
    }

    const prev = prevBySymbol.get(sym);
    if (prev && prev.status === 'success') {
      results[idx] = { ...prev, resumedFromCheckpoint: true };
      if (prevFilesBySymbol.has(sym)) {
        artifactMap.set(sym, prevFilesBySymbol.get(sym));
      }
      completed++;
      onProgress({ completed, total: list.length, currentSymbol: sym, item: results[idx] });
      return;
    }

    try {
      const { kData, fundamentals } = await fetcher(sym, interval);
      const meta = kData.meta || { source: kData.source || 'live', resolvedSymbol: sym, exchange: kData.instrument?.exchange || '' };

      if (!cfg.allowSimulated && meta.source === 'simulated') {
        const entry = {
          symbol: sym,
          resolvedSymbol: meta.resolvedSymbol || sym,
          exchange: meta.exchange || kData.instrument?.exchange || '',
          interval,
          latestBarTime: meta.latestBarTime || kData.candles[kData.candles.length - 1]?.time || null,
          latestTradingDay: meta.latestTradingDay || null,
          generatedAt: new Date().toISOString(),
          dataMeta: meta,
          selectedSupportId: null,
          selectedResistanceId: null,
          selectedAnnotationIds: [],
          droppedIds: [],
          annotations: null,
          validationPassed: false,
          usedFallback: false,
          failureReason: 'SIMULATED_DATA_SKIPPED',
          status: 'skipped_simulated',
          files: null
        };
        results[idx] = entry;
        completed++;
        onProgress({ completed, total: list.length, currentSymbol: sym, item: entry });
        return;
      }

      const candles = kData.candles;
      const emaPeriods = [5, 10, 20, 50, 200];
      const indicators = computeAllIndicators(candles, { emaPeriods });
      const visibleStart = Math.max(0, candles.length - 120);
      const visibleEnd = candles.length - 1;
      const ctx = extractChartContext(
        candles,
        indicators,
        visibleStart,
        visibleEnd,
        kData.instrument || { symbol: sym, displaySymbol: sym, exchange: meta.exchange || '', market: 'in' },
        interval,
        fundamentals,
        emaPeriods
      );

      const m4Out = await runM4Pipeline({
        ctx,
        userPrompt: `Batch analysis for ${sym}`,
        dataMeta: meta,
        callModelFn,
        chartLang: 'zh-CN',
        useCache: true
      });

      const finalReportText = applyDataStatusToReport(
        m4Out.reportText,
        meta,
        interval,
        ctx.latest?.time
      );

      let pngDataUrl = null;
      if (typeof renderAndExportFn === 'function') {
        pngDataUrl = await renderAndExportFn({
          symbol: sym,
          interval,
          kData,
          ctx,
          m4Out,
          meta
        });
      }

      const fileBase = sanitizeFileBase(meta.resolvedSymbol || sym);
      const txtName = `${fileBase}.txt`;
      const pngName = pngDataUrl ? `${fileBase}.png` : null;

      artifactMap.set(sym, {
        txtName,
        txtContent: finalReportText,
        pngName,
        pngDataUrl
      });

      const entry = {
        symbol: sym,
        resolvedSymbol: meta.resolvedSymbol || sym,
        exchange: meta.exchange || kData.instrument?.exchange || '',
        interval,
        latestBarTime: meta.latestBarTime || candles[candles.length - 1]?.time || null,
        latestTradingDay: meta.latestTradingDay || null,
        generatedAt: new Date().toISOString(),
        dataMeta: meta,
        selectedSupportId: m4Out.selectedSupport?.id || null,
        selectedResistanceId: m4Out.selectedResistance?.id || null,
        selectedAnnotationIds: m4Out.parsedJson?.annotation_ids || [],
        droppedIds: m4Out.droppedIds || [],
        annotations: m4Out.annotations || null,
        validationPassed: !m4Out.usedFallback,
        usedFallback: Boolean(m4Out.usedFallback),
        failureReason: m4Out.usedFallback ? m4Out.fallbackReason : null,
        status: 'success',
        files: {
          text: txtName,
          ...(pngName ? { png: pngName } : {})
        }
      };

      results[idx] = entry;
    } catch (err) {
      results[idx] = {
        symbol: sym,
        resolvedSymbol: sym,
        exchange: '',
        interval,
        latestBarTime: null,
        latestTradingDay: null,
        generatedAt: new Date().toISOString(),
        dataMeta: null,
        selectedSupportId: null,
        selectedResistanceId: null,
        selectedAnnotationIds: [],
        droppedIds: [],
        annotations: null,
        validationPassed: false,
        usedFallback: false,
        failureReason: err?.message || String(err),
        status: 'failed',
        files: null
      };
    }

    completed++;
    onProgress({ completed, total: list.length, currentSymbol: sym, item: results[idx] });
    if (delayMs > 0 && idx < list.length - 1) {
      await sleepFn(delayMs);
    }
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      await processItem(list[idx], idx);
    }
  });
  await Promise.all(workers);

  const manifest = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    interval,
    config: { concurrency, delayBetweenMs: delayMs, allowSimulated: Boolean(cfg.allowSimulated) },
    summary: {
      total: results.length,
      success: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skippedSimulated: results.filter((r) => r.status === 'skipped_simulated').length
    },
    items: results
  };

  const zipEntries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }
  ];
  for (const [, art] of artifactMap.entries()) {
    if (art.txtName && art.txtContent != null) {
      zipEntries.push({ name: art.txtName, data: art.txtContent });
    }
    if (art.pngName && art.pngDataUrl) {
      zipEntries.push({ name: art.pngName, data: base64ToUint8Array(art.pngDataUrl) });
    }
  }

  const zipBytes = buildZipArchive(zipEntries);
  return { manifest, zipEntries, zipBytes, artifactMap };
}
