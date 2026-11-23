/**
 * Native TradingView Lightweight Charts™ v5.2.1 Series Primitive for AI Annotations (M3).
 *
 * Responsibilities:
 * 1. Centralized palette, typography, and aesthetic cap configuration (ANNOTATION_STYLE_CONFIG).
 * 2. Deterministic candidate-to-annotation builder sourced exclusively from patternEngine outputs
 *    (sorted by score descending; zero dependency on legacy clusterLevels / analyzeTrendlinesAndPatterns).
 * 3. Native ISeriesPrimitive renderer using useBitmapCoordinateSpace with device-pixel snapping,
 *    logical-coordinate ray extension clipped strictly inside the plot rect, semi-transparent zones,
 *    and right-axis price label collision avoidance.
 */

import { formatPrice } from './indicators.js';

export const ANNOTATION_STYLE_CONFIG = {
  limits: {
    maxSupports: 2,
    maxResistances: 2,
    maxTrendlines: 1,
    maxPatterns: 1,
    maxSignals: 2,
    maxRayExtendBars: 12
  },
  geometry: {
    lineWidthCss: 1.5,
    strongLineWidthCss: 2,
    anchorDotRadiusCss: 3,
    minLabelGapCss: 20,
    labelHeightCss: 17,
    labelPaddingXCss: 6,
    labelRightMarginCss: 4,
    plotVerticalPadCss: 14
  },
  palette: {
    light: {
      // Distinct from candles (#089981/#f23645), volume, and default EMAs (#f59e0b/#06b6d4/#2962ff)
      supportLine: '#047857',
      supportZoneFill: 'rgba(4, 120, 87, 0.10)',
      supportLabelBg: '#047857',
      supportLabelText: '#ffffff',
      resistanceLine: '#be123c',
      resistanceZoneFill: 'rgba(190, 18, 60, 0.10)',
      resistanceLabelBg: '#be123c',
      resistanceLabelText: '#ffffff',
      trendlineLine: '#6d28d9',
      trendlineRay: 'rgba(109, 40, 217, 0.72)',
      trendlineLabelBg: '#6d28d9',
      trendlineLabelText: '#ffffff',
      patternLine: '#3730a3',
      patternFill: 'rgba(55, 48, 163, 0.09)',
      patternLabelBg: '#3730a3',
      patternLabelText: '#ffffff',
      signalBull: '#0f766e',
      signalBear: '#9f1239',
      anchorStroke: '#ffffff',
      leaderLine: 'rgba(71, 85, 105, 0.55)'
    },
    dark: {
      supportLine: '#34d399',
      supportZoneFill: 'rgba(52, 211, 153, 0.13)',
      supportLabelBg: '#065f46',
      supportLabelText: '#ecfdf5',
      resistanceLine: '#fb7185',
      resistanceZoneFill: 'rgba(251, 113, 133, 0.13)',
      resistanceLabelBg: '#9f1239',
      resistanceLabelText: '#fff1f2',
      trendlineLine: '#a78bfa',
      trendlineRay: 'rgba(167, 139, 250, 0.78)',
      trendlineLabelBg: '#5b21b6',
      trendlineLabelText: '#f5f3ff',
      patternLine: '#818cf8',
      patternFill: 'rgba(129, 140, 248, 0.12)',
      patternLabelBg: '#312e81',
      patternLabelText: '#eef2ff',
      signalBull: '#2dd4bf',
      signalBear: '#fda4af',
      anchorStroke: '#131722',
      leaderLine: 'rgba(148, 163, 184, 0.55)'
    }
  }
};

const PATTERN_LABELS = {
  double_bottom: { zh: '双底 W底', en: 'Double Bottom' },
  double_top: { zh: '双顶 M头', en: 'Double Top' },
  head_and_shoulders_top: { zh: '头肩顶', en: 'H&S Top' },
  head_and_shoulders_bottom: { zh: '头肩底', en: 'Inv H&S' },
  ascending_triangle: { zh: '上升三角形', en: 'Asc Triangle' },
  descending_triangle: { zh: '下降三角形', en: 'Desc Triangle' },
  symmetrical_triangle: { zh: '对称三角形', en: 'Sym Triangle' },
  box_range: { zh: '震荡箱体', en: 'Box Range' }
};

/**
 * Snap a CSS/media coordinate onto the device pixel grid so 1-2px lines remain razor-sharp
 * while keeping coordinate error strictly <= 0.5 CSS px (<= 0.25 CSS px at DPR 2).
 */
export function snapBitmapCoord(mediaCoord, pixelRatio, bitmapLineWidth) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const raw = mediaCoord * ratio;
  return bitmapLineWidth % 2 === 1 ? Math.floor(raw) + 0.5 : Math.round(raw);
}

/**
 * Exact Liang-Barsky parametric clipping of segment (x1, y1)-(x2, y2) to rectangle [minX, maxX] x [minY, maxY].
 * Returns null when the segment lies completely outside the rectangle.
 */
export function clipSegmentToRect(x1, y1, x2, y2, minX, minY, maxX, maxY) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  return {
    x1: x1 + t0 * dx,
    y1: y1 + t0 * dy,
    x2: x1 + t1 * dx,
    y2: y1 + t1 * dy
  };
}

/**
 * Deterministic two-pass collision avoidance for right-axis price labels.
 * Enforces a minimum vertical spacing `minGap` while keeping every label within [minY, maxY].
 */
export function resolveNonOverlappingLabels(items, { minGap = 20, minY = 12, maxY = 400 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const sorted = items
    .map((item) => ({
      ...item,
      y: Math.max(minY, Math.min(maxY, item.targetY))
    }))
    .sort((a, b) => a.targetY - b.targetY || String(a.id || '').localeCompare(String(b.id || '')));

  // Pass 1: push downward to enforce minimum gap
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y < sorted[i - 1].y + minGap) {
      sorted[i].y = sorted[i - 1].y + minGap;
    }
  }

  // Pass 2: if bottom overflows maxY, pull upward while preserving minimum gap
  const lastIdx = sorted.length - 1;
  if (sorted[lastIdx].y > maxY) {
    sorted[lastIdx].y = maxY;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (sorted[i].y > sorted[i + 1].y - minGap) {
        sorted[i].y = sorted[i + 1].y - minGap;
      }
    }
  }

  // Final bounds clamp
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].y = Math.max(minY, Math.min(maxY, sorted[i].y));
  }

  return sorted;
}

/**
 * Build M3 chart annotations strictly from deterministic patternEngine candidates,
 * ordered by score descending and bounded by ANNOTATION_STYLE_CONFIG.limits.
 */
export function buildAnnotationsFromPatternEngine(engineResult, options = {}) {
  if (!engineResult || typeof engineResult !== 'object') {
    return {
      source: 'patternEngine',
      horizontalLevels: [],
      trendlines: [],
      patterns: [],
      signals: [],
      tradePlan: null
    };
  }

  const limits = {
    ...ANNOTATION_STYLE_CONFIG.limits,
    ...(options.limits || {})
  };
  const indexOffset = Number.isFinite(options.indexOffset) ? Math.round(options.indexOffset) : 0;
  const globalCandles = Array.isArray(options.candles) ? options.candles : (engineResult.candles || []);
  const precision = Number.isFinite(options.precision) ? options.precision : 2;
  const currencyPrefix = options.currencyPrefix ?? '₹';
  const isEn = String(options.lang || 'zh-CN').toLowerCase().startsWith('en');
  const visibleStart = Number.isFinite(options.visibleStart) ? options.visibleStart : null;
  const visibleEnd = Number.isFinite(options.visibleEnd) ? options.visibleEnd : null;
  const selectedIds = Array.isArray(options.selectedIds) && options.selectedIds.length
    ? new Set(options.selectedIds)
    : null;

  const mapAnchor = (anchor) => {
    if (!anchor || !Number.isFinite(anchor.index)) return null;
    const globalIndex = anchor.index + indexOffset;
    const candle = globalCandles[globalIndex];
    return {
      ...anchor,
      index: globalIndex,
      time: candle ? candle.time : anchor.time,
      price: Number(anchor.price)
    };
  };

  const overlapsVisible = (startIdx, endIdx) => {
    if (visibleStart === null || visibleEnd === null) return true;
    const gStart = startIdx + indexOffset;
    const gEnd = endIdx + indexOffset;
    return gEnd >= visibleStart && gStart <= visibleEnd;
  };

  const filterSelected = (list) => {
    if (!Array.isArray(list)) return [];
    return selectedIds ? list.filter((c) => selectedIds.has(c.id)) : list;
  };

  // 1) Horizontal Supports (<= maxSupports) & Resistances (<= maxResistances), ordered by score desc
  const rawSupports = filterSelected(engineResult.supportResistance?.supports || []);
  const rawResistances = filterSelected(engineResult.supportResistance?.resistances || []);
  const topSupports = rawSupports.slice(0, limits.maxSupports);
  const topResistances = rawResistances.slice(0, limits.maxResistances);

  const horizontalLevels = [];
  topResistances.forEach((r, idx) => {
    const anchors = (r.anchors || []).map(mapAnchor).filter(Boolean);
    const primaryAnchor = mapAnchor(r.priceAnchor || r.endAnchor || anchors[anchors.length - 1]);
    const priceStr = `${currencyPrefix}${formatPrice(r.price, precision)}`;
    horizontalLevels.push({
      id: r.id,
      type: 'resistance',
      role: 'resistance',
      price: r.price,
      bandLow: r.bandLow ?? r.price,
      bandHigh: r.bandHigh ?? r.price,
      startIndex: (r.startIndex ?? 0) + indexOffset,
      endIndex: (r.endIndex ?? Math.max(0, globalCandles.length - 1 - indexOffset)) + indexOffset,
      startTime: primaryAnchor ? (globalCandles[(r.startIndex ?? 0) + indexOffset]?.time ?? r.startTime) : r.startTime,
      endTime: globalCandles[(r.endIndex ?? 0) + indexOffset]?.time ?? r.endTime,
      anchorIndex: primaryAnchor?.index ?? ((r.endIndex ?? 0) + indexOffset),
      anchorTime: primaryAnchor?.time ?? r.endTime,
      anchors,
      strength: idx === 0 ? 'strong' : 'medium',
      touches: r.touches,
      confluence: Boolean(r.confluence),
      score: r.score,
      shortTag: `R${idx + 1}`,
      label: `R${idx + 1} ${priceStr}`
    });
  });

  topSupports.forEach((s, idx) => {
    const anchors = (s.anchors || []).map(mapAnchor).filter(Boolean);
    const primaryAnchor = mapAnchor(s.priceAnchor || s.endAnchor || anchors[anchors.length - 1]);
    const priceStr = `${currencyPrefix}${formatPrice(s.price, precision)}`;
    horizontalLevels.push({
      id: s.id,
      type: 'support',
      role: 'support',
      price: s.price,
      bandLow: s.bandLow ?? s.price,
      bandHigh: s.bandHigh ?? s.price,
      startIndex: (s.startIndex ?? 0) + indexOffset,
      endIndex: (s.endIndex ?? Math.max(0, globalCandles.length - 1 - indexOffset)) + indexOffset,
      startTime: globalCandles[(s.startIndex ?? 0) + indexOffset]?.time ?? s.startTime,
      endTime: globalCandles[(s.endIndex ?? 0) + indexOffset]?.time ?? s.endTime,
      anchorIndex: primaryAnchor?.index ?? ((s.endIndex ?? 0) + indexOffset),
      anchorTime: primaryAnchor?.time ?? s.endTime,
      anchors,
      strength: idx === 0 ? 'strong' : 'medium',
      touches: s.touches,
      confluence: Boolean(s.confluence),
      score: s.score,
      shortTag: `S${idx + 1}`,
      label: `S${idx + 1} ${priceStr}`
    });
  });

  // 2) Trendlines (<= maxTrendlines = 1), preferring in-viewport candidates first when visible range is set
  const rawTrendlines = filterSelected(engineResult.trendlines || []);
  const visibleTrendlines = rawTrendlines.filter((tl) => overlapsVisible(tl.startIndex, tl.endIndex));
  const pickedTrendlines = (visibleTrendlines.length ? visibleTrendlines : rawTrendlines).slice(0, limits.maxTrendlines);

  const trendlines = pickedTrendlines.map((tl) => {
    const startAnchor = mapAnchor(tl.startAnchor || { index: tl.startIndex, time: tl.startTime, price: tl.startPrice });
    const endAnchor = mapAnchor(tl.endAnchor || { index: tl.endIndex, time: tl.endTime, price: tl.endPrice });
    const isUp = tl.role === 'support';
    return {
      id: tl.id,
      type: isUp ? 'uptrend' : 'downtrend',
      role: tl.role,
      startIndex: startAnchor.index,
      startTime: startAnchor.time,
      startPrice: startAnchor.price,
      endIndex: endAnchor.index,
      endTime: endAnchor.time,
      endPrice: endAnchor.price,
      startAnchor,
      endAnchor,
      anchors: [startAnchor, endAnchor],
      slope: tl.slope,
      touches: tl.touches,
      extendRight: true,
      extendBars: limits.maxRayExtendBars,
      score: tl.score,
      label: isUp
        ? (isEn ? 'Uptrend' : '上升趋势线')
        : (isEn ? 'Downtrend' : '下降趋势线')
    };
  });

  // 3) Patterns + Consolidation Boxes combined (<= maxPatterns = 1), ranked strictly by score descending
  const rawPatterns = filterSelected(engineResult.patterns || []).map((p) => ({
    ...p,
    _sourceKind: 'pattern'
  }));
  const rawBoxes = filterSelected(engineResult.boxRanges || []).map((b) => ({
    ...b,
    _sourceKind: 'box'
  }));
  const combinedStructures = [...rawPatterns, ...rawBoxes].sort((a, b) => {
    const diff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(diff) > 1e-9) return diff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const visibleStructures = combinedStructures.filter((st) => overlapsVisible(st.startIndex, st.endIndex));
  const pickedStructures = (visibleStructures.length ? visibleStructures : combinedStructures).slice(0, limits.maxPatterns);

  const patterns = pickedStructures.map((st) => {
    const labelMeta = PATTERN_LABELS[st.type] || { zh: st.name || st.type, en: st.type };
    const displayName = isEn ? labelMeta.en : labelMeta.zh;
    if (st._sourceKind === 'box') {
      const upperAnchor = mapAnchor(st.upperAnchor);
      const lowerAnchor = mapAnchor(st.lowerAnchor);
      const startIndex = st.startIndex + indexOffset;
      const endIndex = st.endIndex + indexOffset;
      return {
        id: st.id,
        kind: 'box',
        type: 'box_range',
        name: displayName,
        label: displayName,
        startIndex,
        endIndex,
        startTime: globalCandles[startIndex]?.time ?? st.startTime,
        endTime: globalCandles[endIndex]?.time ?? st.endTime,
        upperBound: st.upperBound,
        lowerBound: st.lowerBound,
        upperAnchor,
        lowerAnchor,
        anchors: [upperAnchor, lowerAnchor].filter(Boolean),
        points: [upperAnchor, lowerAnchor].filter(Boolean),
        score: st.score
      };
    }

    const mappedPoints = (st.points || []).map(mapAnchor).filter(Boolean);
    const isTriangle = st.type && st.type.includes('triangle');
    return {
      id: st.id,
      kind: isTriangle ? 'triangle' : 'polyline',
      type: st.type,
      name: displayName,
      label: displayName,
      bias: st.bias || 'neutral',
      startIndex: st.startIndex + indexOffset,
      endIndex: st.endIndex + indexOffset,
      startTime: globalCandles[st.startIndex + indexOffset]?.time ?? st.startTime,
      endTime: globalCandles[st.endIndex + indexOffset]?.time ?? st.endTime,
      necklinePrice: st.necklinePrice ?? null,
      targetPrice: st.targetPrice ?? null,
      points: mappedPoints,
      anchors: mappedPoints,
      score: st.score
    };
  });

  // 4) Divergence Signal Markers (<= maxSignals = 2)
  const rawDivergences = filterSelected(engineResult.divergences || []);
  const visibleDivs = rawDivergences.filter((d) => overlapsVisible(d.startIndex, d.endIndex));
  const pickedDivs = (visibleDivs.length ? visibleDivs : rawDivergences).slice(0, limits.maxSignals);

  const signals = pickedDivs.map((d) => {
    const startAnchor = mapAnchor(d.startAnchor);
    const endAnchor = mapAnchor(d.endAnchor);
    const isBull = d.bias === 'bullish';
    return {
      id: d.id,
      type: d.type,
      kind: isBull ? 'bull_div' : 'bear_div',
      bias: d.bias,
      index: endAnchor.index,
      time: endAnchor.time,
      price: endAnchor.price,
      startAnchor,
      endAnchor,
      anchors: [startAnchor, endAnchor],
      score: d.score,
      label: isBull ? (isEn ? 'Bull Div' : '底背离') : (isEn ? 'Bear Div' : '顶背离')
    };
  });

  return {
    source: 'patternEngine',
    horizontalLevels,
    trendlines,
    patterns,
    signals,
    tradePlan: null
  };
}

function drawRoundedRectBitmap(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

/**
 * Native Lightweight Charts v5.2.1 Series Primitive renderer for AI annotations.
 */
export class AIAnnotationSeriesPrimitive {
  constructor(options = {}) {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;

    this._annotations = null;
    this._visible = true;
    this._theme = options.theme === 'dark' ? 'dark' : 'light';
    this._precision = options.precision ?? 2;
    this._layers = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true,
      ...(options.layers || {})
    };
    this._highlightPrice = null;
    this._lastLayout = null;

    this._paneView = {
      zOrder: () => 'top',
      renderer: () => ({
        draw: (target) => {
          target.useBitmapCoordinateSpace((scope) => this._drawBitmap(scope));
        }
      })
    };
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews() {
    // Coordinates are evaluated dynamically against live timeScale/series on every draw frame
    // so pan, zoom, and resize automatically stay 100% locked to data coordinates.
  }

  paneViews() {
    return [this._paneView];
  }

  setAnnotations(annotations, opts = {}) {
    this._annotations = annotations || null;
    if (opts.theme) this._theme = opts.theme === 'dark' ? 'dark' : 'light';
    if (Number.isFinite(opts.precision)) this._precision = opts.precision;
    if (opts.layers) this._layers = { ...this._layers, ...opts.layers };
    if (typeof opts.visible === 'boolean') this._visible = opts.visible;
    this._requestUpdate?.();
  }

  setVisible(visible) {
    this._visible = Boolean(visible);
    this._requestUpdate?.();
  }

  setTheme(theme) {
    this._theme = theme === 'dark' ? 'dark' : 'light';
    this._requestUpdate?.();
  }

  setLayers(layers) {
    if (layers && typeof layers === 'object') {
      this._layers = { ...this._layers, ...layers };
    }
    this._requestUpdate?.();
  }

  setPrecision(precision) {
    if (Number.isFinite(precision)) this._precision = precision;
    this._requestUpdate?.();
  }

  setHighlightPrice(price) {
    this._highlightPrice = Number.isFinite(price) ? price : null;
    this._requestUpdate?.();
  }

  clear() {
    this._annotations = null;
    this._highlightPrice = null;
    this._lastLayout = null;
    this._requestUpdate?.();
  }

  getLastRenderedLayout() {
    return this._lastLayout;
  }

  _coordX(anchor) {
    if (!this._chart || !anchor) return null;
    const ts = this._chart.timeScale();
    if (anchor.time !== undefined && anchor.time !== null && typeof ts.timeToCoordinate === 'function') {
      const x = ts.timeToCoordinate(anchor.time);
      if (x !== null && x !== undefined && Number.isFinite(Number(x))) return Number(x);
    }
    if (Number.isFinite(anchor.index) && typeof ts.logicalToCoordinate === 'function') {
      const lx = ts.logicalToCoordinate(anchor.index);
      if (lx !== null && lx !== undefined && Number.isFinite(Number(lx))) return Number(lx);
    }
    return null;
  }

  _logicalX(logicalIndex) {
    if (!this._chart || !Number.isFinite(logicalIndex)) return null;
    const ts = this._chart.timeScale();
    if (typeof ts.logicalToCoordinate !== 'function') return null;
    const x = ts.logicalToCoordinate(logicalIndex);
    return x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : null;
  }

  _coordY(price) {
    if (!this._series || !Number.isFinite(price)) return null;
    const y = this._series.priceToCoordinate(price);
    return y !== null && y !== undefined && Number.isFinite(Number(y)) ? Number(y) : null;
  }

  _drawAnchorDot(ctx, mx, my, fillColor, strokeColor, hRatio, vRatio) {
    const rCss = ANNOTATION_STYLE_CONFIG.geometry.anchorDotRadiusCss;
    const bx = mx * hRatio;
    const by = my * vRatio;
    const br = Math.max(2, rCss * Math.min(hRatio, vRatio));
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.2 * Math.min(hRatio, vRatio));
    ctx.strokeStyle = strokeColor;
    ctx.stroke();
    ctx.restore();
  }

  _drawBitmap(scope) {
    if (!this._visible || !this._annotations || !this._chart || !this._series) {
      this._lastLayout = null;
      return;
    }

    const { context: ctx, bitmapSize, mediaSize, horizontalPixelRatio: hRatio, verticalPixelRatio: vRatio } = scope;
    const plotW = mediaSize.width;
    const plotH = mediaSize.height;
    if (plotW <= 10 || plotH <= 10) return;

    const palette = ANNOTATION_STYLE_CONFIG.palette[this._theme] || ANNOTATION_STYLE_CONFIG.palette.light;
    const geomCfg = ANNOTATION_STYLE_CONFIG.geometry;
    const limits = ANNOTATION_STYLE_CONFIG.limits;
    const ann = this._annotations;

    const layout = {
      mediaSize: { width: plotW, height: plotH },
      bitmapSize: { width: bitmapSize.width, height: bitmapSize.height },
      horizontalPixelRatio: hRatio,
      verticalPixelRatio: vRatio,
      horizontalLevels: [],
      trendlines: [],
      patterns: [],
      signals: [],
      labels: []
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, bitmapSize.width, bitmapSize.height);
    ctx.clip();

    const pendingRightLabels = [];
    const pendingAnchorDots = [];

    // ----------------------------------------------------------------------
    // 1. Horizontal Support & Resistance Zones + Snapped Lines (max 2 each)
    // ----------------------------------------------------------------------
    if (this._layers.horizontalLevels !== false && Array.isArray(ann.horizontalLevels)) {
      const supports = ann.horizontalLevels.filter((l) => l.type === 'support').slice(0, limits.maxSupports);
      const resistances = ann.horizontalLevels.filter((l) => l.type === 'resistance').slice(0, limits.maxResistances);
      const levelsToDraw = [...resistances, ...supports];

      for (const lvl of levelsToDraw) {
        const my = this._coordY(lvl.price);
        if (my === null || my < 4 || my > plotH - 4) continue;

        const isRes = lvl.type === 'resistance';
        const lineColor = isRes ? palette.resistanceLine : palette.supportLine;
        const zoneFill = isRes ? palette.resistanceZoneFill : palette.supportZoneFill;
        const labelBg = isRes ? palette.resistanceLabelBg : palette.supportLabelBg;
        const labelText = isRes ? palette.resistanceLabelText : palette.supportLabelText;

        const rawStartX = this._coordX({ index: lvl.startIndex, time: lvl.startTime });
        const startMediaX = rawStartX !== null ? Math.max(0, Math.min(plotW - 24, rawStartX)) : 0;

        // Semi-transparent zone band when bandHigh > bandLow
        const hasBand = Number.isFinite(lvl.bandLow) && Number.isFinite(lvl.bandHigh) && lvl.bandHigh > lvl.bandLow;
        if (hasBand) {
          const yHigh = this._coordY(lvl.bandHigh);
          const yLow = this._coordY(lvl.bandLow);
          if (yHigh !== null && yLow !== null) {
            const topB = Math.max(0, Math.round(Math.min(yHigh, yLow) * vRatio));
            const botB = Math.min(bitmapSize.height, Math.round(Math.max(yHigh, yLow) * vRatio));
            const hB = Math.max(2, botB - topB);
            ctx.fillStyle = zoneFill;
            ctx.fillRect(Math.round(startMediaX * hRatio), topB, bitmapSize.width - Math.round(startMediaX * hRatio), hB);
          }
        }

        const isHighlight = this._highlightPrice !== null && Math.abs(lvl.price - this._highlightPrice) < 1e-6;
        const lineCss = isHighlight ? 2 : (lvl.strength === 'strong' ? geomCfg.strongLineWidthCss : geomCfg.lineWidthCss);
        const bw = Math.max(1, Math.min(Math.round(2 * vRatio), Math.round(lineCss * vRatio)));
        const by = snapBitmapCoord(my, vRatio, bw);
        const bx1 = Math.round(startMediaX * hRatio);
        const bx2 = bitmapSize.width;

        ctx.save();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = bw;
        if (lvl.strength !== 'strong') {
          ctx.setLineDash([Math.round(6 * hRatio), Math.round(4 * hRatio)]);
        }
        ctx.beginPath();
        ctx.moveTo(bx1, by);
        ctx.lineTo(bx2, by);
        ctx.stroke();
        ctx.restore();

        // Queue anchor dot on top pass if primary anchor is visible inside plot
        const ax = this._coordX({ index: lvl.anchorIndex, time: lvl.anchorTime });
        if (ax !== null && ax >= 0 && ax <= plotW) {
          pendingAnchorDots.push({ mx: ax, my, fill: lineColor });
        }

        layout.horizontalLevels.push({
          id: lvl.id,
          type: lvl.type,
          price: lvl.price,
          mediaY: my,
          bitmapY: by,
          startMediaX,
          endMediaX: plotW,
          anchorMediaX: ax
        });

        pendingRightLabels.push({
          id: lvl.id,
          text: lvl.label || `${isRes ? 'R' : 'S'} ${formatPrice(lvl.price, this._precision)}`,
          targetY: my,
          bg: labelBg,
          fg: labelText,
          lineColor
        });
      }
    }

    // ----------------------------------------------------------------------
    // 2. Pattern Polylines / Triangles / Consolidation Box (max 1)
    // ----------------------------------------------------------------------
    if (this._layers.patterns !== false && Array.isArray(ann.patterns)) {
      const patternsToDraw = ann.patterns.slice(0, limits.maxPatterns);
      const bw = Math.max(1, Math.round(geomCfg.lineWidthCss * Math.min(hRatio, vRatio)));

      for (const pat of patternsToDraw) {
        if (pat.kind === 'box') {
          const x1 = this._coordX({ index: pat.startIndex, time: pat.startTime });
          const x2 = this._coordX({ index: pat.endIndex, time: pat.endTime });
          const yTop = this._coordY(pat.upperBound);
          const yBot = this._coordY(pat.lowerBound);
          if (x1 === null || x2 === null || yTop === null || yBot === null) continue;

          const leftM = Math.max(0, Math.min(x1, x2));
          const rightM = Math.min(plotW, Math.max(x1, x2));
          const topM = Math.max(0, Math.min(yTop, yBot));
          const botM = Math.min(plotH, Math.max(yTop, yBot));
          if (rightM - leftM < 2 || botM - topM < 2) continue;

          const bx = snapBitmapCoord(leftM, hRatio, bw);
          const by = snapBitmapCoord(topM, vRatio, bw);
          const bx2 = snapBitmapCoord(rightM, hRatio, bw);
          const by2 = snapBitmapCoord(botM, vRatio, bw);

          ctx.save();
          ctx.fillStyle = palette.patternFill;
          ctx.fillRect(bx, by, bx2 - bx, by2 - by);
          ctx.strokeStyle = palette.patternLine;
          ctx.lineWidth = bw;
          ctx.setLineDash([Math.round(5 * hRatio), Math.round(3 * hRatio)]);
          ctx.strokeRect(bx, by, bx2 - bx, by2 - by);
          ctx.restore();

          const renderedAnchors = [];
          for (const anc of pat.anchors || []) {
            const ax = this._coordX(anc);
            const ay = this._coordY(anc.price);
            if (ax !== null && ay !== null) {
              if (ax >= 0 && ax <= plotW && ay >= 0 && ay <= plotH) {
                pendingAnchorDots.push({ mx: ax, my: ay, fill: palette.patternLine });
              }
              renderedAnchors.push({ index: anc.index, price: anc.price, mediaX: ax, mediaY: ay });
            }
          }

          // Compact box caption clamped inside plot & clear of right-axis pills
          this._drawInlineTag(ctx, pat.label || pat.name, leftM + 34, Math.max(12, topM - 10), palette.patternLabelBg, palette.patternLabelText, plotW - 104, plotH, hRatio, vRatio);

          layout.patterns.push({
            id: pat.id,
            kind: 'box',
            leftMediaX: leftM,
            rightMediaX: rightM,
            topMediaY: topM,
            bottomMediaY: botM,
            anchors: renderedAnchors
          });
        } else if (Array.isArray(pat.points) && pat.points.length >= 2) {
          const pts = pat.points
            .map((p) => ({
              ...p,
              mediaX: this._coordX(p),
              mediaY: this._coordY(p.price)
            }))
            .filter((p) => p.mediaX !== null && p.mediaY !== null);
          if (pts.length < 2) continue;

          ctx.save();
          ctx.strokeStyle = palette.patternLine;
          ctx.lineWidth = bw;
          ctx.lineJoin = 'round';

          if (pat.kind === 'triangle' && pts.length === 4) {
            // [upper_start, upper_end, lower_start, lower_end]
            const [u1, u2, l1, l2] = pts;
            // Translucent wedge fill
            ctx.fillStyle = palette.patternFill;
            ctx.beginPath();
            ctx.moveTo(u1.mediaX * hRatio, u1.mediaY * vRatio);
            ctx.lineTo(u2.mediaX * hRatio, u2.mediaY * vRatio);
            ctx.lineTo(l2.mediaX * hRatio, l2.mediaY * vRatio);
            ctx.lineTo(l1.mediaX * hRatio, l1.mediaY * vRatio);
            ctx.closePath();
            ctx.fill();

            const upperClip = clipSegmentToRect(u1.mediaX, u1.mediaY, u2.mediaX, u2.mediaY, 0, 0, plotW, plotH);
            if (upperClip) {
              ctx.beginPath();
              ctx.moveTo(snapBitmapCoord(upperClip.x1, hRatio, bw), snapBitmapCoord(upperClip.y1, vRatio, bw));
              ctx.lineTo(snapBitmapCoord(upperClip.x2, hRatio, bw), snapBitmapCoord(upperClip.y2, vRatio, bw));
              ctx.stroke();
            }
            const lowerClip = clipSegmentToRect(l1.mediaX, l1.mediaY, l2.mediaX, l2.mediaY, 0, 0, plotW, plotH);
            if (lowerClip) {
              ctx.beginPath();
              ctx.moveTo(snapBitmapCoord(lowerClip.x1, hRatio, bw), snapBitmapCoord(lowerClip.y1, vRatio, bw));
              ctx.lineTo(snapBitmapCoord(lowerClip.x2, hRatio, bw), snapBitmapCoord(lowerClip.y2, vRatio, bw));
              ctx.stroke();
            }
          } else {
            // Polyline (W-bottom, M-top, H&S)
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const bx = snapBitmapCoord(pts[i].mediaX, hRatio, bw);
              const by = snapBitmapCoord(pts[i].mediaY, vRatio, bw);
              if (i === 0) ctx.moveTo(bx, by);
              else ctx.lineTo(bx, by);
            }
            ctx.stroke();
          }
          ctx.restore();

          let minY = Infinity;
          let tagX = pts[0].mediaX;
          for (const p of pts) {
            if (p.mediaY < minY) {
              minY = p.mediaY;
              tagX = p.mediaX;
            }
            if (p.mediaX >= 0 && p.mediaX <= plotW && p.mediaY >= 0 && p.mediaY <= plotH) {
              pendingAnchorDots.push({ mx: p.mediaX, my: p.mediaY, fill: palette.patternLine });
            }
          }

          if (Number.isFinite(minY)) {
            this._drawInlineTag(ctx, pat.label || pat.name, tagX, Math.max(14, minY - 14), palette.patternLabelBg, palette.patternLabelText, plotW - 104, plotH, hRatio, vRatio);
          }

          layout.patterns.push({
            id: pat.id,
            kind: pat.kind || 'polyline',
            anchors: pts.map((p) => ({ index: p.index, price: p.price, mediaX: p.mediaX, mediaY: p.mediaY }))
          });
        }
      }
    }

    // ----------------------------------------------------------------------
    // 3. Trendline with Logical-Coordinate Bounded Ray Extension (max 1)
    // ----------------------------------------------------------------------
    if (this._layers.trendlines !== false && Array.isArray(ann.trendlines)) {
      const tls = ann.trendlines.slice(0, limits.maxTrendlines);
      const bw = Math.max(1, Math.min(Math.round(2 * vRatio), Math.round(geomCfg.strongLineWidthCss * vRatio)));

      for (const tl of tls) {
        const sAnc = tl.startAnchor || { index: tl.startIndex, time: tl.startTime, price: tl.startPrice };
        const eAnc = tl.endAnchor || { index: tl.endIndex, time: tl.endTime, price: tl.endPrice };
        const x1 = this._coordX(sAnc);
        const y1 = this._coordY(sAnc.price);
        const x2 = this._coordX(eAnc);
        const y2 = this._coordY(eAnc.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

        const baseClipped = clipSegmentToRect(x1, y1, x2, y2, 0, 0, plotW, plotH);
        if (baseClipped) {
          ctx.save();
          ctx.strokeStyle = palette.trendlineLine;
          ctx.lineWidth = bw;
          ctx.beginPath();
          ctx.moveTo(snapBitmapCoord(baseClipped.x1, hRatio, bw), snapBitmapCoord(baseClipped.y1, vRatio, bw));
          ctx.lineTo(snapBitmapCoord(baseClipped.x2, hRatio, bw), snapBitmapCoord(baseClipped.y2, vRatio, bw));
          ctx.stroke();
          ctx.restore();
        }

        // Ray extension strictly via logical coordinates (never requires future timestamps)
        let rayClipped = null;
        const extendBars = Math.min(limits.maxRayExtendBars, Math.max(0, tl.extendBars ?? limits.maxRayExtendBars));
        if (tl.extendRight !== false && extendBars > 0 && eAnc.index > sAnc.index) {
          const rayLogical = eAnc.index + extendBars;
          const exactSlope = (eAnc.price - sAnc.price) / (eAnc.index - sAnc.index);
          const rayPrice = eAnc.price + exactSlope * extendBars;
          const rx = this._logicalX(rayLogical);
          const ry = this._coordY(rayPrice);
          if (rx !== null && ry !== null) {
            rayClipped = clipSegmentToRect(x2, y2, rx, ry, 0, 0, plotW, plotH);
            if (rayClipped) {
              ctx.save();
              ctx.strokeStyle = palette.trendlineRay;
              ctx.lineWidth = Math.max(1, Math.round(geomCfg.lineWidthCss * vRatio));
              ctx.setLineDash([Math.round(5 * hRatio), Math.round(4 * hRatio)]);
              ctx.beginPath();
              ctx.moveTo(snapBitmapCoord(rayClipped.x1, hRatio, bw), snapBitmapCoord(rayClipped.y1, vRatio, bw));
              ctx.lineTo(snapBitmapCoord(rayClipped.x2, hRatio, bw), snapBitmapCoord(rayClipped.y2, vRatio, bw));
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        if (x1 >= 0 && x1 <= plotW && y1 >= 0 && y1 <= plotH) {
          pendingAnchorDots.push({ mx: x1, my: y1, fill: palette.trendlineLine });
        }
        if (x2 >= 0 && x2 <= plotW && y2 >= 0 && y2 <= plotH) {
          pendingAnchorDots.push({ mx: x2, my: y2, fill: palette.trendlineLine });
        }

        // Compact trendline tag near midpoint (kept clear of right-axis pills)
        const tagRef = baseClipped || rayClipped;
        if (tagRef) {
          const midX = (tagRef.x1 + tagRef.x2) * 0.5;
          const midY = (tagRef.y1 + tagRef.y2) * 0.5 + (tl.role === 'support' ? 14 : -14);
          this._drawInlineTag(ctx, tl.label || 'Trendline', midX, midY, palette.trendlineLabelBg, palette.trendlineLabelText, plotW - 104, plotH, hRatio, vRatio);
        }

        layout.trendlines.push({
          id: tl.id,
          role: tl.role,
          startAnchor: { index: sAnc.index, price: sAnc.price, mediaX: x1, mediaY: y1 },
          endAnchor: { index: eAnc.index, price: eAnc.price, mediaX: x2, mediaY: y2 },
          clippedBase: baseClipped,
          clippedRay: rayClipped
        });
      }
    }

    // ----------------------------------------------------------------------
    // 4. Signal Markers (MACD Divergences, max 2)
    // ----------------------------------------------------------------------
    if (this._layers.signals !== false && Array.isArray(ann.signals)) {
      const sigs = ann.signals.slice(0, limits.maxSignals);
      const bw = Math.max(1, Math.round(1.25 * Math.min(hRatio, vRatio)));
      for (const sig of sigs) {
        const ax = this._coordX(sig.endAnchor || { index: sig.index, time: sig.time });
        const ay = this._coordY(sig.price);
        if (ax === null || ay === null) continue;

        const isBull = sig.bias === 'bullish' || sig.kind === 'bull_div';
        const color = isBull ? palette.signalBull : palette.signalBear;

        if (sig.startAnchor) {
          const sx = this._coordX(sig.startAnchor);
          const sy = this._coordY(sig.startAnchor.price);
          if (sx !== null && sy !== null) {
            const seg = clipSegmentToRect(sx, sy, ax, ay, 0, 0, plotW, plotH);
            if (seg) {
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = bw;
              ctx.setLineDash([Math.round(3 * hRatio), Math.round(3 * hRatio)]);
              ctx.beginPath();
              ctx.moveTo(snapBitmapCoord(seg.x1, hRatio, bw), snapBitmapCoord(seg.y1, vRatio, bw));
              ctx.lineTo(snapBitmapCoord(seg.x2, hRatio, bw), snapBitmapCoord(seg.y2, vRatio, bw));
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        if (ax >= 0 && ax <= plotW && ay >= 0 && ay <= plotH) {
          const r = 4.5 * Math.min(hRatio, vRatio);
          const bx = ax * hRatio;
          const by = ay * vRatio;
          const dir = isBull ? 1 : -1;
          ctx.save();
          ctx.fillStyle = color;
          ctx.strokeStyle = palette.anchorStroke;
          ctx.lineWidth = Math.max(1, 1.2 * Math.min(hRatio, vRatio));
          ctx.beginPath();
          ctx.moveTo(bx, by + dir * 2 * vRatio);
          ctx.lineTo(bx - r, by + dir * (2 * vRatio + r * 1.4));
          ctx.lineTo(bx + r, by + dir * (2 * vRatio + r * 1.4));
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }

        layout.signals.push({
          id: sig.id,
          index: sig.index,
          price: sig.price,
          mediaX: ax,
          mediaY: ay
        });
      }
    }

    // Top anchor-dot pass: draw all anchor dots cleanly on top of all lines so intersections never slice dots
    for (const dot of pendingAnchorDots) {
      this._drawAnchorDot(ctx, dot.mx, dot.my, dot.fill, palette.anchorStroke, hRatio, vRatio);
    }

    // ----------------------------------------------------------------------
    // 5. Right-Axis Docked Price Labels with Automatic Collision Avoidance
    // ----------------------------------------------------------------------
    if (pendingRightLabels.length > 0) {
      const resolved = resolveNonOverlappingLabels(pendingRightLabels, {
        minGap: geomCfg.minLabelGapCss,
        minY: geomCfg.plotVerticalPadCss,
        maxY: Math.max(geomCfg.plotVerticalPadCss, plotH - geomCfg.plotVerticalPadCss)
      });

      const fontPx = Math.round(10.5 * vRatio);
      ctx.save();
      ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textBaseline = 'middle';

      for (const lbl of resolved) {
        const textWidthB = ctx.measureText(lbl.text).width;
        const padXB = Math.round(geomCfg.labelPaddingXCss * hRatio);
        const pillWB = Math.round(textWidthB + padXB * 2);
        const pillHB = Math.round(geomCfg.labelHeightCss * vRatio);
        const rightMarginB = Math.round(geomCfg.labelRightMarginCss * hRatio);
        const xB = Math.max(2, bitmapSize.width - pillWB - rightMarginB);
        const yCenterB = Math.round(lbl.y * vRatio);
        const yB = Math.round(yCenterB - pillHB * 0.5);

        // Subtle leader line if label was displaced vertically to avoid collision
        if (Math.abs(lbl.y - lbl.targetY) > 1.5) {
          ctx.save();
          ctx.strokeStyle = palette.leaderLine;
          ctx.lineWidth = Math.max(1, Math.round(1 * vRatio));
          ctx.beginPath();
          ctx.moveTo(xB - Math.round(10 * hRatio), Math.round(lbl.targetY * vRatio) + 0.5);
          ctx.lineTo(xB, yCenterB + 0.5);
          ctx.stroke();
          ctx.restore();
        }

        drawRoundedRectBitmap(ctx, xB, yB, pillWB, pillHB, Math.round(3.5 * Math.min(hRatio, vRatio)));
        ctx.fillStyle = lbl.bg;
        ctx.fill();

        ctx.fillStyle = lbl.fg;
        ctx.fillText(lbl.text, xB + padXB, yCenterB + 0.5);

        layout.labels.push({
          id: lbl.id,
          text: lbl.text,
          targetY: lbl.targetY,
          y: lbl.y,
          x: xB / hRatio,
          width: pillWB / hRatio,
          height: pillHB / vRatio
        });
      }
      ctx.restore();
    }

    ctx.restore();
    this._lastLayout = layout;
  }

  _drawInlineTag(ctx, text, mediaX, mediaY, bg, fg, maxRightMediaX, plotH, hRatio, vRatio) {
    if (!text) return;
    const fontPx = Math.round(10 * vRatio);
    ctx.save();
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    const textWB = ctx.measureText(text).width;
    const padXB = Math.round(5 * hRatio);
    const pillWB = Math.round(textWB + padXB * 2);
    const pillHB = Math.round(16 * vRatio);

    const maxLeftB = Math.max(4, Math.round(maxRightMediaX * hRatio) - pillWB - 4);
    const xB = Math.max(4, Math.min(maxLeftB, Math.round(mediaX * hRatio - pillWB * 0.5)));
    const yCenterB = Math.max(pillHB * 0.5 + 4, Math.min(Math.round(plotH * vRatio) - pillHB * 0.5 - 4, Math.round(mediaY * vRatio)));
    const yB = Math.round(yCenterB - pillHB * 0.5);

    drawRoundedRectBitmap(ctx, xB, yB, pillWB, pillHB, Math.round(3 * Math.min(hRatio, vRatio)));
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, xB + padXB, yCenterB + 0.5);
    ctx.restore();
  }
}
