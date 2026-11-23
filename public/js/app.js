/**
 * ChartCopilot Main Application Coordinator.
 * Connects live multi-market K-line feeds (Binance WebSocket + Yahoo/Server polling),
 * interactive ChartEngine, SymbolSearchModal, AICopilotController, ScreenshotStudio,
 * BYOK Settings modal, and Pine Script exporter.
 */

import { ChartEngine } from './lwcChartEngine.js';
import { formatPrice, formatVolume, getPrecision, PRESET_EMA_PERIODS, getEmaColor } from './indicators.js';
import { generatePineScript } from './localAnalyzer.js';
import { SymbolSearchModal } from './symbolSearch.js';
import { ScreenshotStudio } from './screenshotAnnotator.js';
import { AICopilotController, PROVIDER_PRESETS, formatFeedStatusDisplay } from './aiCopilot.js';
import { getLangPack } from './i18n.js';
import { escapeHtml } from './sanitize.js';

class ChartCopilotApp {
  constructor() {
    this.currentSymbol = localStorage.getItem('chartcopilot_last_symbol') || 'ALKALI.NS';
    this.currentInterval = localStorage.getItem('chartcopilot_last_interval') || '1d';
    this.currentInstrument = null;
    this.theme = localStorage.getItem('chartcopilot_theme') || 'light';
    this.uiLang = localStorage.getItem('chartcopilot_ui_lang') || 'zh-CN';
    this.chartLang = localStorage.getItem('chartcopilot_chart_lang') || this.uiLang;
    this.emaPeriods = this._loadSavedEmaPeriods();
    const savedShowEma = localStorage.getItem('chartcopilot_show_ema_v1');
    this.showEMA = savedShowEma === null ? true : savedShowEma === 'true';

    this.liveWs = null;
    this.pollTimer = null;
    this.lastFeedSource = 'live';
    this.lastFeedMeta = null;

    this._initElements();
    this._initModules();
    this._applyTheme(this.theme);
    this._applyLanguage(this.uiLang, this.chartLang);
    this._syncEmaPickerUI();
    this._bindEvents();
    this._syncSettingsUI();
    this.loadSymbol(this.currentSymbol, this.currentInterval);
  }

  _loadSavedEmaPeriods() {
    try {
      const raw = localStorage.getItem('chartcopilot_ema_periods_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = [...new Set(parsed.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 2 && n <= 500))]
            .sort((a, b) => a - b);
          if (valid.length) return valid;
        }
      }
    } catch { /* ignore */ }
    return [5, 10, 20];
  }

  _initElements() {
    this.el = {
      symbolTrigger: document.getElementById('symbolTriggerBtn'),
      symbolTickerText: document.getElementById('symbolTickerText'),
      symbolNameText: document.getElementById('symbolNameText'),
      timeframeBtns: document.querySelectorAll('[data-interval]'),
      indicatorMenuBtn: document.getElementById('indicatorMenuBtn'),
      indicatorDropdown: document.getElementById('indicatorDropdown'),
      indCheckboxes: document.querySelectorAll('[data-indicator-toggle]'),
      emaMasterLabel: document.getElementById('emaMasterLabel'),
      emaPickerPanel: document.getElementById('emaPickerPanel'),
      emaPeriodGrid: document.getElementById('emaPeriodGrid'),
      customEmaList: document.getElementById('customEmaList'),
      customEmaInput: document.getElementById('customEmaInput'),
      btnAddCustomEma: document.getElementById('btnAddCustomEma'),
      btnAiAnnotateNow: document.getElementById('btnAiAnnotateNow'),
      btnExportPine: document.getElementById('btnExportPine'),
      liveBadge: document.getElementById('liveStatusBadge'),
      liveBadgeText: document.getElementById('liveStatusText'),
      langSelect: document.getElementById('langSelect'),
      btnThemeToggle: document.getElementById('btnThemeToggle'),
      btnApiSettings: document.getElementById('btnApiSettings'),
      apiStatusLabel: document.getElementById('apiStatusLabel'),
      btnToggleCopilot: document.getElementById('btnToggleCopilot'),

      btnToggleAiLayer: document.getElementById('btnToggleAiLayer'),
      btnQuickSnapshot: document.getElementById('btnQuickSnapshot'),
      btnClearDrawings: document.getElementById('btnClearDrawings'),

      chartContainer: document.getElementById('lwcChartContainer'),
      hudTitle: document.getElementById('hudInstrumentTitle'),
      hudExchange: document.getElementById('hudExchangeBadge'),
      hudDataStatusBadge: document.getElementById('hudDataStatusBadge'),
      simulatedWatermark: document.getElementById('simulatedWatermark'),
      hudOHLCV: document.getElementById('hudOHLCV'),
      hudIndicators: document.getElementById('hudIndicatorLine'),
      aiLayerBar: document.getElementById('aiLayerBar'),
      aiLayerBarLabel: document.getElementById('aiLayerBarLabel'),
      chartLangSelect: document.getElementById('chartLangSelect'),
      aiLayerChips: document.querySelectorAll('[data-ai-layer]'),
      btnClearAiOverlay: document.getElementById('btnClearAiOverlay'),
      btnZoomIn: document.getElementById('btnZoomIn'),
      btnZoomOut: document.getElementById('btnZoomOut'),
      btnZoomReset: document.getElementById('btnZoomReset'),

      copilotPane: document.getElementById('copilotPane'),
      copilotResizer: document.getElementById('copilotResizer'),
      btnNewChat: document.getElementById('btnNewChat'),
      btnCopilotSettings: document.getElementById('btnCopilotSettings'),
      btnCloseCopilot: document.getElementById('btnCloseCopilot'),
      copilotWelcome: document.getElementById('copilotWelcome'),
      copilotFeed: document.getElementById('copilotChatFeed'),
      quickPromptBtns: document.querySelectorAll('[data-quick-prompt]'),
      promptInput: document.getElementById('copilotPromptInput'),
      chkAttachShot: document.getElementById('chkAttachScreenshot'),
      chkAutoDraw: document.getElementById('chkAutoDraw'),
      chkDemoMode: document.getElementById('chkDemoMode'),
      demoModeBanner: document.getElementById('demoModeBanner'),
      demoModeBannerText: document.getElementById('demoModeBannerText'),
      modelSwitcherBtn: document.getElementById('modelSwitcherBtn'),
      activeModelText: document.getElementById('activeModelText'),
      btnSendPrompt: document.getElementById('btnSendPrompt'),
      quickSymbolBtns: document.querySelectorAll('[data-quick-symbol]'),

      searchModal: document.getElementById('symbolSearchModal'),
      studioModal: document.getElementById('screenshotStudioModal'),
      settingsModal: document.getElementById('apiSettingsModal'),
      pineModal: document.getElementById('pineScriptModal'),

      presetBtns: document.querySelectorAll('[data-provider-preset]'),
      inputApiKey: document.getElementById('inputApiKey'),
      btnToggleKeyVis: document.getElementById('btnToggleKeyVis'),
      inputBaseUrl: document.getElementById('inputBaseUrl'),
      inputModelName: document.getElementById('inputModelName'),
      modelSuggestions: document.getElementById('modelQuickChips'),
      chkEnableVision: document.getElementById('chkEnableVision'),
      providerNote: document.getElementById('providerNote'),
      btnTestApi: document.getElementById('btnTestApi'),
      apiTestResult: document.getElementById('apiTestResult'),
      btnClearApiKey: document.getElementById('btnClearApiKey'),
      btnSaveApiSettings: document.getElementById('btnSaveApiSettings'),
      btnCloseSettings: document.getElementById('btnCloseSettings'),

      pineCodeArea: document.getElementById('pineCodeArea'),
      btnCopyPine: document.getElementById('btnCopyPine'),
      btnClosePine: document.getElementById('btnClosePine')
    };
  }

  _initModules() {
    this.chart = new ChartEngine(this.el.chartContainer, {
      onHoverChange: ({ candle, prevClose, index }) => this._updateOHLCVHud(candle, prevClose, index)
    });
    this.chart.setEmaConfig({ showEMA: this.showEMA, periods: this.emaPeriods });

    this.studio = new ScreenshotStudio(this.el.studioModal);

    this.searchModal = new SymbolSearchModal(this.el.searchModal, {
      onSelect: (instrument) => {
        this.loadSymbol(instrument.symbol, this.currentInterval, instrument);
      }
    });

    this.copilot = new AICopilotController({
      chartEngine: this.chart,
      screenshotStudio: this.studio,
      chatFeedEl: this.el.copilotFeed,
      welcomeEl: this.el.copilotWelcome,
      onAnnotationsApplied: (annotations) => this._showAiLayerBar(annotations),
      onOpenSettings: () => this.openSettingsModal(),
      onExportPine: (annotations) => this.openPineModal(annotations)
    });

    const ro = new ResizeObserver(() => this.chart.resize());
    ro.observe(this.el.chartContainer.parentElement);
  }

  _applyTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('chartcopilot_theme', this.theme);
    this.chart.setTheme(this.theme);
    if (this.el.btnThemeToggle) {
      this.el.btnThemeToggle.title = this.theme === 'dark' ? '切换亮色主题 (TradingView Classic)' : '切换专业暗色主题';
      this.el.btnThemeToggle.textContent = this.theme === 'dark' ? '☀' : '☾';
    }
  }

  async loadSymbol(symbol, interval = this.currentInterval, prefilledInstrument = null) {
    this._stopLiveStreams();
    this.currentSymbol = symbol;
    this.currentInterval = interval;
    localStorage.setItem('chartcopilot_last_symbol', symbol);
    localStorage.setItem('chartcopilot_last_interval', interval);

    this.el.timeframeBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.interval === interval);
    });

    this.el.liveBadge.className = 'live-badge status-loading';
    this.el.liveBadgeText.textContent = '加载行情...';
    if (this.el.hudDataStatusBadge) {
      this.el.hudDataStatusBadge.className = 'hud-data-status status-loading';
      this.el.hudDataStatusBadge.textContent = '加载行情...';
    }

    try {
      const res = await fetch(
        `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || '加载失败');
      }

      this.currentInstrument = prefilledInstrument
        ? { ...data.instrument, ...prefilledInstrument, symbol: data.instrument.symbol }
        : data.instrument;
      this.lastFeedSource = data.meta?.source || data.source;
      this.lastFeedMeta = data.meta || {
        source: data.source,
        fetchedAt: data.serverTime || Date.now(),
        ageMs: 0,
        stale: false
      };
      this.chart.dataMeta = this.lastFeedMeta;
      this.copilot.setDataMeta(this.lastFeedMeta);

      this.chart.clearAIAnnotations();
      this._hideAiLayerBar();

      this.chart.setData({
        candles: data.candles,
        events: data.events || [],
        instrument: this.currentInstrument,
        interval
      });

      this._updateHeaderInstrumentUI();
      const last = data.candles[data.candles.length - 1];
      const prev = data.candles[data.candles.length - 2] || last;
      this._updateOHLCVHud(last, prev.close);
      this._updateFeedStatus(data.source, data.feedName, this.lastFeedMeta);

      this._startLiveStreams(data);
    } catch (err) {
      this.el.liveBadge.className = 'live-badge status-error';
      this.el.liveBadgeText.textContent = '行情异常';
      if (this.el.hudDataStatusBadge) {
        this.el.hudDataStatusBadge.className = 'hud-data-status status-error';
        this.el.hudDataStatusBadge.textContent = '行情异常';
      }
      console.error('[LoadSymbol]', err);
    }
  }

  _applyLanguage(uiLang = this.uiLang, chartLang = this.chartLang) {
    this.uiLang = uiLang;
    this.chartLang = chartLang;
    localStorage.setItem('chartcopilot_ui_lang', uiLang);
    localStorage.setItem('chartcopilot_chart_lang', chartLang);
    document.documentElement.lang = uiLang;

    const pack = getLangPack(uiLang);
    const U = pack.ui;

    if (this.el.langSelect) this.el.langSelect.value = uiLang;
    if (this.el.chartLangSelect) this.el.chartLangSelect.value = chartLang;

    this.el.timeframeBtns.forEach((b) => {
      const iv = b.dataset.interval;
      if (pack.tf[iv]) b.textContent = pack.tf[iv];
    });
    const indSpan = this.el.indicatorMenuBtn?.querySelector('span');
    if (indSpan) indSpan.textContent = U.indicators;
    const ctaSpan = this.el.btnAiAnnotateNow?.querySelector('span');
    if (ctaSpan) ctaSpan.textContent = U.aiAnnotateBtn;
    const pineSpan = this.el.btnExportPine?.querySelector('span');
    if (pineSpan) pineSpan.textContent = U.pineBtn;

    const ddTitle = this.el.indicatorDropdown?.querySelector('.dropdown-title');
    if (ddTitle) ddTitle.textContent = U.indTitle;
    const indLabelMap = { luxsr: U.indAutoSR, volume: U.indVol, macd: U.indMacd, boll: U.indBoll };
    this.el.indCheckboxes.forEach((cb) => {
      const sp = cb.parentElement?.querySelector('span');
      if (sp && indLabelMap[cb.dataset.indicatorToggle]) sp.textContent = indLabelMap[cb.dataset.indicatorToggle];
    });
    this._syncEmaPickerUI();

    if (this.el.aiLayerBarLabel) this.el.aiLayerBarLabel.textContent = U.aiLayerLabel;
    const layerMap = {
      horizontalLevels: U.layerSR,
      trendlines: U.layerTrend,
      patterns: U.layerPattern,
      signals: U.layerSignal,
      tradePlan: U.layerTrade
    };
    this.el.aiLayerChips.forEach((chip) => {
      if (layerMap[chip.dataset.aiLayer]) chip.textContent = layerMap[chip.dataset.aiLayer];
    });
    if (this.el.btnZoomReset) this.el.btnZoomReset.textContent = U.resetView;

    const cpTitle = document.querySelector('.copilot-header-title span');
    if (cpTitle) cpTitle.textContent = U.copilotTitle;
    if (this.el.btnNewChat) this.el.btnNewChat.textContent = U.newChat;
    const wh = document.querySelector('.welcome-heading');
    if (wh) wh.textContent = U.welcomeHead;
    const ws = document.querySelector('.welcome-sub');
    if (ws) ws.textContent = U.welcomeSub;

    const qpData = [
      [U.qp1, U.qp1Prompt],
      [U.qp2, U.qp2Prompt],
      [U.qp3, U.qp3Prompt],
      [U.qp4, U.qp4Prompt],
      [U.qp5, U.qp5Prompt]
    ];
    this.el.quickPromptBtns.forEach((btn, idx) => {
      if (idx < qpData.length) {
        const sp = btn.querySelector('.chip-text');
        if (sp) sp.textContent = qpData[idx][0];
        btn.dataset.quickPrompt = qpData[idx][1];
      }
    });

    const toggleSpans = document.querySelectorAll('.mini-toggle span');
    if (toggleSpans[0]) toggleSpans[0].textContent = U.attachShot;
    if (toggleSpans[1]) toggleSpans[1].textContent = U.syncChart;

    const st = document.getElementById('symbolSearchTitle');
    if (st) st.textContent = U.searchTitle;
    const si = document.getElementById('symbolSearchInput');
    if (si) si.placeholder = U.searchPlaceholder;
    if (U.marketTabs) {
      document.querySelectorAll('[data-market-tab]').forEach((tab) => {
        const key = tab.dataset.marketTab;
        if (U.marketTabs[key]) tab.textContent = U.marketTabs[key];
      });
    }
    const at = document.getElementById('apiSettingsTitle');
    if (at) at.textContent = U.settingsTitle;
    const pt = document.getElementById('pineModalTitle');
    if (pt) pt.textContent = U.pineTitle;

    this.chart.setLanguage(chartLang);
    this.copilot.setLanguages(uiLang, chartLang);
    this.copilot.refreshLatestScreenshot(chartLang);
    this._syncSettingsUI();
    this._updateHeaderInstrumentUI();
    if (this.chart.candles.length) {
      const last = this.chart.candles[this.chart.candles.length - 1];
      const prev = this.chart.candles[this.chart.candles.length - 2] || last;
      this._updateOHLCVHud(last, prev.close);
    }
    if (this.lastFeedSource) {
      this._updateFeedStatus(this.lastFeedSource, '');
    }
  }

  _updateHeaderInstrumentUI() {
    const pack = getLangPack(this.uiLang);
    const U = pack.ui;
    const inst = this.currentInstrument || { displaySymbol: this.currentSymbol, name: this.currentSymbol, exchange: '' };
    const displayName =
      this.uiLang === 'en'
        ? (inst.enName || inst.name || inst.displaySymbol)
        : this.uiLang === 'ko'
          ? (inst.koName || inst.enName || inst.name || inst.displaySymbol)
          : (inst.name || inst.displaySymbol);
    this.el.symbolTickerText.textContent = inst.displaySymbol || inst.symbol;
    this.el.symbolNameText.textContent = displayName;
    this.el.hudTitle.textContent = `${displayName} · ${pack.tf[this.currentInterval] || this.currentInterval}`;
    this.el.hudExchange.textContent = inst.exchange || '';
    this.el.promptInput.placeholder = `${U.placeholderPrefix}${inst.displaySymbol || inst.symbol}${U.placeholderSuffix}`;

    const dynBtn = document.getElementById('quickPromptDynamic');
    if (dynBtn) {
      dynBtn.dataset.quickPrompt = `${U.qp6PromptPrefix}${inst.displaySymbol}${U.qp6PromptSuffix}`;
      dynBtn.querySelector('.chip-text').textContent = `${inst.displaySymbol}${U.qp6Suffix}`;
    }
  }

  _updateOHLCVHud(candle, prevClose, candleIdx) {
    if (!candle) return;
    const H = getLangPack(this.chartLang).hud;
    const p = getPrecision(candle.close);
    const diff = candle.close - (prevClose ?? candle.open);
    const pct = prevClose ? (diff / prevClose) * 100 : 0;
    const cls = diff >= 0 ? 'num-up' : 'num-down';

    this.el.hudOHLCV.innerHTML = `
      <span>${escapeHtml(H.open)}=<b class="${cls}">${escapeHtml(formatPrice(candle.open, p))}</b></span>
      <span>${escapeHtml(H.high)}=<b class="${cls}">${escapeHtml(formatPrice(candle.high, p))}</b></span>
      <span>${escapeHtml(H.low)}=<b class="${cls}">${escapeHtml(formatPrice(candle.low, p))}</b></span>
      <span>${escapeHtml(H.close)}=<b class="${cls}">${escapeHtml(formatPrice(candle.close, p))}</b></span>
      <span class="${cls}">${diff >= 0 ? '+' : ''}${escapeHtml(formatPrice(diff, p))} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>
      <span class="hud-vol">${escapeHtml(H.vol)} <b>${escapeHtml(formatVolume(candle.volume))}</b></span>
    `;

    const indParts = [];
    if (this.chart.showLuxSR && this.chart.indicators?.luxSR) {
      const { currentResistance, currentSupport } = this.chart.indicators.luxSR;
      indParts.push(
        `<span class="ind-item">${escapeHtml(H.autoSR)} <b class="num-down">${escapeHtml(formatPrice(currentResistance, p))}</b> <b class="num-blue">${escapeHtml(formatPrice(currentSupport, p))}</b></span>`
      );
    }
    if (this.chart.showEMA && this.chart.indicators?.emaMap && this.chart.emaPeriods.length) {
      const idx =
        typeof candleIdx === 'number' && candleIdx >= 0 && candleIdx < this.chart.candles.length
          ? candleIdx
          : this.chart.candles.length - 1;
      const emaSpans = this.chart.emaPeriods
        .map((period) => {
          const val = this.chart.indicators.emaMap[period]?.[idx];
          const color = getEmaColor(period);
          return `<span class="hud-ema-val" style="color:${escapeHtml(color)}">EMA${Number(period)} <b>${escapeHtml(formatPrice(val, p))}</b></span>`;
        })
        .join('');
      indParts.push(`<span class="ind-item hud-ema-group">${emaSpans}</span>`);
    }
    this.el.hudIndicators.innerHTML = indParts.join('');
  }

  _persistAndApplyEma() {
    localStorage.setItem('chartcopilot_ema_periods_v1', JSON.stringify(this.emaPeriods));
    localStorage.setItem('chartcopilot_show_ema_v1', String(this.showEMA));
    this.chart.setEmaConfig({ showEMA: this.showEMA, periods: this.emaPeriods });
    this._syncEmaPickerUI();
    if (this.chart.candles.length) {
      const last = this.chart.candles[this.chart.candles.length - 1];
      const prev = this.chart.candles[this.chart.candles.length - 2] || last;
      this._updateOHLCVHud(last, prev?.close, this.chart.candles.length - 1);
    }
  }

  _syncEmaPickerUI() {
    const emaCb = document.querySelector('[data-indicator-toggle="ema"]');
    if (emaCb) emaCb.checked = this.showEMA;
    if (this.el.emaMasterLabel) {
      const activeText = this.emaPeriods.length ? ` (${this.emaPeriods.join(' / ')})` : '';
      const base = this.uiLang === 'en' ? 'EMA Moving Averages' : this.uiLang === 'ja' ? '指数移動平均 EMA' : this.uiLang === 'ko' ? '지수이동평균 EMA' : '指数移动平均线 EMA';
      this.el.emaMasterLabel.textContent = `${base}${activeText}`;
    }
    if (this.el.emaPeriodGrid) {
      this.el.emaPeriodGrid.querySelectorAll('[data-ema-period]').forEach((btn) => {
        const p = parseInt(btn.dataset.emaPeriod, 10);
        const active = this.showEMA && this.emaPeriods.includes(p);
        btn.classList.toggle('active', active);
        const color = getEmaColor(p);
        btn.style.borderColor = active ? color : '';
      });
    }
    if (this.el.customEmaList) {
      const customPeriods = this.emaPeriods.filter((p) => !PRESET_EMA_PERIODS.includes(p));
      this.el.customEmaList.innerHTML = customPeriods
        .map((p) => {
          const safeP = Number(p);
          const safeColor = escapeHtml(getEmaColor(safeP));
          return `<span class="ema-custom-chip" style="border-color:${safeColor}"><i class="ema-dot" style="background:${safeColor}"></i>EMA ${safeP}<button type="button" class="ema-del-btn" data-remove-ema="${safeP}" title="移除">×</button></span>`;
        })
        .join('');
      this.el.customEmaList.querySelectorAll('[data-remove-ema]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const p = parseInt(btn.dataset.removeEma, 10);
          this.emaPeriods = this.emaPeriods.filter((x) => x !== p);
          if (!this.emaPeriods.length) this.showEMA = false;
          this._persistAndApplyEma();
        });
      });
    }
  }

  _toggleEmaPeriod(period) {
    const p = parseInt(period, 10);
    if (!Number.isFinite(p) || p < 2 || p > 500) return;
    if (!this.showEMA) {
      this.showEMA = true;
      if (!this.emaPeriods.includes(p)) {
        this.emaPeriods = [...this.emaPeriods, p].sort((a, b) => a - b);
      }
    } else if (this.emaPeriods.includes(p)) {
      this.emaPeriods = this.emaPeriods.filter((x) => x !== p);
      if (!this.emaPeriods.length) this.showEMA = false;
    } else {
      this.emaPeriods = [...this.emaPeriods, p].sort((a, b) => a - b);
    }
    this._persistAndApplyEma();
  }

  _addCustomEmaPeriod() {
    if (!this.el.customEmaInput) return;
    const val = parseInt(this.el.customEmaInput.value, 10);
    if (!Number.isFinite(val) || val < 2 || val > 500) {
      this.el.customEmaInput.focus();
      return;
    }
    this.showEMA = true;
    if (!this.emaPeriods.includes(val)) {
      this.emaPeriods = [...this.emaPeriods, val].sort((a, b) => a - b);
    }
    this.el.customEmaInput.value = '';
    this._persistAndApplyEma();
  }

  _updateFeedStatus(source, feedName, meta = this.lastFeedMeta) {
    const disp = formatFeedStatusDisplay(meta, source, feedName);

    if (this.el.liveBadge) {
      this.el.liveBadge.className = disp.badgeClass;
      this.el.liveBadge.dataset.feedStatus = disp.source;
      this.el.liveBadge.dataset.feedStale = String(disp.stale);
      this.el.liveBadge.title = disp.tooltip;
    }
    if (this.el.liveBadgeText) {
      this.el.liveBadgeText.textContent = disp.badgeText;
    }
    if (this.el.hudDataStatusBadge) {
      this.el.hudDataStatusBadge.className = disp.hudClass;
      this.el.hudDataStatusBadge.dataset.feedStatus = disp.source;
      this.el.hudDataStatusBadge.dataset.feedStale = String(disp.stale);
      this.el.hudDataStatusBadge.textContent = disp.hudText;
      this.el.hudDataStatusBadge.title = disp.tooltip;
    }
    if (this.el.simulatedWatermark) {
      this.el.simulatedWatermark.hidden = !disp.showSimWatermark;
      this.el.simulatedWatermark.dataset.watermarkVisible = String(disp.showSimWatermark);
    }
    this._syncDemoModeBanner(disp);
  }

  _syncDemoModeBanner(disp = formatFeedStatusDisplay(this.lastFeedMeta, this.lastFeedSource, '')) {
    if (!this.el.demoModeBanner) return;
    const isSim = disp.source === 'simulated';
    const isDemoOn = Boolean(this.copilot?.demoMode);
    if (!isSim && !isDemoOn) {
      this.el.demoModeBanner.hidden = true;
      return;
    }
    this.el.demoModeBanner.hidden = false;
    if (this.el.demoModeBannerText) {
      if (isSim && !isDemoOn) {
        this.el.demoModeBannerText.textContent = '当前为模拟数据：AI 分析默认已禁用（开启下方「演示模式」开关后可运行演示分析）';
      } else if (isSim && isDemoOn) {
        this.el.demoModeBannerText.textContent = '基于模拟数据，仅供演示（演示模式已开启，此声明仅在界面横幅与图上水印展示，不进入可复制文本）';
      } else {
        this.el.demoModeBannerText.textContent = '演示模式开关已开启（当前行情为真实/缓存数据）';
      }
    }
  }

  _stopLiveStreams() {
    if (this.liveWs) {
      try { this.liveWs.close(); } catch { /* ignore */ }
      this.liveWs = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _startLiveStreams(initialData) {
    const isRealUpstream =
      initialData.source === 'live' ||
      (initialData.source === 'cache' && !initialData.meta?.stale);

    if (isRealUpstream && initialData.wsSymbol && initialData.wsInterval) {
      try {
        const ws = new WebSocket(
          `wss://stream.binance.com:9443/ws/${initialData.wsSymbol}@kline_${initialData.wsInterval}`
        );
        this.liveWs = ws;
        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            const k = msg?.k;
            if (!k) return;
            const liveCandle = {
              time: Math.floor(k.t / 1000),
              open: parseFloat(k.o),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              close: parseFloat(k.c),
              volume: parseFloat(k.v)
            };
            this.chart.updateLiveCandle(liveCandle);
            if (!this.chart.mouse.inside) {
              const prev = this.chart.candles[this.chart.candles.length - 2] || liveCandle;
              this._updateOHLCVHud(liveCandle, prev.close);
            }
          } catch { /* ignore malformed frame */ }
        };
        ws.onerror = () => {};
      } catch { /* fallback to polling */ }
    }

    const pollMs = isRealUpstream ? 5000 : 2500;
    this.pollTimer = setInterval(async () => {
      if (this.liveWs && this.liveWs.readyState === WebSocket.OPEN) return;
      try {
        const res = await fetch(
          `/api/quote?symbol=${encodeURIComponent(this.currentSymbol)}&interval=${encodeURIComponent(this.currentInterval)}`
        );
        if (!res.ok) return;
        const tick = await res.json();
        if (tick?.candle) {
          this.chart.updateLiveCandle(tick.candle);
          if (!this.chart.mouse.inside) {
            this._updateOHLCVHud(tick.candle, tick.prevClose);
          }
          if (tick.meta && (tick.meta.stale || tick.meta.source === 'simulated' || this.lastFeedMeta?.source !== tick.meta.source)) {
            this.lastFeedSource = tick.meta.source;
            this.lastFeedMeta = tick.meta;
            this.chart.dataMeta = tick.meta;
            this.copilot.setDataMeta(tick.meta);
            this._updateFeedStatus(tick.source, tick.feedName, tick.meta);
          }
        }
      } catch { /* ignore intermittent poll errors */ }
    }, pollMs);
  }

  _showAiLayerBar(annotations) {
    if (!annotations) return;
    this.el.aiLayerBar.classList.add('visible');
    this.el.btnToggleAiLayer?.classList.add('active');
    this.el.aiLayerChips.forEach((chip) => {
      const key = chip.dataset.aiLayer;
      chip.classList.toggle('active', Boolean(this.chart.aiLayerFlags[key]));
    });
  }

  _hideAiLayerBar() {
    this.el.aiLayerBar.classList.remove('visible');
  }

  _syncSettingsUI() {
    const s = this.copilot.settings;
    const hasKey = this.copilot.hasApiKey();
    this.el.activeModelText.textContent = this.copilot.getActiveModelLabel();
    this.el.apiStatusLabel.textContent = hasKey ? s.model : getLangPack(this.uiLang).ui.apiKeyBtn;
    this.el.btnApiSettings.classList.toggle('configured', hasKey);
    if (this.el.chkDemoMode) {
      this.el.chkDemoMode.checked = Boolean(this.copilot.demoMode);
    }
    this._syncDemoModeBanner();
  }

  openSettingsModal() {
    const s = this.copilot.settings;
    this.el.inputApiKey.value = s.apiKey || '';
    this.el.inputBaseUrl.value = s.baseUrl || PROVIDER_PRESETS.deepseek.baseUrl;
    this.el.inputModelName.value = s.model || PROVIDER_PRESETS.deepseek.defaultModel;
    this.el.chkEnableVision.checked = Boolean(s.enableVision);
    this.el.apiTestResult.textContent = '';
    this.el.apiTestResult.className = 'api-test-result';
    this._selectProviderPreset(s.provider || 'deepseek', false);
    this.el.settingsModal.classList.add('open');
  }

  _selectProviderPreset(providerId, overwriteFields = true) {
    const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
    this.el.presetBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.providerPreset === preset.id);
    });
    if (overwriteFields) {
      this.el.inputBaseUrl.value = preset.baseUrl;
      this.el.inputModelName.value = preset.defaultModel;
      this.el.chkEnableVision.checked = preset.defaultVision;
    }
    this.el.providerNote.textContent = preset.note;
    this.el.modelSuggestions.innerHTML = preset.models
      .map((m) => `<button type="button" class="model-chip" data-pick-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`)
      .join('');
    this.el.modelSuggestions.querySelectorAll('[data-pick-model]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.el.inputModelName.value = btn.dataset.pickModel;
        const isVis = /(gpt-4o|vision|vl|claude-3|gemini)/i.test(btn.dataset.pickModel);
        this.el.chkEnableVision.checked = isVis;
      });
    });
  }

  openPineModal(annotations = this.chart.aiAnnotations) {
    if (!annotations) {
      this.copilot.ask('在此图表上标记关键支撑压力水平线与趋势线，并准备 Pine Script 导出');
      return;
    }
    const code = generatePineScript(this.currentInstrument, annotations, this.chart.candles);
    this.el.pineCodeArea.value = code;
    this.el.pineModal.classList.add('open');
  }

  _submitPrompt(text) {
    const prompt = (text ?? this.el.promptInput.value).trim();
    if (!prompt) return;
    if (text === undefined) {
      this.el.promptInput.value = '';
      this.el.promptInput.style.height = 'auto';
    }
    this.el.copilotPane.classList.remove('collapsed');
    this.copilot.ask(prompt, {
      captureScreenshot: this.el.chkAttachShot.checked,
      autoDraw: this.el.chkAutoDraw.checked,
      demoMode: Boolean(this.el.chkDemoMode ? this.el.chkDemoMode.checked : this.copilot.demoMode)
    });
  }

  _bindEvents() {
    this.el.chkDemoMode?.addEventListener('change', (e) => {
      this.copilot.setDemoMode(Boolean(e.target.checked));
      this._syncDemoModeBanner();
    });
    this.el.symbolTrigger.addEventListener('click', () => this.searchModal.open(''));

    this.el.quickSymbolBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.loadSymbol(btn.dataset.quickSymbol, this.currentInterval);
      });
    });

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        this.searchModal.open('');
      } else if (e.key === 'Escape') {
        this.el.settingsModal.classList.remove('open');
        this.el.pineModal.classList.remove('open');
        this.el.indicatorDropdown.classList.remove('open');
      }
    });

    this.el.timeframeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const iv = btn.dataset.interval;
        if (iv !== this.currentInterval) {
          this.loadSymbol(this.currentSymbol, iv, this.currentInstrument);
        }
      });
    });

    this.el.indicatorMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.el.indicatorDropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!this.el.indicatorDropdown.contains(e.target) && e.target !== this.el.indicatorMenuBtn) {
        this.el.indicatorDropdown.classList.remove('open');
      }
    });
    this.el.indCheckboxes.forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const key = e.target.dataset.indicatorToggle;
        if (key === 'volume') this.chart.showVolume = e.target.checked;
        if (key === 'macd') this.chart.showMACD = e.target.checked;
        if (key === 'ema') {
          this.showEMA = e.target.checked;
          if (this.showEMA && !this.emaPeriods.length) this.emaPeriods = [5, 10, 20];
          this._persistAndApplyEma();
          return;
        }
        if (key === 'boll') this.chart.showBoll = e.target.checked;
        if (key === 'luxsr') this.chart.showLuxSR = e.target.checked;
        this.chart.render();
        const last = this.chart.candles[this.chart.candles.length - 1];
        const prev = this.chart.candles[this.chart.candles.length - 2] || last;
        this._updateOHLCVHud(last, prev?.close, this.chart.candles.length - 1);
      });
    });

    this.el.emaPickerPanel?.addEventListener('click', (e) => e.stopPropagation());
    this.el.emaPeriodGrid?.querySelectorAll('[data-ema-period]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleEmaPeriod(btn.dataset.emaPeriod);
      });
    });
    this.el.btnAddCustomEma?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._addCustomEmaPeriod();
    });
    this.el.customEmaInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this._addCustomEmaPeriod();
      }
    });

    this.el.btnAiAnnotateNow.addEventListener('click', () => {
      const U = getLangPack(this.uiLang).ui;
      this._submitPrompt(
        `${U.qp6PromptPrefix}${this.currentInstrument?.displaySymbol || this.currentSymbol}${U.qp6PromptSuffix}`
      );
    });

    this.el.langSelect?.addEventListener('change', (e) => {
      const lang = e.target.value;
      this._applyLanguage(lang, lang);
    });

    this.el.chartLangSelect?.addEventListener('change', (e) => {
      const nextChartLang = e.target.value;
      this._applyLanguage(this.uiLang, nextChartLang);
    });

    this.el.btnExportPine.addEventListener('click', () => this.openPineModal());
    this.el.btnClosePine.addEventListener('click', () => this.el.pineModal.classList.remove('open'));
    this.el.pineModal.addEventListener('click', (e) => {
      if (e.target === this.el.pineModal) this.el.pineModal.classList.remove('open');
    });
    this.el.btnCopyPine.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.el.pineCodeArea.value);
        this.el.btnCopyPine.textContent = '✓';
        setTimeout(() => { this.el.btnCopyPine.textContent = getLangPack(this.uiLang).ui.copyPine; }, 1600);
      } catch {
        this.el.pineCodeArea.select();
        document.execCommand('copy');
      }
    });

    this.el.btnThemeToggle.addEventListener('click', () => {
      this._applyTheme(this.theme === 'light' ? 'dark' : 'light');
    });

    this.el.btnToggleAiLayer.addEventListener('click', () => {
      this.chart.showAIAnnotations = !this.chart.showAIAnnotations;
      this.el.btnToggleAiLayer.classList.toggle('active', this.chart.showAIAnnotations);
      this.chart.render();
    });

    this.el.btnQuickSnapshot.addEventListener('click', () => {
      if (!this.chart.candles.length) return;
      const snap = this.chart.captureSnapshot({ includeCurrentAI: false });
      this.studio.open(
        snap,
        this.chart.aiAnnotations,
        {
          bias: this.copilot.lastResult?.meta?.bias || 'neutral',
          confidence: this.copilot.lastResult?.meta?.confidence || '',
          modelLabel: this.copilot.getActiveModelLabel()
        },
        this.chartLang
      );
    });

    this.el.btnClearDrawings.addEventListener('click', () => {
      this.chart.clearAIAnnotations();
      this._hideAiLayerBar();
    });

    this.el.btnZoomIn.addEventListener('click', () => this.chart.zoomBy(1.2));
    this.el.btnZoomOut.addEventListener('click', () => this.chart.zoomBy(0.82));
    this.el.btnZoomReset.addEventListener('click', () => {
      this.chart.fitDefaultZoom();
      this.chart.render();
    });

    this.el.aiLayerChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.aiLayer;
        this.chart.aiLayerFlags[key] = !this.chart.aiLayerFlags[key];
        chip.classList.toggle('active', this.chart.aiLayerFlags[key]);
        this.chart.render();
      });
    });
    this.el.btnClearAiOverlay.addEventListener('click', () => {
      this.chart.clearAIAnnotations();
      this._hideAiLayerBar();
    });

    const toggleCopilot = () => {
      this.el.copilotPane.classList.toggle('collapsed');
      setTimeout(() => this.chart.resize(), 180);
    };
    this.el.btnToggleCopilot.addEventListener('click', toggleCopilot);
    this.el.btnCloseCopilot.addEventListener('click', toggleCopilot);

    let resizing = false;
    this.el.copilotResizer.addEventListener('mousedown', () => {
      resizing = true;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const newW = Math.max(320, Math.min(620, window.innerWidth - e.clientX));
      this.el.copilotPane.style.width = `${newW}px`;
      this.chart.resize();
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });

    this.el.btnNewChat.addEventListener('click', () => this.copilot.clearChat());
    this.el.quickPromptBtns.forEach((btn) => {
      btn.addEventListener('click', () => this._submitPrompt(btn.dataset.quickPrompt));
    });
    this.el.btnSendPrompt.addEventListener('click', () => this._submitPrompt());
    this.el.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._submitPrompt();
      }
    });
    this.el.promptInput.addEventListener('input', () => {
      this.el.promptInput.style.height = 'auto';
      this.el.promptInput.style.height = Math.min(110, this.el.promptInput.scrollHeight) + 'px';
    });

    this.el.btnApiSettings.addEventListener('click', () => this.openSettingsModal());
    this.el.btnCopilotSettings.addEventListener('click', () => this.openSettingsModal());
    this.el.modelSwitcherBtn.addEventListener('click', () => this.openSettingsModal());
    this.el.btnCloseSettings.addEventListener('click', () => this.el.settingsModal.classList.remove('open'));
    this.el.settingsModal.addEventListener('click', (e) => {
      if (e.target === this.el.settingsModal) this.el.settingsModal.classList.remove('open');
    });

    this.el.presetBtns.forEach((btn) => {
      btn.addEventListener('click', () => this._selectProviderPreset(btn.dataset.providerPreset, true));
    });

    this.el.btnToggleKeyVis.addEventListener('click', () => {
      const isPwd = this.el.inputApiKey.type === 'password';
      this.el.inputApiKey.type = isPwd ? 'text' : 'password';
      this.el.btnToggleKeyVis.textContent = isPwd ? '隐藏' : '显示';
    });

    this.el.btnClearApiKey.addEventListener('click', () => {
      this.el.inputApiKey.value = '';
      this.copilot.updateSettings({ apiKey: '' });
      this._syncSettingsUI();
      this.el.apiTestResult.className = 'api-test-result info';
      this.el.apiTestResult.textContent = '已清除 API Key，当前切回内置量化演示引擎。';
    });

    this.el.btnSaveApiSettings.addEventListener('click', () => {
      const activePresetBtn = document.querySelector('[data-provider-preset].active');
      this.copilot.updateSettings({
        provider: activePresetBtn?.dataset.providerPreset || 'deepseek',
        apiKey: this.el.inputApiKey.value.trim(),
        baseUrl: this.el.inputBaseUrl.value.trim(),
        model: this.el.inputModelName.value.trim() || 'deepseek-chat',
        enableVision: this.el.chkEnableVision.checked
      });
      this._syncSettingsUI();
      this.el.settingsModal.classList.remove('open');
    });

    this.el.btnTestApi.addEventListener('click', async () => {
      const activePresetBtn = document.querySelector('[data-provider-preset].active');
      const activeProvider = activePresetBtn?.dataset.providerPreset || 'deepseek';
      const allowLocal = Boolean(PROVIDER_PRESETS[activeProvider]?.allowLocal);
      const apiKey = this.el.inputApiKey.value.trim();
      const baseUrl = this.el.inputBaseUrl.value.trim();
      const model = this.el.inputModelName.value.trim();
      if (!apiKey && !allowLocal) {
        this.el.apiTestResult.className = 'api-test-result error';
        this.el.apiTestResult.textContent = '请先输入您的 API Key（本地 Ollama 预设可留空）';
        return;
      }

      this.el.btnTestApi.disabled = true;
      this.el.apiTestResult.className = 'api-test-result info';
      this.el.apiTestResult.textContent = '正在测试 API 连通性...';

      try {
        const res = await fetch('/api/ai/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, baseUrl, model, allowLocal })
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        this.el.apiTestResult.className = 'api-test-result success';
        this.el.apiTestResult.textContent = `✓ 连接成功！模型 ${data.model} 响应耗时 ${data.latencyMs}ms`;
      } catch (err) {
        this.el.apiTestResult.className = 'api-test-result error';
        this.el.apiTestResult.textContent = `✕ ${err.message}`;
      } finally {
        this.el.btnTestApi.disabled = false;
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__chartCopilot = new ChartCopilotApp();
});
