const DAYS_ID = ['MINGGU', 'SENIN', 'SELASA', 'RABU', 'KAMIS', 'JUMAT', 'SABTU'];
const MONTHS_SHORT = [
  'JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN',
  'JUL', 'AGU', 'SEP', 'OKT', 'NOV', 'DES',
];

export class MinimalClock {
  constructor(regionEl, timeEl, dateEl) {
    this.regionEl = regionEl;
    this.timeEl = timeEl;
    this.dateEl = dateEl;
    this.hourEl = timeEl?.querySelector('.clock-hour') || null;
    this.minEl = timeEl?.querySelector('.clock-min') || null;
    this._style = 'editorial';
    this._lastTimeKey = '';
    this._lastDateKey = '';
    this._timer = null;
  }

  setStyle(style) {
    const next = ['editorial', 'stacked', 'minimal'].includes(style) ? style : 'editorial';
    this._style = next;
    if (this.regionEl) {
      this.regionEl.dataset.clockStyle = next;
    }
  }

  start() {
    this.update();
    this._timer = setInterval(() => this.update(), 1000);
  }

  update() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const timeKey = `${hh}:${mm}`;

    if (timeKey !== this._lastTimeKey) {
      this._lastTimeKey = timeKey;
      if (this.hourEl && this.minEl) {
        this.hourEl.textContent = hh;
        this.minEl.textContent = mm;
      } else if (this.timeEl) {
        this.timeEl.textContent = timeKey;
      }
      this.timeEl?.setAttribute('datetime', timeKey);
    }

    const day = DAYS_ID[now.getDay()];
    const date = now.getDate();
    const month = MONTHS_SHORT[now.getMonth()];
    const dateText = `${day} • ${date} ${month}`;
    if (dateText !== this._lastDateKey && this.dateEl) {
      this._lastDateKey = dateText;
      this.dateEl.textContent = dateText;
    }
  }

  destroy() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
