/**
 * AI Chart Screenshot Annotator & Offscreen 1600x900 @ 2x DPR Exporter.
 * Takes a captured LWC v5.2.1 chart snapshot (with native Series Primitive annotations)
 * and renders a crisp, light-theme 1600x900 (3200x1800 physical px @ 2x DPR) PNG
 * with header bar (stock & exchange, interval, IST data time, price basis) and legend footer.
 */

import { detectRupeeGlyphSupport } from './lwcAnnotationPrimitive.js';
import { formatPrice, formatVolume, formatTimeLabel } from './indicators.js';
import { getLangPack } from './i18n.js';

export const EXPORT_CONFIG = {
  width: 1600,
  height: 900,
  headerHeight: 44,
  footerHeight: 32,
  chartHeight: 824, // 900 - 44 - 32
  dpr: 2,
  theme: 'light',
  language: 'en'
};

let _cachedCjkSupport = null;

export function detectCjkGlyphSupport() {
  if (_cachedCjkSupport !== null) return _cachedCjkSupport;
  try {
    if (typeof document === 'undefined') {
      _cachedCjkSupport = false;
      return false;
    }
    const c = document.createElement('canvas');
    c.width = 48;
    c.height = 48;
    const ctx = c.getContext('2d');
    if (!ctx) {
      _cachedCjkSupport = false;
      return false;
    }
    const renderSample = (ch) => {
      ctx.clearRect(0, 0, 48, 48);
      ctx.fillStyle = '#000000';
      ctx.font = '24px "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(ch, 4, 4);
      const data = ctx.getImageData(0, 0, 48, 48).data;
      let nonZero = 0;
      const hash = [];
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 20) nonZero++;
        hash.push(data[i] > 20 ? 1 : 0);
      }
      return { nonZero, sig: hash.join('') };
    };
    const cjk = renderSample('支');
    const cjk2 = renderSample('撑');
    const missing = renderSample('\uFFFF');
    _cachedCjkSupport = cjk.nonZero > 12 && cjk2.nonZero > 12 && cjk.sig !== missing.sig && cjk.sig !== cjk2.sig;
    return _cachedCjkSupport;
  } catch {
    _cachedCjkSupport = false;
    return false;
  }
}

export function detectChartFontSupport(requestedLang = EXPORT_CONFIG.language) {
  const rupee = detectRupeeGlyphSupport();
  const cjkSupported = detectCjkGlyphSupport();
  const useLang = requestedLang === 'zh-CN' && !cjkSupported ? 'en' : (requestedLang || EXPORT_CONFIG.language);
  const fontFallbackReason =
    requestedLang === 'zh-CN' && !cjkSupported ? 'CJK font unavailable on host; downgraded to English ASCII' : null;
  return {
    rupeeSupported: rupee.supported,
    currencyPrefix: rupee.prefix,
    cjkSupported,
    effectiveLang: useLang,
    fontFallbackReason
  };
}

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
 * Render an executive-grade Annotated Chart Screenshot PNG (default 1600x900 @ 2x DPR, light theme).
 * Chart annotations are natively rendered inside snapshot.cleanDataUrl via LWC Series Primitive.
 */
export async function renderAnnotatedScreenshot(snapshot, annotations, meta = {}, options = {}) {
  const {
    lang = EXPORT_CONFIG.language,
    theme = EXPORT_CONFIG.theme,
    width = EXPORT_CONFIG.width,
    height = EXPORT_CONFIG.height,
    dpr = EXPORT_CONFIG.dpr,
    userMarkups = []
  } = options;

  const fontInfo = detectChartFontSupport(lang);
  const effectiveLang = fontInfo.effectiveLang;
  const pack = getLangPack(effectiveLang);
  const C = pack.chart;
  const H = pack.hud;

  const headerH = EXPORT_CONFIG.headerHeight;
  const footerH = EXPORT_CONFIG.footerHeight;
  const totalW = width;
  const totalH = height;
  const chartAreaH = Math.max(120, totalH - headerH - footerH);

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(totalW * dpr);
  canvas.height = Math.floor(totalH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const isDark = theme === 'dark';
  const bg = isDark ? '#131722' : '#ffffff';
  const barBg = isDark ? '#1e222d' : '#f8f9fd';
  const border = isDark ? '#2a2e39' : '#e0e3eb';
  const fg = isDark ? '#d1d4dc' : '#131722';
  const muted = '#5d606b';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, totalW, totalH);

  // 1. Header Stamp Bar (Stock & Exchange, Interval, Data Time IST, Price Basis, Bias Pill)
  ctx.fillStyle = barBg;
  ctx.fillRect(0, 0, totalW, headerH);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH - 0.5);
  ctx.lineTo(totalW, headerH - 0.5);
  ctx.stroke();

  const inst = snapshot.instrument || {};
  const dataMeta = snapshot.dataMeta || meta.dataMeta || null;
  const symCode = dataMeta?.resolvedSymbol || inst.symbol || inst.displaySymbol || 'CHART';
  const exchange = dataMeta?.exchange || inst.exchange || (inst.market === 'in' ? 'NSE' : '');
  const intervalStr = String(snapshot.interval || '1d').toUpperCase();
  const displayName =
    effectiveLang === 'en'
      ? (inst.enName || inst.displaySymbol || symCode)
      : (inst.name || inst.enName || inst.displaySymbol || symCode);

  const priceBasis = inst.market === 'in' ? `Price: INR (${fontInfo.currencyPrefix})` : 'Price: USD';
  const headerTitle = `${displayName} (${symCode}${exchange ? ` · ${exchange}` : ''})  |  ${intervalStr}  |  ${priceBasis}`;

  ctx.fillStyle = fg;
  ctx.font = '700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(headerTitle, 18, headerH / 2);

  // Bias Verdict Pill
  const bias = meta.bias || 'neutral';
  const biasWord = bias === 'bullish' ? C.biasBull : bias === 'bearish' ? C.biasBear : C.biasNeu;
  const biasLabel = `${C.verdictPrefix}: ${biasWord}`;
  const biasColor = bias === 'bullish' ? '#089981' : bias === 'bearish' ? '#f23645' : '#2962ff';
  const titleW = ctx.measureText(headerTitle).width;
  const pillX = Math.min(totalW - 380, 32 + titleW);

  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  const pillText = meta.confidence ? `${biasLabel} (${meta.confidence}%)` : biasLabel;
  const pillW = ctx.measureText(pillText).width + 18;
  ctx.fillStyle = biasColor;
  const rx = pillX;
  const ry = headerH / 2 - 11;
  const rh = 22;
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
  ctx.fillText(pillText, pillX + 9, headerH / 2 + 0.5);

  // IST Data Time Stamp (right side of header)
  const latestSec = dataMeta?.latestBarTime || snapshot.latestCandle?.time || Math.floor((snapshot.capturedAt || Date.now()) / 1000);
  const istTimeStr = formatTimeLabel(latestSec, '15m', true);
  const statusTag =
    dataMeta?.source === 'simulated'
      ? 'SIMULATED'
      : dataMeta?.source === 'cache' || dataMeta?.stale
        ? (dataMeta?.stale ? 'CACHE (STALE)' : 'CACHE')
        : 'LIVE';
  const stamp = `Data: ${istTimeStr}  |  ${statusTag}`;
  ctx.fillStyle = muted;
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(stamp, totalW - 18, headerH / 2);
  ctx.textAlign = 'left';

  // 2. Base LWC Chart Image (already includes native Series Primitive annotations)
  if (snapshot.cleanDataUrl) {
    const baseImg = await loadImage(snapshot.cleanDataUrl);
    ctx.drawImage(baseImg, 0, headerH, totalW, chartAreaH);
  }

  // OHLCV Stamp inside chart top-left
  if (snapshot.latestCandle) {
    const c = snapshot.latestCandle;
    const prec = snapshot.geometry?.precision ?? 2;
    const pc = snapshot.prevClose ?? c.open;
    const diff = c.close - pc;
    const pct = pc ? (diff / pc) * 100 : 0;
    const col = diff >= 0 ? '#089981' : '#f23645';
    const txt = `${H.open} ${formatPrice(c.open, prec)}  ${H.high} ${formatPrice(c.high, prec)}  ${H.low} ${formatPrice(c.low, prec)}  ${H.close} ${formatPrice(c.close, prec)}  ${diff >= 0 ? '+' : ''}${formatPrice(diff, prec)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ${H.vol} ${formatVolume(c.volume)}`;
    ctx.save();
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = isDark ? 'rgba(19,23,34,0.82)' : 'rgba(255,255,255,0.9)';
    ctx.fillRect(10, headerH + 6, tw + 12, 18);
    ctx.fillStyle = col;
    ctx.fillText(txt, 16, headerH + 9);
    ctx.restore();
  }

  // Simulated watermark ONLY when source === 'simulated'
  if (dataMeta?.source === 'simulated') {
    ctx.save();
    ctx.translate(totalW / 2, headerH + chartAreaH / 2);
    ctx.rotate(-0.24);
    ctx.font = '800 44px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(242, 54, 69, 0.14)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SIMULATED DATA - DEMO ONLY', 0, 0);
    ctx.restore();
  }

  // 3. Draw any user manual markups from Screenshot Studio
  if (userMarkups.length) {
    ctx.save();
    ctx.translate(0, headerH);
    drawUserMarkups(ctx, userMarkups);
    ctx.restore();
  }

  // 4. Legend Footer Bar
  const footY = headerH + chartAreaH;
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
  let lx = 18;
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  for (const item of legendItems) {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, footY + footerH / 2 - 4, 10, 8);
    ctx.fillStyle = muted;
    ctx.fillText(item.label, lx + 15, footY + footerH / 2 + 0.5);
    lx += ctx.measureText(item.label).width + 32;
  }

  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  ctx.fillText(C.shotFooter, totalW - 18, footY + footerH / 2 + 0.5);
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
    const scaleX = EXPORT_CONFIG.width / rect.width;
    const scaleY = EXPORT_CONFIG.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY - EXPORT_CONFIG.headerHeight
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
