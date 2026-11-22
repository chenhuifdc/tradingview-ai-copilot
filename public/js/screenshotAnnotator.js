/**
 * AI Chart Screenshot Annotator & Full-Screen Screenshot Studio.
 * Takes a captured K-line chart snapshot + AI annotations and renders a crisp,
 * publication-grade annotated PNG image (with header banner, legend footer,
 * non-overlapping labels, and optional user markup in Studio mode).
 */

import { drawAnnotationsLayer } from './chartEngine.js';
import { formatPrice, formatVolume, formatTimeLabel } from './indicators.js';
import { getLangPack } from './i18n.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawUserMarkups(ctx, markups) {
  if (!Array.isArray(markups) || !markups.length) return;
  for (const m of markups) {
    ctx.save();
    ctx.strokeStyle = m.color || '#ff6d00';
    ctx.fillStyle = m.color || '#ff6d00';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (m.tool === 'line') {
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
    } else if (m.tool === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
      const ang = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      ctx.beginPath();
      ctx.moveTo(m.x2, m.y2);
      ctx.lineTo(m.x2 - 11 * Math.cos(ang - 0.45), m.y2 - 11 * Math.sin(ang - 0.45));
      ctx.lineTo(m.x2 - 11 * Math.cos(ang + 0.45), m.y2 - 11 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    } else if (m.tool === 'rect') {
      ctx.fillStyle = 'rgba(255, 109, 0, 0.14)';
      ctx.fillRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
      ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
    } else if (m.tool === 'text' && m.text) {
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(m.text).width;
      ctx.fillStyle = 'rgba(19, 23, 34, 0.86)';
      ctx.fillRect(m.x1 - 4, m.y1 - 16, tw + 12, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(m.text, m.x1 + 2, m.y1);
    }
    ctx.restore();
  }
}

/**
 * Render an executive-grade Annotated Chart Screenshot PNG in any supported chart language.
 */
export async function renderAnnotatedScreenshot(snapshot, annotations, meta = {}, options = {}) {
  const {
    showAnnotations = true,
    lang = snapshot.geometry?.lang || 'zh-CN',
    layers = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true
    },
    userMarkups = []
  } = options;

  const pack = getLangPack(lang);
  const C = pack.chart;
  const H = pack.hud;

  const headerH = 38;
  const footerH = 28;
  const dpr = 2;
  const totalW = snapshot.width;
  const totalH = snapshot.height + headerH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(totalW * dpr);
  canvas.height = Math.floor(totalH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const isDark = snapshot.geometry.theme === 'dark';
  const bg = isDark ? '#131722' : '#ffffff';
  const barBg = isDark ? '#1e222d' : '#f8f9fd';
  const border = isDark ? '#2a2e39' : '#e0e3eb';
  const fg = isDark ? '#d1d4dc' : '#131722';
  const muted = '#787b86';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, totalW, totalH);

  // 1. Header Stamp Bar
  ctx.fillStyle = barBg;
  ctx.fillRect(0, 0, totalW, headerH);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(totalW, headerH - 0.5);
  ctx.stroke();

  const inst = snapshot.instrument || {};
  const displayTitle = lang === 'en' ? (inst.enName || inst.displaySymbol || 'Chart') : (inst.name || inst.displaySymbol || 'Chart');
  const title = `${displayTitle} (${inst.displaySymbol || ''}) · ${snapshot.interval?.toUpperCase() || '1D'}`;
  ctx.fillStyle = fg;
  ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 14, headerH / 2);

  // Bias Verdict Pill
  const bias = meta.bias || 'neutral';
  const biasWord = bias === 'bullish' ? C.biasBull : bias === 'bearish' ? C.biasBear : C.biasNeu;
  const biasLabel = `${C.verdictPrefix}: ${biasWord}`;
  const biasColor = bias === 'bullish' ? '#089981' : bias === 'bearish' ? '#f23645' : '#2962ff';
  const titleW = ctx.measureText(title).width;
  const pillX = Math.min(totalW - 230, 26 + titleW);

  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
  const pillText = meta.confidence ? `${biasLabel} (${meta.confidence}%)` : biasLabel;
  const pillW = ctx.measureText(pillText).width + 16;
  ctx.fillStyle = biasColor;
  const rx = pillX;
  const ry = headerH / 2 - 10;
  const rh = 20;
  const rr = 4;
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.arcTo(rx + pillW, ry, rx + pillW, ry + rh, rr);
  ctx.arcTo(rx + pillW, ry + rh, rx, ry + rh, rr);
  ctx.arcTo(rx, ry + rh, rx, ry, rr);
  ctx.arcTo(rx, ry, rx + pillW, ry, rr);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(pillText, pillX + 8, headerH / 2 + 0.5);

  const stamp = `${meta.modelLabel || 'ChartCopilot AI'} · ${formatTimeLabel(Math.floor(snapshot.capturedAt / 1000), '15m', true)}`;
  ctx.fillStyle = muted;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(stamp, totalW - 14, headerH / 2);
  ctx.textAlign = 'left';

  // 2. Base Clean Chart Screenshot + Localized OHLCV Stamp
  const baseImg = await loadImage(snapshot.cleanDataUrl);
  ctx.drawImage(baseImg, 0, headerH, snapshot.width, snapshot.height);

  if (snapshot.latestCandle) {
    const c = snapshot.latestCandle;
    const prec = snapshot.geometry.precision;
    const pc = snapshot.prevClose ?? c.open;
    const diff = c.close - pc;
    const pct = pc ? (diff / pc) * 100 : 0;
    const col = diff >= 0 ? '#089981' : '#f23645';
    const txt = `${H.open} ${formatPrice(c.open, prec)}  ${H.high} ${formatPrice(c.high, prec)}  ${H.low} ${formatPrice(c.low, prec)}  ${H.close} ${formatPrice(c.close, prec)}  ${diff >= 0 ? '+' : ''}${formatPrice(diff, prec)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ${H.vol} ${formatVolume(c.volume)}`;
    ctx.save();
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = isDark ? 'rgba(19,23,34,0.82)' : 'rgba(255,255,255,0.88)';
    ctx.fillRect(8, headerH + 6, tw + 12, 18);
    ctx.fillStyle = col;
    ctx.fillText(txt, 14, headerH + 9);
    ctx.restore();
  }

  // 3. Draw Crisp Vector AI Annotations directly onto the screenshot image in the active language!
  if (showAnnotations && annotations) {
    ctx.save();
    ctx.translate(0, headerH);
    drawAnnotationsLayer(ctx, { ...snapshot.geometry, lang }, annotations, { layers, lang });
    ctx.restore();
  }

  // 4. Draw any user manual markups from Screenshot Studio
  if (userMarkups.length) {
    ctx.save();
    ctx.translate(0, headerH);
    drawUserMarkups(ctx, userMarkups);
    ctx.restore();
  }

  // 5. Legend Footer Bar
  const footY = headerH + snapshot.height;
  ctx.fillStyle = barBg;
  ctx.fillRect(0, footY, totalW, footerH);
  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(0, footY + 0.5);
  ctx.lineTo(totalW, footY + 0.5);
  ctx.stroke();

  const legendItems = [
    { color: '#ef5350', label: C.legendRes },
    { color: '#2962ff', label: C.legendSup },
    { color: '#089981', label: C.legendUpTp },
    { color: '#f23645', label: C.legendDownSl },
    { color: '#2962ff', label: C.legendPat }
  ];
  let lx = 14;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  for (const item of legendItems) {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, footY + footerH / 2 - 4, 10, 8);
    ctx.fillStyle = muted;
    ctx.fillText(item.label, lx + 14, footY + footerH / 2 + 0.5);
    lx += ctx.measureText(item.label).width + 28;
  }

  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  ctx.fillText(C.shotFooter, totalW - 14, footY + footerH / 2 + 0.5);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

export function downloadDataUrl(dataUrl, filename = 'chart-ai-annotation.png') {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Full-Screen Interactive Screenshot Annotation Studio Controller
 */
export class ScreenshotStudio {
  constructor(modalEl) {
    this.modal = modalEl;
    this.canvas = modalEl.querySelector('#studioCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.titleEl = modalEl.querySelector('#studioTitle');
    this.compareToggle = modalEl.querySelector('#studioCompareOriginal');
    this.langSelect = modalEl.querySelector('#studioLangSelect');
    this.layerCheckboxes = modalEl.querySelectorAll('[data-studio-layer]');
    this.toolButtons = modalEl.querySelectorAll('[data-studio-tool]');
    this.btnUndo = modalEl.querySelector('#studioUndo');
    this.btnClear = modalEl.querySelector('#studioClearMarkup');
    this.btnDownload = modalEl.querySelector('#studioDownload');
    this.btnCopy = modalEl.querySelector('#studioCopy');
    this.btnClose = modalEl.querySelector('#studioClose');

    this.snapshot = null;
    this.annotations = null;
    this.meta = {};
    this.lang = 'zh-CN';
    this.showOriginalOnly = false;
    this.layers = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true
    };
    this.activeTool = 'none';
    this.userMarkups = [];
    this.draftMarkup = null;
    this.currentDataUrl = '';

    this._bind();
  }

  async open(snapshot, annotations, meta = {}, lang = 'zh-CN') {
    this.snapshot = snapshot;
    this.annotations = annotations;
    this.meta = meta;
    this.lang = lang || snapshot?.geometry?.lang || 'zh-CN';
    this.showOriginalOnly = false;
    this.userMarkups = [];
    this.draftMarkup = null;
    this.activeTool = 'none';
    this.layers = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true
    };

    if (this.compareToggle) this.compareToggle.checked = false;
    if (this.langSelect) this.langSelect.value = this.lang;
    this.layerCheckboxes.forEach((cb) => { cb.checked = true; });
    this._syncToolButtons();

    if (this.titleEl) {
      const sym = snapshot.instrument?.displaySymbol || 'Chart';
      const U = getLangPack(this.lang).ui;
      this.titleEl.textContent = `${U.studioTitle} · ${sym} (${snapshot.interval?.toUpperCase()})`;
    }

    this.modal.classList.add('open');
    await this.redraw();
  }

  close() {
    this.modal.classList.remove('open');
  }

  async redraw() {
    if (!this.snapshot) return;
    const markups = this.draftMarkup ? [...this.userMarkups, this.draftMarkup] : this.userMarkups;
    const dataUrl = await renderAnnotatedScreenshot(this.snapshot, this.annotations, this.meta, {
      showAnnotations: !this.showOriginalOnly,
      lang: this.lang,
      layers: this.layers,
      userMarkups: this.showOriginalOnly ? [] : markups
    });
    this.currentDataUrl = dataUrl;
    const img = await loadImage(dataUrl);
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.ctx.clearRect(0, 0, img.width, img.height);
    this.ctx.drawImage(img, 0, 0);
  }

  _getCanvasChartCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = (this.snapshot.width) / rect.width;
    const scaleY = (this.snapshot.height + 38 + 28) / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY - 38
    };
  }

  _syncToolButtons() {
    this.toolButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.studioTool === this.activeTool);
    });
    this.canvas.style.cursor = this.activeTool === 'none' ? 'default' : 'crosshair';
  }

  _bind() {
    this.btnClose?.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });

    this.compareToggle?.addEventListener('change', (e) => {
      this.showOriginalOnly = e.target.checked;
      this.redraw();
    });

    this.langSelect?.addEventListener('change', (e) => {
      this.lang = e.target.value;
      if (this.titleEl && this.snapshot) {
        const sym = this.snapshot.instrument?.displaySymbol || 'Chart';
        const U = getLangPack(this.lang).ui;
        this.titleEl.textContent = `${U.studioTitle} · ${sym} (${this.snapshot.interval?.toUpperCase()})`;
      }
      this.redraw();
    });

    this.layerCheckboxes.forEach((cb) => {
      cb.addEventListener('change', (e) => {
        this.layers[e.target.dataset.studioLayer] = e.target.checked;
        this.redraw();
      });
    });

    this.toolButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.studioTool;
        this.activeTool = this.activeTool === t ? 'none' : t;
        this._syncToolButtons();
      });
    });

    this.btnUndo?.addEventListener('click', () => {
      this.userMarkups.pop();
      this.redraw();
    });

    this.btnClear?.addEventListener('click', () => {
      this.userMarkups = [];
      this.redraw();
    });

    this.btnDownload?.addEventListener('click', () => {
      if (!this.currentDataUrl) return;
      const sym = (this.snapshot?.instrument?.displaySymbol || 'chart').replace(/[^a-zA-Z0-9_-]/g, '_');
      downloadDataUrl(this.currentDataUrl, `${sym}_AI_annotated.png`);
    });

    this.btnCopy?.addEventListener('click', async () => {
      if (!this.currentDataUrl) return;
      try {
        const res = await fetch(this.currentDataUrl);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const orig = this.btnCopy.textContent;
        this.btnCopy.textContent = '已复制 ✓';
        setTimeout(() => { this.btnCopy.textContent = orig; }, 1600);
      } catch {
        const sym = (this.snapshot?.instrument?.displaySymbol || 'chart').replace(/[^a-zA-Z0-9_-]/g, '_');
        downloadDataUrl(this.currentDataUrl, `${sym}_AI_annotated.png`);
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (this.activeTool === 'none' || !this.snapshot) return;
      const pt = this._getCanvasChartCoords(e);
      if (this.activeTool === 'text') {
        const text = window.prompt('输入截屏标注文字：');
        if (text && text.trim()) {
          this.userMarkups.push({ tool: 'text', x1: pt.x, y1: pt.y, text: text.trim(), color: '#ff6d00' });
          this.redraw();
        }
        return;
      }
      this.draftMarkup = {
        tool: this.activeTool,
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
        color: '#ff6d00'
      };
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.draftMarkup) return;
      const pt = this._getCanvasChartCoords(e);
      this.draftMarkup.x2 = pt.x;
      this.draftMarkup.y2 = pt.y;
      this.redraw();
    });

    window.addEventListener('mouseup', () => {
      if (!this.draftMarkup) return;
      if (Math.hypot(this.draftMarkup.x2 - this.draftMarkup.x1, this.draftMarkup.y2 - this.draftMarkup.y1) > 4) {
        this.userMarkups.push({ ...this.draftMarkup });
      }
      this.draftMarkup = null;
      this.redraw();
    });
  }
}
