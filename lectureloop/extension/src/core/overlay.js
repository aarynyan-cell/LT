// 悬浮字幕层：Shadow DOM（不受网页样式影响，也不影响网页），定位在视频画面上，全屏时挂到全屏元素里。
// 字幕文字全部用 textContent 写入——字幕来自网页，一律当作不可信文本。
const CSS = `
:host{all:initial}
.stage{position:fixed;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.box{position:absolute;transform:translate(-50%,-100%);width:max-content;max-width:82%;min-width:20px;text-align:center;color:#fff;border-radius:10px;padding:.3em .7em .35em;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;line-height:1.35;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 6px rgba(0,0,0,.6)}
.box.drag{cursor:grabbing}
.o{font-size:.78em;opacity:.82;margin-bottom:.12em}
.t{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.t.t2{color:#ffe08a;font-size:.92em;font-weight:500}
.ctl{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);display:none;gap:2px;padding:2px;border-radius:8px;background:rgba(20,22,28,.92);font-size:13px;white-space:nowrap;text-shadow:none}
.box:hover .ctl,.box:focus-within .ctl{display:flex}
.ctl button{all:unset;cursor:pointer;color:#fff;padding:3px 8px;border-radius:6px;font:600 12px/1.2 system-ui,sans-serif}
.ctl button:hover,.ctl button:focus-visible{background:rgba(255,255,255,.2)}
.ctl button.on{background:#3b5bdb}
.warn{position:absolute;right:-6px;top:-6px;width:16px;height:16px;border-radius:50%;background:#e03131;color:#fff;font:700 11px/16px system-ui;text-align:center;display:none;cursor:help}
.box.err .warn{display:block}
`;

export class Overlay {
  /** onChange(patch)：用户在悬浮层上的操作（拖动 / 字号 / 显示原文 / 关闭）；patch 为设置补丁，或 { off: true } */
  constructor({ doc = document, onChange = () => {} } = {}) {
    this.doc = doc; this.onChange = onChange;
    this.host = doc.createElement('lectureloop-subtitles');
    this.host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style'); style.textContent = CSS;
    this.stage = doc.createElement('div'); this.stage.className = 'stage';
    this.box = doc.createElement('div'); this.box.className = 'box'; this.box.hidden = true;
    this.ctl = doc.createElement('div'); this.ctl.className = 'ctl';
    this.btn = {};
    for (const [k, label, title] of [['dec', 'A−', '缩小字号'], ['inc', 'A＋', '放大字号'], ['orig', '原', '同时显示原文'], ['off', '✕', '关闭字幕翻译（Alt+T 再次开启）']]) {
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
      b.dataset.k = k; this.btn[k] = b; this.ctl.append(b);
    }
    this.warn = doc.createElement('div'); this.warn.className = 'warn'; this.warn.textContent = '!';
    this.o = doc.createElement('div'); this.o.className = 'o';
    this.t1 = doc.createElement('div'); this.t1.className = 't t1';
    this.t2 = doc.createElement('div'); this.t2.className = 't t2';
    this.box.append(this.ctl, this.warn, this.o, this.t1, this.t2);
    this.stage.append(this.box);
    this.root.append(style, this.stage);
    this.opts = { fontScale: 1, bg: 0.55, showOrig: false, hideSite: false, pos: null };
    this.anchor = null; this.rect = { left: 0, top: 0, width: 800, height: 450 };
    this._bind();
    this.mount();
    this._fs = () => this.mount();
    doc.addEventListener('fullscreenchange', this._fs);
    doc.addEventListener('webkitfullscreenchange', this._fs);
  }

  /** 挂载点：全屏时必须在全屏元素里，否则看不见 */
  mount() {
    const fs = this.doc.fullscreenElement || this.doc.webkitFullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : this.doc.documentElement;
    if (this.host.parentNode !== parent) parent.append(this.host);
    this.layout();
  }

  _bind() {
    this.ctl.addEventListener('click', (e) => {
      const k = e.target?.dataset?.k;
      if (!k) return;
      e.stopPropagation();
      if (k === 'dec') this.onChange({ fontScale: Math.max(0.5, +(this.opts.fontScale - 0.1).toFixed(2)) });
      else if (k === 'inc') this.onChange({ fontScale: Math.min(2.5, +(this.opts.fontScale + 0.1).toFixed(2)) });
      else if (k === 'orig') this.onChange({ showOrig: !this.opts.showOrig });
      else if (k === 'off') this.onChange({ off: true });
    });
    let drag = null;
    this.box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ctl') || e.button !== 0) return;
      const r = this.box.getBoundingClientRect();
      drag = { dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - r.bottom };
      this.box.setPointerCapture(e.pointerId);
      this.box.classList.add('drag');
    });
    this.box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const cx = (e.clientX - drag.dx - this.rect.left) / this.rect.width, by = (e.clientY - drag.dy - this.rect.top) / this.rect.height;
      this.opts.pos = { cx: Math.min(1, Math.max(0, cx)), by: Math.min(1, Math.max(0.05, by)) };
      this._place();
    });
    const end = () => { if (!drag) return; drag = null; this.box.classList.remove('drag'); if (this.opts.pos) this.onChange({ pos: this.opts.pos }); };
    this.box.addEventListener('pointerup', end);
    this.box.addEventListener('pointercancel', end);
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; this.btn.orig.classList.toggle('on', !!this.opts.showOrig || !!this.opts.hideSite); this._style(); this._place(); }
  setAnchor(video) { this.anchor = video || null; this.layout(); }

  /** 跟随视频的位置与大小 */
  layout() {
    const w = this.doc.defaultView;
    const r = this.anchor?.isConnected ? this.anchor.getBoundingClientRect() : { left: 0, top: 0, width: w.innerWidth, height: w.innerHeight };
    const next = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
    const same = ['left', 'top', 'width', 'height'].every((k) => Math.abs(next[k] - this.rect[k]) < 0.5);
    this.rect = next;
    if (!same || !this.stage.style.width) {
      Object.assign(this.stage.style, { left: next.left + 'px', top: next.top + 'px', width: next.width + 'px', height: next.height + 'px' });
      this._style(); this._place();
    }
  }
  _style() {
    const fs = Math.max(13, this.rect.height * 0.045 * this.opts.fontScale);
    this.box.style.fontSize = fs + 'px';
    this.box.style.background = `rgba(0,0,0,${this.opts.bg})`;
  }
  _place() {
    const p = this.opts.pos || { cx: 0.5, by: this.opts.hideSite ? 0.93 : 0.8 };
    this.box.style.left = p.cx * 100 + '%';
    this.box.style.top = p.by * 100 + '%';
  }

  /** orig：原文；tr：{ [lang]: 译文 }；targets：显示顺序；error：翻译出错时的提示 */
  show({ orig = '', tr = {}, targets = [], error = '', forceOrig = false }) {
    const texts = targets.map((t) => tr[t]).filter(Boolean);
    // 翻译失败又没有译文时，至少把原文显示出来，并亮起红色感叹号，免得用户对着空白不知道发生了什么
    const showO = (this.opts.showOrig || this.opts.hideSite || forceOrig || (!!error && !texts.length)) && !!orig;
    this.o.textContent = showO ? orig : ''; this.o.hidden = !showO;
    this.t1.textContent = texts[0] || ''; this.t1.hidden = !texts[0];
    this.t2.textContent = texts[1] || ''; this.t2.hidden = !texts[1];
    this.box.hidden = !(showO || texts.length > 0);
    this.box.classList.toggle('err', !!error);
    this.warn.title = error || '';
  }
  hide() { this.box.hidden = true; }
  get visible() { return !this.box.hidden; }

  destroy() {
    this.doc.removeEventListener('fullscreenchange', this._fs);
    this.doc.removeEventListener('webkitfullscreenchange', this._fs);
    this.host.remove();
  }
}
