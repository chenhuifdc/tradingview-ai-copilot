/**
 * High-DPI TradingView-grade Multi-Pane Canvas Chart Engine.
 * Supports:
 * - Interactive Candlesticks, Volume, EMA 20/50/200, Bollinger Bands, LuxAlgo Auto S&R
 * - Resizable MACD (10, 21, 9) sub-pane with 4-color histogram
 * - AI Annotations anchored to candle index & price (Horizontal S&R, Trendlines, Technical Patterns,
 *   Bear/Bull Wick signals, Entry/SL/TP Trade Plans)
 * - Manual drawing tools (Horizontal line, Trendline, Box zone, Price/Bar Measure)
 * - Clean snapshot capture with exact geometry export for Screenshot Annotator
 */

import {
  computeAllIndicators,
  formatPrice,
  formatVolume,
  formatTimeLabel,
  getPrecision,
  getEmaColor
} from './indicators.js';
import { getLangPack, resolveChartLabel } from './i18n.js';

const THEMES = {
  light: {
    bg: '#ffffff',
    paneBorder: '#e0e3eb',
    grid: '#f0f3fa',
    text: '#131722',
    muted: '#787b86',
    crosshair: '#787b86',
    crosshairBg: '#131722',
    crosshairText: '#ffffff',
    bull: '#089981',
    bear: '#f23645',
    volBull: 'rgba(8, 153, 129, 0.34)',
    volBear: 'rgba(242, 54, 69, 0.34)',
    resistance: '#ef5350',
    support: '#2962ff',
    uptrend: '#089981',
    downtrend: '#f23645',
    channel: '#2962ff',
    ema20: '#2962ff',
    ema50: '#ff9800',
    ema200: '#6a1b9a',
    bollLine: 'rgba(41, 98, 255, 0.45)',
    bollFill: 'rgba(41, 98, 255, 0.05)',
    macdLine: '#2962ff',
    signalLine: '#ff6d00',
    histUpStrong: '#26a69a',
    histUpWeak: '#b2dfdb',
    histDownStrong: '#ef5350',
    histDownWeak: '#ffcdd2',
    eventBg: '#ffffff',
    eventBorder: '#b2b5be',
    eventText: '#434651'
  },
  dark: {
    bg: '#131722',
    paneBorder: '#2a2e39',
    grid: '#1e222d',
    text: '#d1d4dc',
    muted: '#787b86',
    crosshair: '#9598a1',
    crosshairBg: '#363a45',
    crosshairText: '#ffffff',
    bull: '#089981',
    bear: '#f23645',
    volBull: 'rgba(8, 153, 129, 0.32)',
    volBear: 'rgba(242, 54, 69, 0.32)',
    resistance: '#f23645',
    support: '#3b82f6',
    uptrend: '#26a69a',
    downtrend: '#f23645',
    channel: '#3b82f6',
    ema20: '#3b82f6',
    ema50: '#f59e0b',
    ema200: '#c084fc',
    bollLine: 'rgba(59, 130, 246, 0.48)',
    bollFill: 'rgba(59, 130, 246, 0.07)',
    macdLine: '#3b82f6',
    signalLine: '#f59e0b',
    histUpStrong: '#26a69a',
    histUpWeak: 'rgba(38, 166, 154, 0.42)',
    histDownStrong: '#ef5350',
    histDownWeak: 'rgba(239, 83, 80, 0.42)',
    eventBg: '#1e222d',
    eventBorder: '#434651',
    eventText: '#d1d4dc'
  }
};

function drawRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Shared AI Annotation Renderer — used identically on BOTH live chart canvas & annotated PNG screenshots!
 */
export function drawAnnotationsLayer(ctx, geo, annotations, options = {}) {
  if (!annotations) return;
  const palette = THEMES[geo.theme] || THEMES.light;
  const activeLang = options.lang || geo.lang || 'zh-CN';
  const C = getLangPack(activeLang).chart;
  const layers = {
    horizontalLevels: true,
    trendlines: true,
    patterns: true,
    signals: true,
    tradePlan: true,
    ...(options.layers || {})
  };
  const highlightPrice = options.highlightPrice ?? null;
  const { plotLeft, plotTop, plotWidth, plotHeight, priceAxisWidth, indexToX, priceToY, precision } = geo;
  const plotRight = plotLeft + plotWidth;
  const plotBottom = plotTop + plotHeight;

  const axisBadges = []; // Collect right-axis badges for vertical collision avoidance

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();

  // 1. Technical Chart Patterns (drawn behind lines so candlesticks stay crisp)
  if (layers.patterns && Array.isArray(annotations.patterns)) {
    for (const pat of annotations.patterns) {
      if (!pat) continue;
      const isBull = pat.bias === 'bullish';
      const isBear = pat.bias === 'bearish';
      const strokeColor = isBull ? palette.uptrend : isBear ? palette.downtrend : palette.channel;
      const fillColor = isBull
        ? 'rgba(8, 153, 129, 0.11)'
        : isBear
          ? 'rgba(242, 54, 69, 0.11)'
          : 'rgba(41, 98, 255, 0.10)';

      // Polygon fill
      if (Array.isArray(pat.points) && pat.points.length >= 3) {
        ctx.beginPath();
        pat.points.forEach((pt, idx) => {
          const x = indexToX(pt.index);
          const y = priceToY(pt.price);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
      }

      // Upper & lower pattern boundaries
      const drawBound = (line) => {
        if (!line) return;
        const x1 = indexToX(line.startIndex);
        const y1 = priceToY(line.startPrice);
        const x2 = indexToX(line.endIndex);
        const y2 = priceToY(line.endPrice);
        ctx.save();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      };
      drawBound(pat.upperLine);
      drawBound(pat.lowerLine);

      // Breakout target arrow + pill
      if (Number.isFinite(pat.breakoutTarget) && pat.upperLine) {
        const endIdx = pat.upperLine.endIndex ?? (pat.points?.[1]?.index ?? geo.visibleEnd);
        const startPrice = pat.upperLine.endPrice ?? pat.points?.[1]?.price;
        if (Number.isFinite(startPrice)) {
          const sx = Math.min(plotRight - 42, indexToX(endIdx) + 6);
          const sy = priceToY(startPrice);
          const ty = Math.max(plotTop + 20, Math.min(plotBottom - 20, priceToY(pat.breakoutTarget)));
          const tx = Math.min(plotRight - 14, sx + 34);

          ctx.save();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1.6;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
          // Arrowhead
          const ang = Math.atan2(ty - sy, tx - sx);
          ctx.fillStyle = strokeColor;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - 7 * Math.cos(ang - 0.45), ty - 7 * Math.sin(ang - 0.45));
          ctx.lineTo(tx - 7 * Math.cos(ang + 0.45), ty - 7 * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      // Pattern Badge Label
      if (pat.label || pat.name || pat.labelKey) {
        const pts = pat.points || [];
        let cx = plotLeft + plotWidth * 0.55;
        let cy = plotTop + 44;
        if (pts.length) {
          cx = pts.reduce((a, p) => a + indexToX(p.index), 0) / pts.length;
          const topY = Math.min(...pts.map((p) => priceToY(p.price)));
          cy = Math.max(plotTop + 26, topY - 16);
        }
        const resolvedPat = resolveChartLabel(pat, activeLang);
        const labelText = `△ ${resolvedPat}`;
        ctx.save();
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const tw = ctx.measureText(labelText).width;
        const bw = tw + 14;
        const bh = 20;
        const bx = Math.max(plotLeft + 8, Math.min(plotRight - bw - 8, cx - bw / 2));
        const by = Math.max(plotTop + 8, Math.min(plotBottom - bh - 8, cy - bh / 2));
        drawRoundRect(ctx, bx, by, bw, bh, 4);
        ctx.fillStyle = strokeColor;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, bx + 7, by + bh / 2 + 0.5);
        ctx.restore();
      }
    }
  }

  // 2. Trade Plan Box (Entry / Stop-Loss / Take-Profit)
  if (layers.tradePlan && annotations.tradePlan) {
    const tp = annotations.tradePlan;
    if (Number.isFinite(tp.entry) && Number.isFinite(tp.stopLoss) && Number.isFinite(tp.takeProfit)) {
      const startX = Math.max(plotLeft + 20, indexToX(tp.startIndex ?? Math.max(0, geo.visibleEnd - 12)));
      const endX = plotRight - 4;
      const boxW = Math.max(48, endX - startX);
      const yEntry = priceToY(tp.entry);
      const ySL = priceToY(tp.stopLoss);
      const yTP = priceToY(tp.takeProfit);

      ctx.fillStyle = 'rgba(8, 153, 129, 0.14)';
      ctx.fillRect(startX, Math.min(yEntry, yTP), boxW, Math.abs(yTP - yEntry));
      ctx.strokeStyle = 'rgba(8, 153, 129, 0.72)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(startX, yTP);
      ctx.lineTo(endX, yTP);
      ctx.stroke();

      ctx.fillStyle = 'rgba(242, 54, 69, 0.14)';
      ctx.fillRect(startX, Math.min(yEntry, ySL), boxW, Math.abs(ySL - yEntry));
      ctx.strokeStyle = 'rgba(242, 54, 69, 0.75)';
      ctx.beginPath();
      ctx.moveTo(startX, ySL);
      ctx.lineTo(endX, ySL);
      ctx.stroke();

      ctx.strokeStyle = palette.support;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(startX, yEntry);
      ctx.lineTo(endX, yEntry);
      ctx.stroke();

      const risk = Math.abs(tp.entry - tp.stopLoss);
      const reward = Math.abs(tp.takeProfit - tp.entry);
      const rr = risk > 0 ? (reward / risk).toFixed(2) : '2.0';
      const dirText = tp.direction === 'short' ? C.shortPlan : C.longPlan;
      const tag = `${dirText}  R:R 1:${rr}`;
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const tw = ctx.measureText(tag).width;
      const bw = tw + 12;
      const bx = Math.min(plotRight - bw - 6, startX + 6);
      const by = Math.max(plotTop + 6, yEntry - 21);
      drawRoundRect(ctx, bx, by, bw, 18, 3);
      ctx.fillStyle = tp.direction === 'short' ? '#f23645' : '#089981';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, bx + 6, by + 9.5);

      const drawMiniTag = (text, rawY, color) => {
        ctx.font = '600 10px -apple-system, sans-serif';
        const tw2 = ctx.measureText(text).width;
        const bw2 = tw2 + 10;
        const bh2 = 16;
        const clampedY = Math.max(plotTop + 6, Math.min(plotBottom - bh2 - 6, rawY - bh2 / 2));
        drawRoundRect(ctx, startX + 5, clampedY, bw2, bh2, 3);
        ctx.fillStyle = geo.theme === 'dark' ? 'rgba(19, 23, 34, 0.88)' : 'rgba(255, 255, 255, 0.92)';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, startX + 10, clampedY + bh2 / 2 + 0.5);
      };
      drawMiniTag(`${C.tp} ${formatPrice(tp.takeProfit, precision)}`, yTP + (yTP < yEntry ? 11 : -11), '#089981');
      drawMiniTag(`${C.sl} ${formatPrice(tp.stopLoss, precision)}`, ySL + (ySL > yEntry ? -11 : 11), '#f23645');

      axisBadges.push({ y: yTP, price: tp.takeProfit, color: '#089981', tag: 'TP' });
      axisBadges.push({ y: ySL, price: tp.stopLoss, color: '#f23645', tag: 'SL' });
    }
  }

  // 3. Horizontal Support & Resistance Lines
  if (layers.horizontalLevels && Array.isArray(annotations.horizontalLevels)) {
    for (const lvl of annotations.horizontalLevels) {
      if (!lvl || !Number.isFinite(lvl.price)) continue;
      const y = priceToY(lvl.price);
      if (y < plotTop - 20 || y > plotBottom + 20) continue;

      const isRes = lvl.type === 'resistance';
      const color = isRes ? palette.resistance : palette.support;
      const isHighlighted =
        highlightPrice !== null &&
        Math.abs(lvl.price - highlightPrice) / Math.max(0.0001, Math.abs(lvl.price)) < 0.002;

      const x1 = Number.isFinite(lvl.startIndex)
        ? Math.max(plotLeft, indexToX(lvl.startIndex))
        : plotLeft;
      const x2 = plotRight;

      ctx.save();
      if (isHighlighted) {
        ctx.strokeStyle = isRes ? 'rgba(239, 83, 80, 0.28)' : 'rgba(41, 98, 255, 0.28)';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = lvl.strength === 'strong' || isHighlighted ? 2.2 : 1.6;
      if (lvl.strength === 'medium') ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const resolvedLvl = resolveChartLabel(lvl, activeLang) || (isRes ? C.resistance : C.support);
      const label = `${resolvedLvl} ${formatPrice(lvl.price, precision)}`;
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const tw = ctx.measureText(label).width;
      const bw = tw + 12;
      const bh = 18;
      const bx = Math.max(plotLeft + 8, Math.min(plotRight - bw - 10, x1 + 6));
      const by = isRes ? Math.max(plotTop + 4, y - bh - 3) : Math.min(plotBottom - bh - 4, y + 4);
      drawRoundRect(ctx, bx, by, bw, bh, 3);
      ctx.fillStyle = geo.theme === 'dark' ? 'rgba(30, 34, 45, 0.9)' : 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + bh / 2 + 0.5);
      ctx.restore();

      axisBadges.push({ y, price: lvl.price, color, priority: isHighlighted ? 2 : 1 });
    }
  }

  // 4. Trendlines & Rays
  if (layers.trendlines && Array.isArray(annotations.trendlines)) {
    for (const tl of annotations.trendlines) {
      if (!tl || !Number.isFinite(tl.startIndex) || !Number.isFinite(tl.endIndex)) continue;
      const x1 = indexToX(tl.startIndex);
      const y1 = priceToY(tl.startPrice);
      const x2 = indexToX(tl.endIndex);
      const y2 = priceToY(tl.endPrice);

      const color =
        tl.type === 'uptrend'
          ? palette.uptrend
          : tl.type === 'downtrend'
            ? palette.downtrend
            : palette.channel;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      let labelX = (x1 + x2) / 2;
      let labelY = (y1 + y2) / 2;
      if (tl.extendRight && x2 > x1) {
        const slopePx = (y2 - y1) / (x2 - x1);
        const rx = plotRight;
        const ry = y2 + slopePx * (rx - x2);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      for (const [ax, ay] of [[x1, y1], [x2, y2]]) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ax, ay, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      const tlText = resolveChartLabel(tl, activeLang);
      if (tlText) {
        ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const tw = ctx.measureText(tlText).width;
        const bw = tw + 10;
        const bh = 17;
        const bx = Math.max(plotLeft + 8, Math.min(plotRight - bw - 8, labelX - bw / 2));
        const by = Math.max(plotTop + 6, Math.min(plotBottom - bh - 6, labelY - bh - 5));
        drawRoundRect(ctx, bx, by, bw, bh, 3);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(tlText, bx + 5, by + bh / 2 + 0.5);
      }
      ctx.restore();
    }
  }

  // 5. Wick & Price-Action Signals
  if (layers.signals && Array.isArray(annotations.signals)) {
    for (const sig of annotations.signals) {
      if (!sig || !Number.isFinite(sig.index) || !Number.isFinite(sig.price)) continue;
      const x = indexToX(sig.index);
      const y = priceToY(sig.price);
      if (x < plotLeft || x > plotRight) continue;

      const isBear = sig.kind === 'bear_wick' || sig.kind === 'breakdown';
      const bg = isBear ? '#f23645' : sig.kind === 'breakout' ? '#2962ff' : '#089981';
      const text = resolveChartLabel(sig, activeLang) || (isBear ? C.bearWick : C.bullWick);

      ctx.save();
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const tw = ctx.measureText(text).width;
      const bw = tw + 12;
      const bh = 17;
      const bx = Math.max(plotLeft + 4, Math.min(plotRight - bw - 4, x - bw / 2));
      const by = isBear
        ? Math.max(plotTop + 4, y - bh - 8)
        : Math.min(plotBottom - bh - 4, y + 8);

      ctx.fillStyle = bg;
      ctx.beginPath();
      if (isBear) {
        ctx.moveTo(x - 4, by + bh);
        ctx.lineTo(x + 4, by + bh);
        ctx.lineTo(x, by + bh + 5);
      } else {
        ctx.moveTo(x - 4, by);
        ctx.lineTo(x + 4, by);
        ctx.lineTo(x, by - 5);
      }
      ctx.closePath();
      ctx.fill();

      drawRoundRect(ctx, bx, by, bw, bh, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 6, by + bh / 2 + 0.5);
      ctx.restore();
    }
  }

  ctx.restore();

  // 6. Right Price Axis Badges with vertical collision avoidance
  if (axisBadges.length && priceAxisWidth > 0) {
    axisBadges.sort((a, b) => a.y - b.y);
    const placedY = [];
    const pillH = 18;

    ctx.save();
    ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const b of axisBadges) {
      let py = Math.max(plotTop + pillH / 2, Math.min(plotBottom - pillH / 2, b.y));
      for (const prevY of placedY) {
        if (Math.abs(py - prevY) < pillH + 2) {
          py = prevY + pillH + 2;
        }
      }
      if (py > plotBottom - pillH / 2) continue;
      placedY.push(py);

      const label = formatPrice(b.price, precision);
      ctx.fillStyle = b.color;
      drawRoundRect(ctx, plotRight + 1, py - pillH / 2, priceAxisWidth - 4, pillH, 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, plotRight + 6, py + 0.5);
    }
    ctx.restore();
  }
}

export class ChartEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHoverChange = options.onHoverChange || (() => {});
    this.onDrawingsChange = options.onDrawingsChange || (() => {});
    this.onToolChange = options.onToolChange || (() => {});

    this.theme = 'light';
    this.lang = 'zh-CN';
    this.candles = [];
    this.events = [];
    this.instrument = { displaySymbol: 'ALKALI', name: '碱金属有限公司', exchange: 'NSE' };
    this.interval = '1d';
    this.precision = 2;
    this.indicators = null;

    // Indicator toggles
    this.showVolume = true;
    this.showMACD = true;
    this.showEMA = true;
    this.emaPeriods = [5, 10, 20];
    this.showBoll = false;
    this.showLuxSR = true;
    this.showAIAnnotations = true;

    // Viewport state
    this.barSpacing = 8.5;
    this.rightOffset = 10;
    this.scrollOffset = 0; // bars shifted left from rightmost
    this.yScaleFactor = 1.0;
    this.macdRatio = 0.25;

    // Layout geometry
    this.priceAxisWidth = 78;
    this.timeAxisHeight = 28;
    this.width = 900;
    this.height = 560;
    this.dpr = window.devicePixelRatio || 1;

    // Interactive state
    this.mouse = { x: -1, y: -1, inside: false };
    this.dragMode = null; // 'pan' | 'yscale' | 'splitter' | 'drawing'
    this.dragStart = null;
    this.activeTool = 'crosshair'; // 'crosshair' | 'hline' | 'trendline' | 'box' | 'measure'
    this.pendingDrawing = null;

    // Overlays
    this.aiAnnotations = null;
    this.aiLayerFlags = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true
    };
    this.manualDrawings = [];
    this.highlightPrice = null;
    this.highlightTimer = null;

    this._bindEvents();
    this.resize();
  }

  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this.render();
  }

  setLanguage(lang) {
    this.lang = lang || 'zh-CN';
    this.render();
  }

  setEmaConfig({ showEMA, periods } = {}) {
    if (typeof showEMA === 'boolean') this.showEMA = showEMA;
    if (Array.isArray(periods)) {
      const clean = [...new Set(periods.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 2 && n <= 500))]
        .sort((a, b) => a - b);
      this.emaPeriods = clean;
    }
    if (this.candles.length) {
      this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    }
    this.render();
  }

  setTool(tool) {
    this.activeTool = tool;
    this.pendingDrawing = null;
    this.canvas.style.cursor = tool === 'crosshair' ? 'crosshair' : 'cell';
    this.onToolChange(tool);
    this.render();
  }

  setData({ candles, events, instrument, interval }) {
    this.candles = candles || [];
    this.events = events || [];
    if (instrument) this.instrument = instrument;
    if (interval) this.interval = interval;
    const lastClose = this.candles.length ? this.candles[this.candles.length - 1].close : 100;
    this.precision = getPrecision(lastClose);
    this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    this.scrollOffset = 0;
    this.yScaleFactor = 1.0;
    this.fitDefaultZoom();
    this.render();
  }

  updateLiveCandle(candle) {
    if (!candle || !this.candles.length) return;
    const last = this.candles[this.candles.length - 1];
    if (candle.time === last.time) {
      this.candles[this.candles.length - 1] = { ...candle };
    } else if (candle.time > last.time) {
      this.candles.push({ ...candle });
      if (this.candles.length > 1400) this.candles.shift();
    }
    this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    this.render();
  }

  setAIAnnotations(annotations) {
    this.aiAnnotations = annotations;
    this.showAIAnnotations = true;
    this.render();
  }

  clearAIAnnotations() {
    this.aiAnnotations = null;
    this.render();
  }

  clearManualDrawings() {
    this.manualDrawings = [];
    this.pendingDrawing = null;
    this.onDrawingsChange(this.manualDrawings);
    this.render();
  }

  flashPriceLevel(price) {
    this.highlightPrice = price;
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.render();
    this.highlightTimer = setTimeout(() => {
      this.highlightPrice = null;
      this.render();
    }, 2400);
  }

  fitDefaultZoom() {
    const plotW = Math.max(200, this.width - this.priceAxisWidth);
    const targetBars = Math.min(Math.max(this.candles.length, 60), 125);
    this.barSpacing = Math.max(4.5, Math.min(16, plotW / (targetBars + this.rightOffset)));
    this.scrollOffset = 0;
    this.yScaleFactor = 1.0;
  }

  zoomBy(factor, anchorX = null) {
    const prevSpacing = this.barSpacing;
    const nextSpacing = Math.max(3.2, Math.min(34, prevSpacing * factor));
    if (Math.abs(nextSpacing - prevSpacing) < 0.01) return;

    const plotW = this.width - this.priceAxisWidth;
    const pivotX = anchorX !== null ? anchorX : plotW * 0.7;
    const barsFromRight = (plotW - pivotX) / prevSpacing;
    const nextBarsFromRight = (plotW - pivotX) / nextSpacing;
    this.scrollOffset = Math.max(
      -this.rightOffset + 2,
      Math.min(Math.max(0, this.candles.length - 15), this.scrollOffset + (barsFromRight - nextBarsFromRight))
    );
    this.barSpacing = nextSpacing;
    this.render();
  }

  resize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return;
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  getGeometry() {
    const plotLeft = 0;
    const plotTop = 0;
    const plotWidth = Math.max(120, this.width - this.priceAxisWidth);
    const totalPlotH = Math.max(120, this.height - this.timeAxisHeight);
    const macdHeight = this.showMACD ? Math.max(85, Math.min(totalPlotH * 0.44, Math.floor(totalPlotH * this.macdRatio))) : 0;
    const mainHeight = totalPlotH - macdHeight;

    const n = this.candles.length;
    const rightBarFloat = n - 1 + this.rightOffset - this.scrollOffset;

    const indexToX = (idx) => plotWidth - (rightBarFloat - idx) * this.barSpacing;
    const xToIndex = (x) => rightBarFloat - (plotWidth - x) / this.barSpacing;

    const visibleStart = Math.max(0, Math.floor(xToIndex(0)) - 1);
    const visibleEnd = Math.min(n - 1, Math.ceil(xToIndex(plotWidth)) + 1);

    // Compute visible price min/max
    let minP = Infinity;
    let maxP = -Infinity;
    for (let i = visibleStart; i <= visibleEnd; i++) {
      const c = this.candles[i];
      if (!c) continue;
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
      minP = 90;
      maxP = 110;
    }

    // Expand slightly to keep AI horizontal levels & trade plan visible if close
    if (this.showAIAnnotations && this.aiAnnotations) {
      const tp = this.aiAnnotations.tradePlan;
      if (tp && Number.isFinite(tp.takeProfit) && Number.isFinite(tp.stopLoss)) {
        const span = maxP - minP;
        if (tp.takeProfit < maxP + span * 0.45) maxP = Math.max(maxP, tp.takeProfit);
        if (tp.stopLoss > minP - span * 0.45) minP = Math.min(minP, tp.stopLoss);
      }
    }

    const midP = (minP + maxP) / 2;
    const halfSpan = ((maxP - minP) / 2) * (1.16 / this.yScaleFactor);
    const topP = midP + halfSpan;
    const botP = midP - halfSpan * 1.12; // extra room at bottom for volume & event badges

    const padTop = 36;
    const padBot = 24;
    const usableH = Math.max(40, mainHeight - padTop - padBot);

    const priceToY = (p) => plotTop + padTop + ((topP - p) / Math.max(1e-9, topP - botP)) * usableH;
    const yToPrice = (y) => topP - ((y - plotTop - padTop) / usableH) * (topP - botP);

    return {
      width: this.width,
      height: this.height,
      theme: this.theme,
      lang: this.lang,
      precision: this.precision,
      plotLeft,
      plotTop,
      plotWidth,
      plotHeight: mainHeight,
      mainHeight,
      macdTop: mainHeight,
      macdHeight,
      priceAxisWidth: this.priceAxisWidth,
      timeAxisTop: totalPlotH,
      timeAxisHeight: this.timeAxisHeight,
      visibleStart,
      visibleEnd,
      minPrice: botP,
      maxPrice: topP,
      indexToX,
      xToIndex,
      priceToY,
      yToPrice
    };
  }

  getVisibleRange() {
    const geo = this.getGeometry();
    return {
      visibleStart: geo.visibleStart,
      visibleEnd: geo.visibleEnd
    };
  }

  /**
   * Capture a clean high-DPI chart snapshot + exact coordinate mapping for the AI Screenshot Annotator.
   */
  captureSnapshot({ includeCurrentAI = false } = {}) {
    const offscreen = document.createElement('canvas');
    const scale = 2;
    offscreen.width = Math.floor(this.width * scale);
    offscreen.height = Math.floor(this.height * scale);
    const octx = offscreen.getContext('2d');
    octx.scale(scale, scale);

    const geo = this.getGeometry();
    this._drawFrame(octx, geo, {
      drawCrosshair: false,
      drawAI: includeCurrentAI,
      drawSnapshotHeader: false
    });

    const lastCandle = this.candles.length ? { ...this.candles[this.candles.length - 1] } : null;
    const prevCandle = this.candles.length > 1 ? { ...this.candles[this.candles.length - 2] } : lastCandle;

    return {
      cleanDataUrl: offscreen.toDataURL('image/png'),
      width: this.width,
      height: this.height,
      dpr: scale,
      geometry: geo,
      visibleStart: geo.visibleStart,
      visibleEnd: geo.visibleEnd,
      instrument: { ...this.instrument },
      interval: this.interval,
      latestCandle: lastCandle,
      prevClose: prevCandle?.close ?? null,
      capturedAt: Date.now()
    };
  }

  render() {
    if (!this.ctx) return;
    const geo = this.getGeometry();
    this.ctx.save();
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawFrame(this.ctx, geo, {
      drawCrosshair: true,
      drawAI: this.showAIAnnotations
    });
    this.ctx.restore();
  }

  _computeNiceTicks(minVal, maxVal, targetCount = 8) {
    const span = maxVal - minVal;
    if (span <= 0) return [];
    const rawStep = span / targetCount;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / pow10;
    let niceNorm = 1;
    if (norm <= 1.2) niceNorm = 1;
    else if (norm <= 2.2) niceNorm = 2;
    else if (norm <= 3.5) niceNorm = 2.5;
    else if (norm <= 6.5) niceNorm = 5;
    else niceNorm = 10;
    const step = niceNorm * pow10;
    const first = Math.ceil(minVal / step) * step;
    const ticks = [];
    for (let v = first; v <= maxVal; v += step) {
      ticks.push(v);
      if (ticks.length > 25) break;
    }
    return ticks;
  }

  _drawFrame(ctx, geo, opts = {}) {
    const palette = THEMES[this.theme] || THEMES.light;
    const {
      width,
      height,
      plotWidth,
      mainHeight,
      macdTop,
      macdHeight,
      timeAxisTop,
      visibleStart,
      visibleEnd,
      indexToX,
      priceToY
    } = geo;

    // Background
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    if (!this.candles.length) {
      ctx.fillStyle = palette.muted;
      ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('正在加载实时 K 线行情...', width / 2, height / 2);
      ctx.textAlign = 'left';
      return;
    }

    // Horizontal price grid + right scale labels
    const priceTicks = this._computeNiceTicks(geo.minPrice, geo.maxPrice, Math.max(5, Math.floor(mainHeight / 42)));
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    for (const val of priceTicks) {
      const y = Math.round(priceToY(val)) + 0.5;
      if (y < 14 || y > mainHeight - 10) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();

      ctx.fillStyle = palette.muted;
      ctx.fillText(formatPrice(val, this.precision), plotWidth + 8, y);
    }

    // Vertical time grid + bottom time axis labels
    const minLabelPx = 88;
    const stepBars = Math.max(1, Math.ceil(minLabelPx / Math.max(1, this.barSpacing)));
    const firstTickIdx = Math.ceil(visibleStart / stepBars) * stepBars;

    for (let i = firstTickIdx; i <= visibleEnd; i += stepBars) {
      const c = this.candles[i];
      if (!c) continue;
      const x = Math.round(indexToX(i)) + 0.5;
      if (x < 24 || x > plotWidth - 20) continue;

      ctx.strokeStyle = palette.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, timeAxisTop);
      ctx.stroke();

      const lbl = formatTimeLabel(c.time, this.interval, false);
      ctx.fillStyle = palette.muted;
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, x - tw / 2, timeAxisTop + 14);
    }

    // Clip to Main Chart Area
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotWidth, mainHeight);
    ctx.clip();

    // Volume histogram at bottom of main pane
    if (this.showVolume) {
      let maxVol = 0;
      for (let i = visibleStart; i <= visibleEnd; i++) {
        if (this.candles[i]?.volume > maxVol) maxVol = this.candles[i].volume;
      }
      if (maxVol > 0) {
        const volMaxH = mainHeight * 0.2;
        const barW = Math.max(1.5, Math.min(this.barSpacing * 0.72, 14));
        for (let i = visibleStart; i <= visibleEnd; i++) {
          const c = this.candles[i];
          if (!c) continue;
          const x = indexToX(i);
          const h = (c.volume / maxVol) * volMaxH;
          ctx.fillStyle = c.close >= c.open ? palette.volBull : palette.volBear;
          ctx.fillRect(x - barW / 2, mainHeight - h, barW, h);
        }
      }
    }

    // Bollinger Bands overlay
    if (this.showBoll && this.indicators?.boll) {
      const { upper, mid, lower } = this.indicators.boll;
      ctx.beginPath();
      let started = false;
      for (let i = visibleStart; i <= visibleEnd; i++) {
        if (upper[i] === null) continue;
        const x = indexToX(i);
        const y = priceToY(upper[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      for (let i = visibleEnd; i >= visibleStart; i--) {
        if (lower[i] === null) continue;
        ctx.lineTo(indexToX(i), priceToY(lower[i]));
      }
      ctx.closePath();
      ctx.fillStyle = palette.bollFill;
      ctx.fill();

      const drawBand = (arr, dashed = false) => {
        ctx.save();
        ctx.strokeStyle = palette.bollLine;
        ctx.lineWidth = 1.1;
        if (dashed) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        let s = false;
        for (let i = visibleStart; i <= visibleEnd; i++) {
          if (arr[i] === null) continue;
          const x = indexToX(i);
          const y = priceToY(arr[i]);
          if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      };
      drawBand(upper);
      drawBand(mid, true);
      drawBand(lower);
    }

    // Dynamic user-selected EMA lines (e.g. 5 / 10 / 20 / 30 / 50 / 60 / 120 / 200 + custom)
    if (this.showEMA && this.indicators?.emaMap && this.emaPeriods.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotWidth, mainHeight);
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const drawStart = Math.max(0, visibleStart - 1);
      const drawEnd = Math.min(this.candles.length - 1, visibleEnd + 1);
      const drawLineSeries = (arr, color) => {
        if (!Array.isArray(arr)) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.55;
        ctx.beginPath();
        let started = false;
        for (let i = drawStart; i <= drawEnd; i++) {
          const v = arr[i];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          const x = indexToX(i);
          const y = priceToY(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (started) ctx.stroke();
      };
      for (const p of this.emaPeriods) {
        drawLineSeries(this.indicators.emaMap[p], getEmaColor(p));
      }
      ctx.restore();
    }

    // LuxAlgo Auto Support & Resistance stepped shelves (just like TradingView screenshot!)
    if (this.showLuxSR && this.indicators?.luxSR) {
      const { segments, wicks } = this.indicators.luxSR;
      for (const seg of segments) {
        if (seg.endIndex < visibleStart || seg.startIndex > visibleEnd) continue;
        const x1 = Math.max(0, indexToX(seg.startIndex));
        const x2 = Math.min(plotWidth, indexToX(seg.endIndex));
        const y = Math.round(priceToY(seg.price)) + 0.5;
        ctx.strokeStyle = seg.type === 'resistance' ? palette.resistance : palette.support;
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }
      // Draw LuxAlgo wicks only if AI annotations aren't already showing signals
      if (!opts.drawAI || !this.aiAnnotations?.signals?.length) {
        for (const w of wicks) {
          if (w.index < visibleStart || w.index > visibleEnd) continue;
          const x = indexToX(w.index);
          const y = priceToY(w.price);
          const isBear = w.kind === 'bear_wick';
          const bg = isBear ? '#f23645' : '#089981';
          ctx.font = '600 9.5px -apple-system, BlinkMacSystemFont, sans-serif';
          const tw = ctx.measureText(w.label).width;
          const bw = tw + 10;
          const bh = 16;
          const bx = Math.max(4, Math.min(plotWidth - bw - 4, x - bw / 2));
          const by = isBear ? Math.max(6, y - bh - 6) : Math.min(mainHeight - bh - 18, y + 6);
          drawRoundRect(ctx, bx, by, bw, bh, 3);
          ctx.fillStyle = bg;
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(w.label, bx + 5, by + bh / 2 + 0.5);
        }
      }
    }

    // Candlesticks
    const candleW = Math.max(1.5, Math.min(this.barSpacing * 0.72, 16));
    for (let i = visibleStart; i <= visibleEnd; i++) {
      const c = this.candles[i];
      if (!c) continue;
      const x = indexToX(i);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const isUp = c.close >= c.open;
      const color = isUp ? palette.bull : palette.bear;

      // Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.min(1.5, candleW * 0.22));
      const wickX = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(wickX, yHigh);
      ctx.lineTo(wickX, yLow);
      ctx.stroke();

      // Body
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.2, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    }

    // Corporate Events (E / D pills along bottom of main pane, matching screenshot!)
    if (this.events.length) {
      for (const ev of this.events) {
        // Find nearest candle index
        let nearestIdx = -1;
        let minDiff = Infinity;
        for (let i = visibleStart; i <= visibleEnd; i++) {
          const diff = Math.abs(this.candles[i].time - ev.time);
          if (diff < minDiff) {
            minDiff = diff;
            nearestIdx = i;
          }
        }
        if (nearestIdx < 0 || minDiff > 86400 * 14) continue;
        const x = indexToX(nearestIdx);
        const y = mainHeight - 13;
        ctx.save();
        ctx.fillStyle = palette.eventBg;
        ctx.strokeStyle = ev.type === 'D' ? '#2962ff' : palette.eventBorder;
        ctx.lineWidth = 1.2;
        if (ev.type === 'D') {
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#2962ff';
        } else {
          drawRoundRect(ctx, x - 7.5, y - 7.5, 15, 15, 3);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = palette.eventText;
        }
        ctx.font = '600 9.5px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ev.type, x, y + 0.5);
        ctx.textAlign = 'left';
        ctx.restore();
      }
    }

    // Current Live Price Dotted Horizontal Line
    const lastCandle = this.candles[this.candles.length - 1];
    const lastY = priceToY(lastCandle.close);
    const lastColor = lastCandle.close >= lastCandle.open ? palette.bull : palette.bear;
    if (lastY >= 0 && lastY <= mainHeight) {
      ctx.save();
      ctx.strokeStyle = lastColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(lastY) + 0.5);
      ctx.lineTo(plotWidth, Math.round(lastY) + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    // Manual User Drawings
    this._drawManualDrawings(ctx, geo);

    ctx.restore(); // End main pane clip

    // AI Annotations Layer (draws inside plot + right price axis pills)
    if (opts.drawAI && this.aiAnnotations) {
      drawAnnotationsLayer(ctx, geo, this.aiAnnotations, {
        layers: this.aiLayerFlags,
        highlightPrice: this.highlightPrice
      });
    }

    // Right Price Axis Current Price Tag (drawn on top so live price is always readable)
    if (lastY >= 8 && lastY <= mainHeight - 8) {
      ctx.fillStyle = lastColor;
      drawRoundRect(ctx, plotWidth + 1, lastY - 9.5, this.priceAxisWidth - 4, 19, 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPrice(lastCandle.close, this.precision), plotWidth + 6, lastY + 0.5);
    }

    // MACD Sub-Pane
    if (this.showMACD && macdHeight > 0 && this.indicators?.macd) {
      this._drawMACDPane(ctx, geo, palette);
    }

    // Structural Hairline Borders
    ctx.strokeStyle = palette.paneBorder;
    ctx.lineWidth = 1;
    // Vertical axis divider
    ctx.beginPath();
    ctx.moveTo(plotWidth + 0.5, 0);
    ctx.lineTo(plotWidth + 0.5, height);
    ctx.stroke();
    // Bottom time axis divider
    ctx.beginPath();
    ctx.moveTo(0, timeAxisTop + 0.5);
    ctx.lineTo(width, timeAxisTop + 0.5);
    ctx.stroke();
    // Main / MACD divider
    if (this.showMACD) {
      ctx.beginPath();
      ctx.moveTo(0, macdTop + 0.5);
      ctx.lineTo(width, macdTop + 0.5);
      ctx.stroke();
    }

    // Crosshair Overlay
    if (opts.drawCrosshair && this.mouse.inside && this.mouse.x >= 0 && this.mouse.x <= plotWidth && this.mouse.y >= 0 && this.mouse.y <= timeAxisTop) {
      this._drawCrosshair(ctx, geo, palette);
    }
  }

  _drawMACDPane(ctx, geo, palette) {
    const { plotWidth, macdTop, macdHeight, visibleStart, visibleEnd, indexToX } = geo;
    const { macd, signal, hist } = this.indicators.macd;

    let maxAbs = 0.0001;
    for (let i = visibleStart; i <= visibleEnd; i++) {
      if (macd[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(macd[i]));
      if (signal[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(signal[i]));
      if (hist[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(hist[i]));
    }
    const padY = 18;
    const usableH = Math.max(20, macdHeight - padY - 12);
    const valToY = (v) => macdTop + padY + ((maxAbs * 1.12 - v) / (maxAbs * 2.24)) * usableH;
    const zeroY = valToY(0);

    // Right scale ticks for MACD
    const ticks = [maxAbs * 0.85, 0, -maxAbs * 0.85];
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const v of ticks) {
      const y = Math.round(valToY(v)) + 0.5;
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = palette.muted;
      ctx.fillText(v.toFixed(2), plotWidth + 8, y);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, macdTop, plotWidth, macdHeight);
    ctx.clip();

    // 4-color Histogram
    const barW = Math.max(1.5, Math.min(this.barSpacing * 0.65, 12));
    for (let i = visibleStart; i <= visibleEnd; i++) {
      const h = hist[i];
      if (h === null) continue;
      const prev = i > 0 ? hist[i - 1] : 0;
      const x = indexToX(i);
      const y = valToY(h);
      if (h >= 0) {
        ctx.fillStyle = h >= (prev ?? 0) ? palette.histUpStrong : palette.histUpWeak;
      } else {
        ctx.fillStyle = h <= (prev ?? 0) ? palette.histDownStrong : palette.histDownWeak;
      }
      ctx.fillRect(x - barW / 2, Math.min(zeroY, y), barW, Math.max(1, Math.abs(y - zeroY)));
    }

    // MACD & Signal Lines
    const drawCurve = (arr, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      let started = false;
      for (let i = visibleStart; i <= visibleEnd; i++) {
        if (arr[i] === null) continue;
        const x = indexToX(i);
        const y = valToY(arr[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawCurve(macd, palette.macdLine);
    drawCurve(signal, palette.signalLine);

    // MACD Header Readout inside pane
    const hoverIdx = this._getHoverIndex(geo);
    const idx = hoverIdx >= 0 ? hoverIdx : this.candles.length - 1;
    const hVal = hist[idx];
    const mVal = macd[idx];
    const sVal = signal[idx];
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = palette.muted;
    ctx.fillText('MACD 10 21 9', 10, macdTop + 12);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = (hVal ?? 0) >= 0 ? palette.bull : palette.bear;
    ctx.fillText(hVal !== null ? hVal.toFixed(2) : '—', 94, macdTop + 12);
    ctx.fillStyle = palette.macdLine;
    ctx.fillText(mVal !== null ? mVal.toFixed(2) : '—', 142, macdTop + 12);
    ctx.fillStyle = palette.signalLine;
    ctx.fillText(sVal !== null ? sVal.toFixed(2) : '—', 190, macdTop + 12);

    ctx.restore();
  }

  _drawManualDrawings(ctx, geo) {
    const list = this.pendingDrawing ? [...this.manualDrawings, this.pendingDrawing] : this.manualDrawings;
    if (!list.length) return;

    const { plotWidth, indexToX, priceToY, precision } = geo;
    for (const d of list) {
      ctx.save();
      if (d.type === 'hline') {
        const y = priceToY(d.price);
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.fillStyle = '#ff9800';
        ctx.font = '600 10.5px ui-monospace, monospace';
        ctx.fillText(`手动水平线 ${formatPrice(d.price, precision)}`, 10, y - 6);
      } else if (d.type === 'trendline') {
        const x1 = indexToX(d.startIndex);
        const y1 = priceToY(d.startPrice);
        const x2 = indexToX(d.endIndex);
        const y2 = priceToY(d.endPrice);
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        for (const [ax, ay] of [[x1, y1], [x2, y2]]) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (d.type === 'box' || d.type === 'measure') {
        const x1 = indexToX(d.startIndex);
        const y1 = priceToY(d.startPrice);
        const x2 = indexToX(d.endIndex);
        const y2 = priceToY(d.endPrice);
        const isUp = d.endPrice >= d.startPrice;
        const color = d.type === 'measure' ? (isUp ? '#089981' : '#f23645') : '#2962ff';
        ctx.fillStyle = d.type === 'measure'
          ? (isUp ? 'rgba(8, 153, 129, 0.14)' : 'rgba(242, 54, 69, 0.14)')
          : 'rgba(41, 98, 255, 0.12)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

        if (d.type === 'measure') {
          const delta = d.endPrice - d.startPrice;
          const pct = d.startPrice ? (delta / d.startPrice) * 100 : 0;
          const bars = Math.abs(Math.round(d.endIndex - d.startIndex));
          const info = `${delta >= 0 ? '+' : ''}${formatPrice(delta, precision)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars}根K线`;
          ctx.font = '600 11px -apple-system, sans-serif';
          const tw = ctx.measureText(info).width;
          const bx = (x1 + x2) / 2 - (tw + 14) / 2;
          const by = Math.min(y1, y2) - 24;
          drawRoundRect(ctx, bx, by, tw + 14, 20, 4);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(info, bx + 7, by + 10);
        }
      }
      ctx.restore();
    }
  }

  _getHoverIndex(geo) {
    if (!this.mouse.inside || this.mouse.x > geo.plotWidth) return -1;
    const idx = Math.round(geo.xToIndex(this.mouse.x));
    if (idx < 0 || idx >= this.candles.length) return -1;
    return idx;
  }

  _drawCrosshair(ctx, geo, palette) {
    const { plotWidth, mainHeight, timeAxisTop, indexToX, yToPrice } = geo;
    const hoverIdx = this._getHoverIndex(geo);
    const snapX = hoverIdx >= 0 ? Math.round(indexToX(hoverIdx)) + 0.5 : Math.round(this.mouse.x) + 0.5;
    const cy = Math.round(this.mouse.y) + 0.5;

    ctx.save();
    ctx.strokeStyle = palette.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(snapX, 0);
    ctx.lineTo(snapX, timeAxisTop);
    ctx.stroke();
    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(plotWidth, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Price pill on right axis (if in main pane)
    if (cy <= mainHeight) {
      const price = yToPrice(cy);
      ctx.fillStyle = palette.crosshairBg;
      drawRoundRect(ctx, plotWidth + 1, cy - 9.5, this.priceAxisWidth - 4, 19, 2);
      ctx.fill();
      ctx.fillStyle = palette.crosshairText;
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatPrice(price, this.precision), plotWidth + 6, cy + 0.5);
    }

    // Date pill on time axis
    if (hoverIdx >= 0 && this.candles[hoverIdx]) {
      const lbl = formatTimeLabel(this.candles[hoverIdx].time, this.interval, true);
      ctx.font = '600 10.5px -apple-system, sans-serif';
      const tw = ctx.measureText(lbl).width;
      const bw = tw + 14;
      const bx = Math.max(4, Math.min(plotWidth - bw - 4, snapX - bw / 2));
      ctx.fillStyle = palette.crosshairBg;
      drawRoundRect(ctx, bx, timeAxisTop + 4, bw, 20, 3);
      ctx.fill();
      ctx.fillStyle = palette.crosshairText;
      ctx.textBaseline = 'middle';
      ctx.fillText(lbl, bx + 7, timeAxisTop + 14.5);
    }
    ctx.restore();
  }

  _bindEvents() {
    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.canvas.addEventListener('mousemove', (e) => {
      const pos = getPos(e);
      this.mouse = { x: pos.x, y: pos.y, inside: true };
      const geo = this.getGeometry();

      // Update cursor near splitter or price axis
      if (!this.dragMode) {
        if (this.showMACD && Math.abs(pos.y - geo.macdTop) < 5 && pos.x < geo.plotWidth) {
          this.canvas.style.cursor = 'ns-resize';
        } else if (pos.x > geo.plotWidth && pos.y < geo.mainHeight) {
          this.canvas.style.cursor = 'ns-resize';
        } else if (this.activeTool === 'crosshair') {
          this.canvas.style.cursor = 'crosshair';
        } else {
          this.canvas.style.cursor = 'cell';
        }
      }

      if (this.dragMode === 'pan' && this.dragStart) {
        const dx = pos.x - this.dragStart.x;
        const deltaBars = dx / this.barSpacing;
        this.scrollOffset = Math.max(
          -this.rightOffset + 2,
          Math.min(Math.max(0, this.candles.length - 12), this.dragStart.scrollOffset + deltaBars)
        );
      } else if (this.dragMode === 'yscale' && this.dragStart) {
        const dy = pos.y - this.dragStart.y;
        this.yScaleFactor = Math.max(0.35, Math.min(3.5, this.dragStart.yScaleFactor * Math.exp(-dy * 0.005)));
      } else if (this.dragMode === 'splitter') {
        const totalH = this.height - this.timeAxisHeight;
        this.macdRatio = Math.max(0.14, Math.min(0.45, 1 - pos.y / totalH));
      } else if (this.pendingDrawing && pos.x <= geo.plotWidth && pos.y <= geo.mainHeight) {
        this.pendingDrawing.endIndex = geo.xToIndex(pos.x);
        this.pendingDrawing.endPrice = geo.yToPrice(pos.y);
      }

      const hoverIdx = this._getHoverIndex(geo);
      if (hoverIdx >= 0) {
        const c = this.candles[hoverIdx];
        const prev = this.candles[hoverIdx - 1] || c;
        this.onHoverChange({ candle: c, prevClose: prev.close, index: hoverIdx });
      } else if (this.candles.length) {
        const last = this.candles[this.candles.length - 1];
        const prev = this.candles[this.candles.length - 2] || last;
        this.onHoverChange({ candle: last, prevClose: prev.close, index: this.candles.length - 1 });
      }

      this.render();
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouse.inside = false;
      if (this.dragMode !== 'drawing') this.dragMode = null;
      if (this.candles.length) {
        const last = this.candles[this.candles.length - 1];
        const prev = this.candles[this.candles.length - 2] || last;
        this.onHoverChange({ candle: last, prevClose: prev.close, index: this.candles.length - 1 });
      }
      this.render();
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const pos = getPos(e);
      const geo = this.getGeometry();

      if (this.showMACD && Math.abs(pos.y - geo.macdTop) < 5 && pos.x < geo.plotWidth) {
        this.dragMode = 'splitter';
        return;
      }

      if (pos.x > geo.plotWidth && pos.y < geo.mainHeight) {
        this.dragMode = 'yscale';
        this.dragStart = { y: pos.y, yScaleFactor: this.yScaleFactor };
        return;
      }

      // Manual drawing tools
      if (this.activeTool !== 'crosshair' && pos.x <= geo.plotWidth && pos.y <= geo.mainHeight) {
        const idx = geo.xToIndex(pos.x);
        const price = geo.yToPrice(pos.y);

        if (this.activeTool === 'hline') {
          this.manualDrawings.push({ type: 'hline', price });
          this.onDrawingsChange(this.manualDrawings);
          this.setTool('crosshair');
          return;
        }

        if (!this.pendingDrawing) {
          this.pendingDrawing = {
            type: this.activeTool,
            startIndex: idx,
            startPrice: price,
            endIndex: idx,
            endPrice: price
          };
          this.render();
        } else {
          this.pendingDrawing.endIndex = idx;
          this.pendingDrawing.endPrice = price;
          this.manualDrawings.push({ ...this.pendingDrawing });
          this.pendingDrawing = null;
          this.onDrawingsChange(this.manualDrawings);
          this.setTool('crosshair');
        }
        return;
      }

      // Default: pan chart
      this.dragMode = 'pan';
      this.dragStart = { x: pos.x, scrollOffset: this.scrollOffset };
      this.canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mouseup', () => {
      if (this.dragMode) {
        this.dragMode = null;
        this.dragStart = null;
        this.canvas.style.cursor = this.activeTool === 'crosshair' ? 'crosshair' : 'cell';
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const pos = getPos(e);
      const geo = this.getGeometry();
      if (pos.x > geo.plotWidth) {
        this.yScaleFactor = 1.0;
      } else {
        this.fitDefaultZoom();
      }
      this.render();
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const pos = getPos(e);
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        this.zoomBy(factor, pos.x);
      },
      { passive: false }
    );
  }
}
