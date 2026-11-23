/**
 * TradingView Lightweight Charts™ v5.2.1 Rendering Engine for ChartCopilot (M1 / M1.1 / M3).
 *
 * M3 Upgrade:
 * - Completely removes the transitional #mainChartCanvas overlay and manual drawing code.
 * - Attaches a native LWC v5.2.1 ISeriesPrimitive (AIAnnotationSeriesPrimitive) onto candleSeries
 *   so all AI annotations render in data-coordinate bitmap space, automatically stay 100% locked
 *   through pan/zoom/resize, and are natively captured by lwcChart.takeScreenshot().
 */

import {
  computeAllIndicators,
  getPrecision,
  getEmaColor
} from './indicators.js';
import {
  resolveExchangeTimezone,
  formatLwcTickMark,
  formatLwcCrosshairTime,
  normalizeAndSortCandles,
  toLwcCandlestickData,
  toLwcVolumeData,
  toLwcLineData,
  toLwcBollingerData,
  toLwcMacdData,
  toLwcRealtimeUpdate
} from './lwcAdapter.js';
import { AIAnnotationSeriesPrimitive } from './lwcAnnotationPrimitive.js';

const THEMES = {
  light: {
    bg: '#ffffff',
    paneBorder: '#e0e3eb',
    grid: '#f0f3fa',
    text: '#131722',
    muted: '#787b86',
    crosshair: '#787b86',
    crosshairBg: '#131722',
    bull: '#089981',
    bear: '#f23645',
    volBull: 'rgba(8, 153, 129, 0.34)',
    volBear: 'rgba(242, 54, 69, 0.34)',
    resistance: '#ef5350',
    support: '#2962ff',
    bollLine: 'rgba(41, 98, 255, 0.58)',
    bollMid: 'rgba(41, 98, 255, 0.42)',
    macdLine: '#2962ff',
    signalLine: '#ff6d00',
    histUpStrong: '#26a69a',
    histUpWeak: '#b2dfdb',
    histDownStrong: '#ef5350',
    histDownWeak: '#ffcdd2'
  },
  dark: {
    bg: '#131722',
    paneBorder: '#2a2e39',
    grid: '#1e222d',
    text: '#d1d4dc',
    muted: '#787b86',
    crosshair: '#9598a1',
    crosshairBg: '#363a45',
    bull: '#089981',
    bear: '#f23645',
    volBull: 'rgba(8, 153, 129, 0.32)',
    volBear: 'rgba(242, 54, 69, 0.32)',
    resistance: '#f23645',
    support: '#3b82f6',
    bollLine: 'rgba(59, 130, 246, 0.62)',
    bollMid: 'rgba(59, 130, 246, 0.45)',
    macdLine: '#3b82f6',
    signalLine: '#f59e0b',
    histUpStrong: '#26a69a',
    histUpWeak: 'rgba(38, 166, 154, 0.42)',
    histDownStrong: '#ef5350',
    histDownWeak: 'rgba(239, 83, 80, 0.42)'
  }
};

export class ChartEngine {
  constructor(containerOrStage, options = {}) {
    this.onHoverChange = options.onHoverChange || (() => {});

    this.theme = 'light';
    this.lang = 'zh-CN';
    this.candles = [];
    this.events = [];
    this.instrument = { displaySymbol: 'ALKALI', name: '碱金属有限公司', exchange: 'NSE' };
    this.interval = '1d';
    this.precision = 2;
    this.indicators = null;
    this.dataMeta = null;
    this.exchangeTimezone = 'Asia/Kolkata';
    this.timezoneAbbr = 'IST';
    this.timeToIndexMap = new Map();

    this._showVolume = true;
    this._showMACD = true;
    this._showEMA = true;
    this._showBoll = false;
    this._showLuxSR = true;
    this.emaPeriods = [5, 10, 20];
    this._showAIAnnotations = true;

    this.priceAxisWidth = 78;
    this.timeAxisHeight = 28;
    this.width = 900;
    this.height = 560;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.mouse = { x: -1, y: -1, inside: false };

    this.aiAnnotations = null;
    this.aiLayerFlags = {
      horizontalLevels: true,
      trendlines: true,
      patterns: true,
      signals: true,
      tradePlan: true
    };
    this.highlightPrice = null;
    this.highlightTimer = null;

    this.lwcChart = null;
    this.candleSeries = null;
    this.annotationPrimitive = null;
    this.volumeSeries = null;
    this.emaSeriesMap = new Map();
    this.bollUpperSeries = null;
    this.bollMidSeries = null;
    this.bollLowerSeries = null;
    this.luxPriceLines = [];
    this.macdHistSeries = null;
    this.macdLineSeries = null;
    this.macdSignalSeries = null;

    this._initDOM(containerOrStage);
    this._initLwcChart();
    this.resize();
  }

  get showVolume() { return this._showVolume; }
  set showVolume(val) {
    this._showVolume = Boolean(val);
    if (this.volumeSeries) this.volumeSeries.applyOptions({ visible: this._showVolume });
  }

  get showMACD() { return this._showMACD; }
  set showMACD(val) {
    const next = Boolean(val);
    if (this._showMACD === next) return;
    this._showMACD = next;
    this._syncMacdPane();
  }

  get showEMA() { return this._showEMA; }
  set showEMA(val) {
    this._showEMA = Boolean(val);
    this._syncEmaSeries();
  }

  get showBoll() { return this._showBoll; }
  set showBoll(val) {
    this._showBoll = Boolean(val);
    this._syncBollingerSeries();
  }

  get showLuxSR() { return this._showLuxSR; }
  set showLuxSR(val) {
    this._showLuxSR = Boolean(val);
    this._syncLuxPriceLines();
  }

  get showAIAnnotations() { return this._showAIAnnotations; }
  set showAIAnnotations(val) {
    this._showAIAnnotations = Boolean(val);
    this.annotationPrimitive?.setVisible(this._showAIAnnotations);
    this._syncLuxPriceLines();
  }

  _initDOM(containerOrStage) {
    if (containerOrStage?.id === 'lwcChartContainer') {
      this.container = containerOrStage;
      this.stageEl = containerOrStage.parentElement || containerOrStage;
    } else {
      this.stageEl = containerOrStage;
      let container = this.stageEl?.querySelector?.('#lwcChartContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'lwcChartContainer';
        container.className = 'lwc-chart-container';
        container.setAttribute('aria-label', 'Lightweight Charts K线与MACD主副图容器');
        this.stageEl?.appendChild?.(container);
      }
      this.container = container;
    }
  }

  _initLwcChart() {
    const LWC = window.LightweightCharts;
    if (!LWC || typeof LWC.createChart !== 'function') {
      throw new Error('LightweightCharts v5.2.x standalone library is not loaded on window.LightweightCharts.');
    }
    this.LWC = LWC;
    const palette = THEMES[this.theme] || THEMES.light;

    const rect = this.stageEl?.getBoundingClientRect();
    this.width = Math.max(300, Math.floor(rect?.width || 900));
    this.height = Math.max(240, Math.floor(rect?.height || 560));

    this.lwcChart = LWC.createChart(this.container, {
      width: this.width,
      height: this.height,
      layout: {
        background: { type: LWC.ColorType.Solid, color: palette.bg },
        textColor: palette.text,
        fontSize: 11.5,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        attributionLogo: true,
        panes: {
          enableResize: true,
          separatorColor: palette.paneBorder,
          separatorHoverColor: 'rgba(41, 98, 255, 0.25)'
        }
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid }
      },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: {
          color: palette.crosshair,
          width: 1,
          style: LWC.LineStyle.Dashed,
          labelBackgroundColor: palette.crosshairBg
        },
        horzLine: {
          color: palette.crosshair,
          width: 1,
          style: LWC.LineStyle.Dashed,
          labelBackgroundColor: palette.crosshairBg
        }
      },
      rightPriceScale: {
        borderColor: palette.paneBorder,
        scaleMargins: { top: 0.08, bottom: 0.22 },
        entireTextOnly: true
      },
      localization: {
        timeFormatter: (time) =>
          formatLwcCrosshairTime(time, {
            interval: this.interval,
            timeZone: this.exchangeTimezone,
            tzAbbr: this.timezoneAbbr
          })
      },
      timeScale: {
        borderColor: palette.paneBorder,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8.5,
        minBarSpacing: 2,
        tickMarkFormatter: (time, tickMarkType) =>
          formatLwcTickMark(time, tickMarkType, {
            interval: this.interval,
            timeZone: this.exchangeTimezone
          })
      }
    });

    this.candleSeries = this.lwcChart.addSeries(
      LWC.CandlestickSeries,
      {
        upColor: palette.bull,
        downColor: palette.bear,
        borderUpColor: palette.bull,
        borderDownColor: palette.bear,
        wickUpColor: palette.bull,
        wickDownColor: palette.bear,
        priceLineVisible: true,
        lastValueVisible: true
      },
      0
    );

    // Attach M3 native Series Primitive directly onto candlestick series (zero overlay canvas!)
    this.annotationPrimitive = new AIAnnotationSeriesPrimitive({
      theme: this.theme,
      precision: this.precision,
      layers: this.aiLayerFlags,
      visible: this._showAIAnnotations
    });
    if (typeof this.candleSeries?.attachPrimitive === 'function') {
      this.candleSeries.attachPrimitive(this.annotationPrimitive);
    }

    this.volumeSeries = this.lwcChart.addSeries(
      LWC.HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
        visible: this._showVolume
      },
      0
    );
    this.lwcChart.priceScale('volume', 0).applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 }
    });

    this.bollUpperSeries = this.lwcChart.addSeries(
      LWC.LineSeries,
      {
        color: palette.bollLine,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: this._showBoll
      },
      0
    );
    this.bollMidSeries = this.lwcChart.addSeries(
      LWC.LineSeries,
      {
        color: palette.bollMid,
        lineWidth: 1,
        lineStyle: LWC.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: this._showBoll
      },
      0
    );
    this.bollLowerSeries = this.lwcChart.addSeries(
      LWC.LineSeries,
      {
        color: palette.bollLine,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: this._showBoll
      },
      0
    );

    this._createMacdSeriesIfNeeded();

    this.lwcChart.subscribeCrosshairMove((param) => {
      if (!param || !param.point || param.point.x < 0 || param.point.y < 0) {
        this.mouse.inside = false;
        if (this.candles.length) {
          const lastIdx = this.candles.length - 1;
          const last = this.candles[lastIdx];
          const prev = this.candles[lastIdx - 1] || last;
          this.onHoverChange({ candle: last, prevClose: prev.close, index: lastIdx });
        }
        return;
      }

      this.mouse = { x: param.point.x, y: param.point.y, inside: true };
      let idx = -1;
      if (param.time !== undefined && param.time !== null && this.timeToIndexMap.has(param.time)) {
        idx = this.timeToIndexMap.get(param.time);
      } else if (typeof param.logical === 'number' && Number.isFinite(param.logical)) {
        const rounded = Math.round(param.logical);
        if (rounded >= 0 && rounded < this.candles.length) {
          idx = rounded;
        }
      }

      if (idx >= 0 && idx < this.candles.length) {
        const c = this.candles[idx];
        const prev = this.candles[idx - 1] || c;
        this.onHoverChange({ candle: c, prevClose: prev.close, index: idx });
      }
    });
  }

  _createMacdSeriesIfNeeded() {
    if (!this._showMACD || !this.lwcChart) return;
    const LWC = this.LWC;
    const palette = THEMES[this.theme] || THEMES.light;

    if (!this.macdHistSeries) {
      this.macdHistSeries = this.lwcChart.addSeries(
        LWC.HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false, base: 0 },
        1
      );
    }
    if (!this.macdLineSeries) {
      this.macdLineSeries = this.lwcChart.addSeries(
        LWC.LineSeries,
        {
          color: palette.macdLine,
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true
        },
        1
      );
    }
    if (!this.macdSignalSeries) {
      this.macdSignalSeries = this.lwcChart.addSeries(
        LWC.LineSeries,
        {
          color: palette.signalLine,
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true
        },
        1
      );
    }

    const panes = this.lwcChart.panes();
    if (panes.length >= 2) {
      panes[0].setStretchFactor(0.74);
      panes[1].setStretchFactor(0.26);
    }
  }

  _removeMacdSeries() {
    if (!this.lwcChart) return;
    if (this.macdHistSeries) {
      try { this.lwcChart.removeSeries(this.macdHistSeries); } catch { /* ignore */ }
      this.macdHistSeries = null;
    }
    if (this.macdLineSeries) {
      try { this.lwcChart.removeSeries(this.macdLineSeries); } catch { /* ignore */ }
      this.macdLineSeries = null;
    }
    if (this.macdSignalSeries) {
      try { this.lwcChart.removeSeries(this.macdSignalSeries); } catch { /* ignore */ }
      this.macdSignalSeries = null;
    }
    const panes = this.lwcChart.panes();
    if (panes.length >= 2) {
      try { this.lwcChart.removePane(1); } catch { /* ignore */ }
    }
  }

  _syncMacdPane() {
    if (!this.lwcChart) return;
    if (!this._showMACD) {
      this._removeMacdSeries();
      return;
    }

    this._createMacdSeriesIfNeeded();
    if (this.candles.length && this.indicators?.macd) {
      const palette = THEMES[this.theme] || THEMES.light;
      const macdData = toLwcMacdData(this.candles, this.indicators.macd, palette);
      this.macdHistSeries?.setData(macdData.histogram);
      this.macdLineSeries?.setData(macdData.macdLine);
      this.macdSignalSeries?.setData(macdData.signalLine);
    }
  }

  _syncEmaSeries() {
    if (!this.lwcChart) return;
    const activeSet = new Set(this._showEMA ? this.emaPeriods : []);

    for (const [period, series] of this.emaSeriesMap.entries()) {
      if (!activeSet.has(period)) {
        try { this.lwcChart.removeSeries(series); } catch { /* ignore */ }
        this.emaSeriesMap.delete(period);
      }
    }

    if (!this._showEMA) return;

    for (const period of this.emaPeriods) {
      let series = this.emaSeriesMap.get(period);
      if (!series) {
        series = this.lwcChart.addSeries(
          this.LWC.LineSeries,
          {
            color: getEmaColor(period),
            lineWidth: period >= 60 ? 1.5 : 1.25,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          },
          0
        );
        this.emaSeriesMap.set(period, series);
      }
      if (this.candles.length && this.indicators?.emaMap?.[period]) {
        series.setData(toLwcLineData(this.candles, this.indicators.emaMap[period]));
      }
    }
  }

  _syncBollingerSeries() {
    if (!this.bollUpperSeries || !this.bollMidSeries || !this.bollLowerSeries) return;
    this.bollUpperSeries.applyOptions({ visible: this._showBoll });
    this.bollMidSeries.applyOptions({ visible: this._showBoll });
    this.bollLowerSeries.applyOptions({ visible: this._showBoll });

    if (this._showBoll && this.candles.length && this.indicators?.boll) {
      const bollData = toLwcBollingerData(this.candles, this.indicators.boll);
      this.bollUpperSeries.setData(bollData.upper);
      this.bollMidSeries.setData(bollData.middle);
      this.bollLowerSeries.setData(bollData.lower);
    }
  }

  _syncLuxPriceLines() {
    if (!this.candleSeries) return;
    for (const line of this.luxPriceLines) {
      try { this.candleSeries.removePriceLine(line); } catch { /* ignore */ }
    }
    this.luxPriceLines = [];

    // Suppress competing LuxAlgo Auto S&R lines while M3 AI annotations are visible
    if (!this._showLuxSR || !this.indicators?.luxSR || (this._showAIAnnotations && this.aiAnnotations)) return;
    const palette = THEMES[this.theme] || THEMES.light;
    const { currentResistance, currentSupport } = this.indicators.luxSR;

    if (Number.isFinite(currentResistance)) {
      const rLine = this.candleSeries.createPriceLine({
        price: currentResistance,
        color: palette.resistance,
        lineWidth: 1,
        lineStyle: this.LWC.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Auto R'
      });
      this.luxPriceLines.push(rLine);
    }

    if (Number.isFinite(currentSupport)) {
      const sLine = this.candleSeries.createPriceLine({
        price: currentSupport,
        color: palette.support,
        lineWidth: 1,
        lineStyle: this.LWC.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Auto S'
      });
      this.luxPriceLines.push(sLine);
    }
  }

  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    if (!this.lwcChart) return;
    const LWC = this.LWC;
    const palette = THEMES[this.theme] || THEMES.light;

    this.lwcChart.applyOptions({
      layout: {
        background: { type: LWC.ColorType.Solid, color: palette.bg },
        textColor: palette.text,
        attributionLogo: true,
        panes: {
          enableResize: true,
          separatorColor: palette.paneBorder,
          separatorHoverColor: 'rgba(41, 98, 255, 0.25)'
        }
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid }
      },
      crosshair: {
        vertLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairBg },
        horzLine: { color: palette.crosshair, labelBackgroundColor: palette.crosshairBg }
      },
      rightPriceScale: { borderColor: palette.paneBorder },
      timeScale: { borderColor: palette.paneBorder }
    });

    this.candleSeries?.applyOptions({
      upColor: palette.bull,
      downColor: palette.bear,
      borderUpColor: palette.bull,
      borderDownColor: palette.bear,
      wickUpColor: palette.bull,
      wickDownColor: palette.bear
    });

    this.bollUpperSeries?.applyOptions({ color: palette.bollLine });
    this.bollMidSeries?.applyOptions({ color: palette.bollMid });
    this.bollLowerSeries?.applyOptions({ color: palette.bollLine });

    if (this.macdLineSeries) this.macdLineSeries.applyOptions({ color: palette.macdLine });
    if (this.macdSignalSeries) this.macdSignalSeries.applyOptions({ color: palette.signalLine });

    if (this.candles.length) {
      this.volumeSeries?.setData(
        toLwcVolumeData(this.candles, { upColor: palette.volBull, downColor: palette.volBear })
      );
      if (this._showMACD && this.indicators?.macd) {
        const macdData = toLwcMacdData(this.candles, this.indicators.macd, palette);
        this.macdHistSeries?.setData(macdData.histogram);
      }
      this._syncLuxPriceLines();
    }

    this.annotationPrimitive?.setTheme(this.theme);
  }

  setLanguage(lang) {
    this.lang = lang || 'zh-CN';
  }

  setEmaConfig({ showEMA, periods } = {}) {
    if (typeof showEMA === 'boolean') this._showEMA = showEMA;
    if (Array.isArray(periods)) {
      const clean = [...new Set(periods.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 2 && n <= 500))]
        .sort((a, b) => a - b);
      this.emaPeriods = clean;
    }
    if (this.candles.length) {
      this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    }
    this._syncEmaSeries();
  }

  setData({ candles, events, instrument, interval }) {
    this.events = events || [];
    if (instrument) this.instrument = instrument;
    if (interval) this.interval = interval;

    const tzInfo = resolveExchangeTimezone({
      dataMeta: this.dataMeta,
      instrument: this.instrument,
      symbol: this.instrument?.symbol
    });
    this.exchangeTimezone = tzInfo.timeZone;
    this.timezoneAbbr = tzInfo.tzAbbr;

    const normalized = normalizeAndSortCandles(candles || [], {
      interval: this.interval,
      timeZone: this.exchangeTimezone
    });
    this.candles = normalized.map(({ time, open, high, low, close, volume }) => ({
      time,
      open,
      high,
      low,
      close,
      volume
    }));
    this.timeToIndexMap.clear();
    for (let i = 0; i < this.candles.length; i++) {
      this.timeToIndexMap.set(this.candles[i].time, i);
    }

    const lastClose = this.candles.length ? this.candles[this.candles.length - 1].close : 100;
    this.precision = getPrecision(lastClose);
    const minMove = Number((1 / Math.pow(10, this.precision)).toFixed(this.precision));

    this.candleSeries?.applyOptions({
      priceFormat: { type: 'price', precision: this.precision, minMove }
    });
    this.annotationPrimitive?.setPrecision(this.precision);

    const isIntraday = ['1m', '5m', '15m', '1h', '4h'].includes(this.interval);
    this.lwcChart?.applyOptions({
      localization: {
        timeFormatter: (time) =>
          formatLwcCrosshairTime(time, {
            interval: this.interval,
            timeZone: this.exchangeTimezone,
            tzAbbr: this.timezoneAbbr
          })
      },
      timeScale: {
        timeVisible: isIntraday,
        secondsVisible: false,
        tickMarkFormatter: (time, tickMarkType) =>
          formatLwcTickMark(time, tickMarkType, {
            interval: this.interval,
            timeZone: this.exchangeTimezone
          })
      }
    });

    this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    const palette = THEMES[this.theme] || THEMES.light;

    this.candleSeries?.setData(toLwcCandlestickData(this.candles));
    this.volumeSeries?.setData(
      toLwcVolumeData(this.candles, { upColor: palette.volBull, downColor: palette.volBear })
    );
    this.volumeSeries?.applyOptions({ visible: this._showVolume });

    this._syncEmaSeries();
    this._syncBollingerSeries();
    this._syncLuxPriceLines();
    this._syncMacdPane();

    this.fitDefaultZoom();
  }

  updateLiveCandle(candle) {
    if (!candle || !this.candles.length) return;
    const palette = THEMES[this.theme] || THEMES.light;
    const formatted = toLwcRealtimeUpdate(candle, {
      upColor: palette.volBull,
      downColor: palette.volBear,
      interval: this.interval,
      timeZone: this.exchangeTimezone
    });
    if (!formatted) return;

    const { candleBar, volumeBar } = formatted;
    const lastIdx = this.candles.length - 1;
    const last = this.candles[lastIdx];

    if (candleBar.time < last.time) return;

    if (candleBar.time === last.time) {
      this.candles[lastIdx] = {
        time: candleBar.time,
        open: candleBar.open,
        high: candleBar.high,
        low: candleBar.low,
        close: candleBar.close,
        volume: volumeBar.value
      };
    } else {
      this.candles.push({
        time: candleBar.time,
        open: candleBar.open,
        high: candleBar.high,
        low: candleBar.low,
        close: candleBar.close,
        volume: volumeBar.value
      });
      this.timeToIndexMap.set(candleBar.time, this.candles.length - 1);
    }

    try {
      this.candleSeries?.update(candleBar);
      this.volumeSeries?.update(volumeBar);
    } catch {
      this.candleSeries?.setData(toLwcCandlestickData(this.candles));
      this.volumeSeries?.setData(
        toLwcVolumeData(this.candles, { upColor: palette.volBull, downColor: palette.volBear })
      );
    }

    this.indicators = computeAllIndicators(this.candles, this.emaPeriods);
    const latestIdx = this.candles.length - 1;
    const latestTime = this.candles[latestIdx].time;

    if (this._showEMA && this.indicators?.emaMap) {
      for (const period of this.emaPeriods) {
        const series = this.emaSeriesMap.get(period);
        const val = this.indicators.emaMap[period]?.[latestIdx];
        if (series && Number.isFinite(val)) {
          try { series.update({ time: latestTime, value: val }); } catch { /* ignore */ }
        }
      }
    }

    if (this._showBoll && this.indicators?.boll) {
      const u = this.indicators.boll.upper?.[latestIdx];
      const m = this.indicators.boll.mid?.[latestIdx];
      const l = this.indicators.boll.lower?.[latestIdx];
      if (Number.isFinite(u)) try { this.bollUpperSeries?.update({ time: latestTime, value: u }); } catch { /* ignore */ }
      if (Number.isFinite(m)) try { this.bollMidSeries?.update({ time: latestTime, value: m }); } catch { /* ignore */ }
      if (Number.isFinite(l)) try { this.bollLowerSeries?.update({ time: latestTime, value: l }); } catch { /* ignore */ }
    }

    if (this._showMACD && this.indicators?.macd) {
      const mVal = this.indicators.macd.macd?.[latestIdx];
      const sVal = this.indicators.macd.signal?.[latestIdx];
      const hVal = this.indicators.macd.hist?.[latestIdx];
      const prevH = latestIdx > 0 ? (this.indicators.macd.hist?.[latestIdx - 1] ?? 0) : 0;
      if (Number.isFinite(hVal)) {
        const hColor = hVal >= 0
          ? (hVal >= prevH ? palette.histUpStrong : palette.histUpWeak)
          : (hVal <= prevH ? palette.histDownStrong : palette.histDownWeak);
        try { this.macdHistSeries?.update({ time: latestTime, value: hVal, color: hColor }); } catch { /* ignore */ }
      }
      if (Number.isFinite(mVal)) try { this.macdLineSeries?.update({ time: latestTime, value: mVal }); } catch { /* ignore */ }
      if (Number.isFinite(sVal)) try { this.macdSignalSeries?.update({ time: latestTime, value: sVal }); } catch { /* ignore */ }
    }
  }

  setAIAnnotations(annotations) {
    this.aiAnnotations = annotations || null;
    this._showAIAnnotations = true;
    this._syncLuxPriceLines();
    this.annotationPrimitive?.setAnnotations(this.aiAnnotations, {
      theme: this.theme,
      precision: this.precision,
      layers: this.aiLayerFlags,
      visible: true
    });
  }

  clearAIAnnotations() {
    this.aiAnnotations = null;
    this.highlightPrice = null;
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
    }
    this.annotationPrimitive?.clear();
    this._syncLuxPriceLines();
  }

  getAnnotationLayout() {
    return this.annotationPrimitive?.getLastRenderedLayout() || null;
  }

  highlightLevel(price) {
    this.highlightPrice = price;
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.annotationPrimitive?.setHighlightPrice(price);
    this.highlightTimer = setTimeout(() => {
      this.highlightPrice = null;
      this.annotationPrimitive?.setHighlightPrice(null);
    }, 2400);
  }

  fitDefaultZoom() {
    if (!this.lwcChart || !this.candles.length) return;
    const n = this.candles.length;
    const visibleBars = Math.min(Math.max(n, 60), 120);
    this.lwcChart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, n - visibleBars),
      to: n - 1 + 12
    });
    this.candleSeries?.priceScale().setAutoScale(true);
  }

  zoomBy(factor) {
    if (!this.lwcChart || !this.candles.length) return;
    const ts = this.lwcChart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const span = Math.max(10, range.to - range.from);
    const nextSpan = Math.max(12, Math.min(this.candles.length + 40, span / factor));
    const center = range.to - span * 0.25;
    ts.setVisibleLogicalRange({
      from: center - nextSpan * 0.75,
      to: center + nextSpan * 0.25
    });
  }

  resize() {
    const rect = this.stageEl?.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return;
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (this.lwcChart) {
      this.lwcChart.resize(this.width, this.height, true);
    }
  }

  getGeometry() {
    const n = this.candles.length;
    let mainPaneSize = { width: Math.max(120, this.width - 78), height: Math.max(120, this.height - 28) };
    let priceAxisW = 78;
    let timeAxisH = 28;

    try {
      if (this.lwcChart) {
        const ps = this.lwcChart.paneSize(0);
        if (ps && ps.width > 0 && ps.height > 0) mainPaneSize = ps;
        const pw = this.candleSeries?.priceScale()?.width?.() || 0;
        if (pw > 0) priceAxisW = pw;
        const th = this.lwcChart.timeScale()?.height?.() || 0;
        if (th > 0) timeAxisH = th;
      }
    } catch { /* fallback */ }

    const plotLeft = 0;
    const plotTop = 0;
    const plotWidth = mainPaneSize.width;
    const mainHeight = mainPaneSize.height;
    const totalPlotH = Math.max(mainHeight, this.height - timeAxisH);
    const macdHeight = this._showMACD ? Math.max(0, totalPlotH - mainHeight) : 0;

    let visibleStart = Math.max(0, n - 120);
    let visibleEnd = Math.max(0, n - 1);
    const logicalRange = this.lwcChart?.timeScale()?.getVisibleLogicalRange?.();
    if (logicalRange && Number.isFinite(logicalRange.from) && Number.isFinite(logicalRange.to)) {
      visibleStart = Math.max(0, Math.floor(logicalRange.from));
      visibleEnd = Math.min(Math.max(0, n - 1), Math.ceil(logicalRange.to));
    }

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

    const fallbackSpan = Math.max(1, visibleEnd - visibleStart + 6);
    const fallbackIndexToX = (idx) => ((idx - visibleStart) / fallbackSpan) * plotWidth;
    const fallbackXToIndex = (x) => visibleStart + (x / Math.max(1, plotWidth)) * fallbackSpan;
    const fallbackPriceToY = (p) => plotTop + 24 + ((maxP - p) / Math.max(1e-9, maxP - minP)) * Math.max(40, mainHeight - 48);
    const fallbackYToPrice = (y) => maxP - ((y - plotTop - 24) / Math.max(40, mainHeight - 48)) * (maxP - minP);

    const indexToX = (idx) => {
      const coord = this.lwcChart?.timeScale()?.logicalToCoordinate?.(idx);
      return coord !== null && coord !== undefined && Number.isFinite(Number(coord))
        ? Number(coord)
        : fallbackIndexToX(idx);
    };

    const xToIndex = (x) => {
      const logical = this.lwcChart?.timeScale()?.coordinateToLogical?.(x);
      return logical !== null && logical !== undefined && Number.isFinite(Number(logical))
        ? Number(logical)
        : fallbackXToIndex(x);
    };

    const priceToY = (p) => {
      const coord = this.candleSeries?.priceToCoordinate?.(p);
      return coord !== null && coord !== undefined && Number.isFinite(Number(coord))
        ? Number(coord)
        : fallbackPriceToY(p);
    };

    const yToPrice = (y) => {
      const price = this.candleSeries?.coordinateToPrice?.(y);
      return price !== null && price !== undefined && Number.isFinite(Number(price))
        ? Number(price)
        : fallbackYToPrice(y);
    };

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
      priceAxisWidth: priceAxisW,
      timeAxisTop: totalPlotH,
      timeAxisHeight: timeAxisH,
      visibleStart,
      visibleEnd,
      minPrice: minP,
      maxPrice: maxP,
      indexToX,
      xToIndex,
      priceToY,
      yToPrice
    };
  }

  getVisibleRange() {
    const geo = this.getGeometry();
    return { visibleStart: geo.visibleStart, visibleEnd: geo.visibleEnd };
  }

  captureSnapshot({ includeCurrentAI = false } = {}) {
    const geo = this.getGeometry();
    const prevVis = this._showAIAnnotations;
    const wantAI = Boolean(includeCurrentAI && this.aiAnnotations);
    if (this.annotationPrimitive && prevVis !== wantAI) {
      this.annotationPrimitive.setVisible(wantAI);
    }

    let cleanDataUrl = '';
    let shotWidth = this.width;
    let shotHeight = this.height;
    let dprUsed = this.dpr;

    try {
      if (this.lwcChart && typeof this.lwcChart.takeScreenshot === 'function') {
        const shotCanvas = this.lwcChart.takeScreenshot(true, false);
        shotWidth = shotCanvas.width;
        shotHeight = shotCanvas.height;
        dprUsed = this.width > 0 ? shotCanvas.width / this.width : this.dpr;
        cleanDataUrl = shotCanvas.toDataURL('image/png');
      }
    } finally {
      if (this.annotationPrimitive && prevVis !== wantAI) {
        this.annotationPrimitive.setVisible(prevVis);
      }
    }

    const lastCandle = this.candles.length ? { ...this.candles[this.candles.length - 1] } : null;
    const prevCandle = this.candles.length > 1 ? { ...this.candles[this.candles.length - 2] } : lastCandle;

    return {
      cleanDataUrl,
      width: this.width,
      height: this.height,
      bitmapWidth: shotWidth,
      bitmapHeight: shotHeight,
      dpr: dprUsed,
      geometry: geo,
      visibleStart: geo.visibleStart,
      visibleEnd: geo.visibleEnd,
      instrument: { ...this.instrument },
      interval: this.interval,
      latestCandle: lastCandle,
      prevClose: prevCandle?.close ?? null,
      dataMeta: this.dataMeta ? { ...this.dataMeta } : null,
      capturedAt: Date.now()
    };
  }

  captureExportSnapshot({
    width = 1600,
    height = 824,
    theme = 'light',
    includeAnnotations = true,
    annotations = null,
    lang = 'en',
    currencyPrefix = null
  } = {}) {
    const prevWidth = this.width;
    const prevHeight = this.height;
    const prevTheme = this.theme;
    const prevVis = this._showAIAnnotations;
    const prevAnn = this.aiAnnotations;
    const prevLogicalRange = this.lwcChart?.timeScale()?.getVisibleLogicalRange?.() || null;
    const resolvedPrefix = currencyPrefix !== null ? currencyPrefix : (this.instrument?.market === 'in' ? '₹' : '');

    let cleanDataUrl = '';
    let shotWidth = width;
    let shotHeight = height;
    let dprUsed = this.dpr;
    let exportGeo = null;

    try {
      if (this.lwcChart) {
        if (theme && theme !== prevTheme) {
          this.setTheme(theme);
        }
        this.width = width;
        this.height = height;
        this.lwcChart.resize(width, height, true);

        if (prevLogicalRange) {
          this.lwcChart.timeScale().setVisibleLogicalRange(prevLogicalRange);
        }

        const targetAnn = annotations !== null ? annotations : prevAnn;
        if (targetAnn) {
          this.setAIAnnotations(targetAnn);
        }
        if (this.annotationPrimitive) {
          this.annotationPrimitive.setAnnotations(targetAnn, {
            lang,
            currencyPrefix: resolvedPrefix
          });
          this.annotationPrimitive.setVisible(Boolean(includeAnnotations && targetAnn));
        }

        const shotCanvas = this.lwcChart.takeScreenshot(true, false);
        shotWidth = shotCanvas.width;
        shotHeight = shotCanvas.height;
        dprUsed = width > 0 ? shotCanvas.width / width : this.dpr;
        cleanDataUrl = shotCanvas.toDataURL('image/png');
        exportGeo = this.getGeometry();

        const ts = this.lwcChart.timeScale();
        const cs = this.candleSeries;
        const hLines = (targetAnn?.horizontalLevels || []).map((lvl) => ({
          type: lvl.type,
          price: lvl.price,
          y: cs ? cs.priceToCoordinate(lvl.price) : null
        })).filter((x) => Number.isFinite(x.y));
        const anchors = [];
        for (const t of (targetAnn?.trendlines || [])) {
          const x1 = ts && this.candles[t.startIndex] ? ts.timeToCoordinate(this.candles[t.startIndex].time) : null;
          const y1 = cs ? cs.priceToCoordinate(t.startPrice) : null;
          const x2 = ts && this.candles[t.endIndex] ? ts.timeToCoordinate(this.candles[t.endIndex].time) : null;
          const y2 = cs ? cs.priceToCoordinate(t.endPrice) : null;
          if (Number.isFinite(x1) && Number.isFinite(y1)) anchors.push({ kind: 'trendline', x: x1, y: y1 });
          if (Number.isFinite(x2) && Number.isFinite(y2)) anchors.push({ kind: 'trendline', x: x2, y: y2 });
        }
        for (const p of (targetAnn?.patterns || [])) {
          for (const pt of (p.points || [])) {
            const x = ts && this.candles[pt.index] ? ts.timeToCoordinate(this.candles[pt.index].time) : null;
            const y = cs ? cs.priceToCoordinate(pt.price) : null;
            if (Number.isFinite(x) && Number.isFinite(y)) anchors.push({ kind: 'pattern', x, y });
          }
        }
        exportGeo.exportCoords = { hLines, anchors };
      }
    } finally {
      if (this.lwcChart) {
        if (prevTheme !== this.theme) {
          this.setTheme(prevTheme);
        }
        this.width = prevWidth;
        this.height = prevHeight;
        this.lwcChart.resize(prevWidth, prevHeight, true);
        if (prevLogicalRange) {
          this.lwcChart.timeScale().setVisibleLogicalRange(prevLogicalRange);
        }
      }
      if (prevAnn) {
        this.setAIAnnotations(prevAnn);
      }
      if (this.annotationPrimitive) {
        this.annotationPrimitive.setAnnotations(prevAnn, {
          lang: this.lang,
          currencyPrefix: this.instrument?.market === 'in' ? '₹' : ''
        });
        this.annotationPrimitive.setVisible(prevVis);
      }
    }

    const lastCandle = this.candles.length ? { ...this.candles[this.candles.length - 1] } : null;
    const prevCandle = this.candles.length > 1 ? { ...this.candles[this.candles.length - 2] } : lastCandle;
    const finalGeo = exportGeo || this.getGeometry();

    return {
      cleanDataUrl,
      width,
      height,
      bitmapWidth: shotWidth,
      bitmapHeight: shotHeight,
      dpr: dprUsed,
      theme,
      geometry: finalGeo,
      visibleStart: finalGeo.visibleStart,
      visibleEnd: finalGeo.visibleEnd,
      instrument: { ...this.instrument },
      interval: this.interval,
      latestCandle: lastCandle,
      prevClose: prevCandle?.close ?? null,
      dataMeta: this.dataMeta ? { ...this.dataMeta } : null,
      capturedAt: Date.now()
    };
  }

  render() {
    if (this.volumeSeries) this.volumeSeries.applyOptions({ visible: this._showVolume });
    this._syncEmaSeries();
    this._syncBollingerSeries();
    this._syncLuxPriceLines();
    this._syncMacdPane();
    this.annotationPrimitive?.setLayers(this.aiLayerFlags);
    this.annotationPrimitive?.setVisible(this._showAIAnnotations);
  }
}
