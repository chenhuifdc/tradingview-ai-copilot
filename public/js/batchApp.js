import { ChartEngine } from './lwcChartEngine.js';
import { renderAnnotatedScreenshot, EXPORT_CONFIG } from './screenshotAnnotator.js';
import { parseSymbolList, runBatchPipeline } from './batchRunner.js';

const BATCH_CHECKPOINT_KEY = 'chartcopilot_batch_checkpoint_v1';

class BatchApp {
  constructor() {
    this.stageEl = document.getElementById('batchRenderStage');
    this.symbolsInput = document.getElementById('batchSymbols');
    this.intervalSelect = document.getElementById('batchInterval');
    this.concurrencyInput = document.getElementById('batchConcurrency');
    this.delayInput = document.getElementById('batchDelay');
    this.allowSimChk = document.getElementById('batchAllowSimulated');
    this.btnStart = document.getElementById('btnBatchStart');
    this.btnResume = document.getElementById('btnBatchResume');
    this.btnDownloadZip = document.getElementById('btnBatchDownloadZip');
    this.statusEl = document.getElementById('batchStatusText');
    this.tableBody = document.getElementById('batchResultsBody');

    this.chart = new ChartEngine(this.stageEl, {
      theme: 'light',
      lang: 'en',
      emaPeriods: [5, 10, 20, 50, 200]
    });

    this.lastResult = null;
    this.savedManifest = this._loadCheckpoint();
    this._bindEvents();
  }

  _loadCheckpoint() {
    try {
      const raw = localStorage.getItem(BATCH_CHECKPOINT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _saveCheckpoint(manifest) {
    try {
      localStorage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(manifest));
    } catch {
      // ignore quota errors
    }
  }

  _bindEvents() {
    this.btnStart?.addEventListener('click', () => this.runBatch({ resume: false }));
    this.btnResume?.addEventListener('click', () => this.runBatch({ resume: true }));
    this.btnDownloadZip?.addEventListener('click', () => this.downloadZip());
  }

  _renderRow(item) {
    if (!this.tableBody) return;
    const tr = document.createElement('tr');
    const cells = [
      item.symbol,
      item.resolvedSymbol || '-',
      item.exchange || '-',
      item.dataMeta?.source || '-',
      item.status,
      item.validationPassed ? 'PASS' : (item.usedFallback ? 'FALLBACK' : 'FAIL'),
      item.failureReason || '-'
    ];
    for (const txt of cells) {
      const td = document.createElement('td');
      td.textContent = String(txt ?? '');
      tr.appendChild(td);
    }
    this.tableBody.appendChild(tr);
  }

  async runBatch({ resume = false, callModelFn = null } = {}) {
    const symbols = parseSymbolList(this.symbolsInput?.value || '');
    if (!symbols.length) {
      if (this.statusEl) this.statusEl.textContent = '请输入至少一个股票代码';
      return null;
    }

    if (this.tableBody) this.tableBody.innerHTML = '';
    if (this.btnStart) this.btnStart.disabled = true;
    if (this.btnResume) this.btnResume.disabled = true;
    if (this.btnDownloadZip) this.btnDownloadZip.disabled = true;

    const resumeManifest = resume ? (this.lastResult?.manifest || this.savedManifest) : null;

    const res = await runBatchPipeline({
      symbols,
      config: {
        interval: this.intervalSelect?.value || '1d',
        concurrency: Number(this.concurrencyInput?.value) || 1,
        delayBetweenMs: Number(this.delayInput?.value) || 100,
        allowSimulated: Boolean(this.allowSimChk?.checked)
      },
      resumeManifest,
      callModelFn,
      renderAndExportFn: async ({ kData, m4Out, meta }) => {
        this.chart.setData(kData.candles, kData.instrument, kData.interval || '1d', meta);
        this.chart.setAIAnnotations(m4Out.annotations);
        const snap = this.chart.captureExportSnapshot({
          width: EXPORT_CONFIG.width,
          height: EXPORT_CONFIG.chartHeight,
          theme: EXPORT_CONFIG.theme,
          includeAnnotations: Boolean(m4Out.annotations),
          annotations: m4Out.annotations,
          lang: EXPORT_CONFIG.language
        });
        return renderAnnotatedScreenshot(
          snap,
          m4Out.annotations,
          { bias: m4Out.bias, confidence: m4Out.confidence, dataMeta: meta },
          { lang: EXPORT_CONFIG.language, theme: EXPORT_CONFIG.theme }
        );
      },
      onProgress: ({ completed, total, currentSymbol, item }) => {
        if (this.statusEl) {
          this.statusEl.textContent = `进度：${completed}/${total}（${currentSymbol} -> ${item.status}）`;
        }
        this._renderRow(item);
      }
    });

    this.lastResult = res;
    this.savedManifest = res.manifest;
    this._saveCheckpoint(res.manifest);

    if (this.statusEl) {
      const s = res.manifest.summary;
      this.statusEl.textContent = `完成：共 ${s.total} 只，成功 ${s.success}，跳过模拟 ${s.skippedSimulated}，失败 ${s.failed}`;
    }
    if (this.btnStart) this.btnStart.disabled = false;
    if (this.btnResume) this.btnResume.disabled = false;
    if (this.btnDownloadZip) this.btnDownloadZip.disabled = false;
    return res;
  }

  downloadZip() {
    if (!this.lastResult?.zipBytes) return;
    const blob = new Blob([this.lastResult.zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tradingview-batch-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

window.__batchApp = new BatchApp();
