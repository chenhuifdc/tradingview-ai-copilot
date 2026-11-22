/**
 * Symbol Search Modal Controller (Global Stocks, India NSE/BSE, Korea KRX, Crypto, Forex)
 * Strictly uses textContent for all dynamic symbol/name rendering (XSS-safe).
 */

import { escapeHtml } from './sanitize.js';

export class SymbolSearchModal {
  constructor(modalEl, { onSelect } = {}) {
    this.modal = modalEl;
    this.input = modalEl.querySelector('#symbolSearchInput');
    this.closeBtn = modalEl.querySelector('#symbolSearchClose');
    this.resultsEl = modalEl.querySelector('#symbolSearchResults');
    this.statusEl = modalEl.querySelector('#symbolSearchStatus');
    this.tabs = modalEl.querySelectorAll('[data-market-tab]');
    this.onSelect = onSelect || (() => {});

    this.activeMarket = 'all';
    this.items = [];
    this.activeIdx = 0;
    this.abortCtrl = null;
    this.debounceTimer = null;

    this._bind();
  }

  open(prefill = '') {
    this.modal.classList.add('open');
    this.input.value = prefill;
    setTimeout(() => this.input.focus(), 40);
    this.search(prefill);
  }

  close() {
    this.modal.classList.remove('open');
  }

  async search(query) {
    if (this.abortCtrl) this.abortCtrl.abort();
    this.abortCtrl = new AbortController();
    this.statusEl.textContent = '搜索中...';

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&market=${encodeURIComponent(this.activeMarket)}`,
        { signal: this.abortCtrl.signal }
      );
      const data = await res.json();
      this.items = data.results || [];
      this.activeIdx = 0;
      this.statusEl.textContent = data.remoteOnline
        ? `已连接全球行情搜索 · 找到 ${this.items.length} 个标的`
        : `离线内置代码库 · 找到 ${this.items.length} 个标的（可直接输入任意代码加载）`;
      this.render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.statusEl.textContent = '搜索服务暂时不可用';
    }
  }

  render() {
    this.resultsEl.textContent = '';
    if (!this.items.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = '未找到匹配标的。请尝试输入股票代码（如 RELIANCE.NS、005930.KS、ALKALI.NS、AAPL、BTCUSDT）或名称。';
      this.resultsEl.appendChild(empty);
      return;
    }

    const marketBadge = {
      us: '美股',
      in: '印股 NSE/BSE',
      kr: '韩股 KRX',
      hk: '港股',
      cn: 'A股',
      crypto: '加密货币',
      forex: '外汇/商品'
    };

    const fragment = document.createDocumentFragment();

    this.items.forEach((item, idx) => {
      const badge = marketBadge[item.market] || item.type || '证券';
      const subParts = [];
      if (item.koName && item.koName !== item.name) subParts.push(item.koName);
      if (item.enName && item.enName !== item.name && item.enName !== item.koName) subParts.push(item.enName);
      const subText = subParts.join(' · ');

      const row = document.createElement('div');
      row.className = `search-item${idx === this.activeIdx ? ' active' : ''}`;
      row.dataset.idx = String(idx);

      const left = document.createElement('div');
      left.className = 'search-item-left';
      const symEl = document.createElement('span');
      symEl.className = 'search-sym';
      symEl.textContent = String(item.displaySymbol || item.symbol || '');
      const nameEl = document.createElement('span');
      nameEl.className = 'search-name';
      nameEl.textContent = String(item.name || item.enName || '');
      left.append(symEl, nameEl);
      if (subText) {
        const subEl = document.createElement('span');
        subEl.className = 'search-en';
        subEl.textContent = subText;
        left.appendChild(subEl);
      }

      const right = document.createElement('div');
      right.className = 'search-item-right';
      const pill = document.createElement('span');
      pill.className = 'search-type-pill';
      pill.textContent = String(badge);
      const exch = document.createElement('span');
      exch.className = 'search-exchange';
      exch.textContent = String(item.exchange || '');
      right.append(pill, exch);

      row.append(left, right);
      row.addEventListener('click', () => {
        const picked = this.items[idx];
        if (picked) {
          this.close();
          this.onSelect(picked);
        }
      });
      row.addEventListener('mouseenter', () => {
        this.activeIdx = idx;
        this._updateActiveHighlight();
      });
      fragment.appendChild(row);
    });

    this.resultsEl.appendChild(fragment);
  }

  _updateActiveHighlight() {
    this.resultsEl.querySelectorAll('.search-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === this.activeIdx);
    });
  }

  _escape(str) {
    return escapeHtml(str);
  }

  _bind() {
    this.closeBtn.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });

    this.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        this.tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeMarket = tab.dataset.marketTab;
        this.search(this.input.value.trim());
      });
    });

    this.input.addEventListener('input', () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.search(this.input.value.trim());
      }, 150);
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.items.length) {
          this.activeIdx = (this.activeIdx + 1) % this.items.length;
          this._updateActiveHighlight();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.items.length) {
          this.activeIdx = (this.activeIdx - 1 + this.items.length) % this.items.length;
          this._updateActiveHighlight();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const picked = this.items[this.activeIdx];
        if (picked) {
          this.close();
          this.onSelect(picked);
        } else if (this.input.value.trim()) {
          const raw = this.input.value.trim().toUpperCase();
          this.close();
          this.onSelect({ symbol: raw, displaySymbol: raw, name: raw, exchange: '' });
        }
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
  }
}
