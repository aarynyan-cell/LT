// 内容脚本的总控：轮询字幕 → 稳定化 → 翻译 → 悬浮层显示；并负责隐藏网站字幕、预翻译、状态上报。
import { buildSources, readFirst } from './sources.js';
import { Stabilizer } from './stabilizer.js';
import { TranslateQueue } from './translator.js';
import { Overlay } from './overlay.js';
import { detectLang } from './langs.js';

const TICK_MS = 150;
const PREFETCH_MS = 1500;

export class Controller {
  /**
   * @param o.send       (req) => Promise<result>   翻译请求（发给 background，或在页面里用 Chrome 内置翻译）
   * @param o.saveSettings (patch) => void           悬浮层里的操作要写回设置
   * @param o.report     (status) => void            把状态报告给弹窗
   */
  constructor({ doc = globalThis.document, site, settings, send, saveSettings, report = () => {}, timers = undefined }) {
    this.doc = doc; this.site = site; this.settings = settings; this.saveSettings = saveSettings; this.report = report;
    this.on = false; this.cur = ''; this.src = null; this.lastSeen = 0; this.error = ''; this.note = ''; this.recent = [];
    this.queue = new TranslateQueue({
      send, onError: (e) => { this.error = e.message || '翻译失败'; this._render(); },
      onOk: (r) => { this.error = ''; this.note = r?.note || ''; this.provider = r?.provider || this.provider; },
    });
    this.stab = new Stabilizer({ onSettle: (t) => this._translate(t), ...(timers ? { timers } : {}) });
    this.overlay = null; this.styleEl = null; this.sources = null;
    this.prefetched = new Set(); this.lastStatus = '';
  }

  start() {
    if (this.on) return;
    this.on = true;
    this.overlay = new Overlay({ doc: this.doc, onChange: (p) => this._onOverlay(p) });
    this._rebuild();
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this.pf = setInterval(() => this._prefetch(), PREFETCH_MS);
    this._tick();
  }
  stop() {
    if (!this.on) return;
    this.on = false;
    clearInterval(this.timer); clearInterval(this.pf);
    this.stab.clear();
    this.sources?.textTrack.restore();
    this.styleEl?.remove(); this.styleEl = null;
    this.overlay?.destroy(); this.overlay = null;
    this.cur = ''; this.src = null;
    this._status();
  }

  setSettings(s) {
    const prev = this.settings;
    this.settings = s;
    if (!this.on) return;
    const srcChanged = prev.source !== s.source || prev.hideSite !== s.hideSite || JSON.stringify(prev.pickers) !== JSON.stringify(s.pickers) || prev.targets.join() !== s.targets.join();
    if (srcChanged) { this.sources?.textTrack.restore(); this._rebuild(); this.prefetched.clear(); }
    this.overlay.setOptions(this._ov());
    if (prev.targets.join() !== s.targets.join() || prev.source !== s.source || prev.engine !== s.engine) { this.queue.clear(); if (this.cur) this._translate(this.cur); }
    this._render();
  }

  _ov() { const s = this.settings; return { fontScale: s.fontScale, bg: s.bg, showOrig: s.showOrig, hideSite: s.hideSite, pos: s.pos }; }

  _rebuild() {
    this.sources = buildSources(this.doc, this.settings, this.site);
    this.overlay.setOptions(this._ov());
    // 隐藏网站自带字幕：给已知字幕容器加 visibility:hidden（文字仍在 DOM 里，我们继续读取）
    this.styleEl?.remove(); this.styleEl = null;
    if (this.settings.hideSite && this.sources.hideSelectors.length) {
      this.styleEl = this.doc.createElement('style');
      this.styleEl.textContent = `${this.sources.hideSelectors.join(',')}{visibility:hidden!important}`;
      (this.doc.head || this.doc.documentElement).append(this.styleEl);
    }
  }

  _onOverlay(p) {
    if (p.off) { this.stop(); this.report({ on: false, closedByUser: true }); return; }
    this.saveSettings(p);
    this.settings = { ...this.settings, ...p };
    this.overlay.setOptions(this._ov());
  }

  /**
   * 这一句的翻译参数：{ source, targets }。
   *  · 用户指定了字幕语言 → 用它；
   *  · 自动：中文可以靠文字本身可靠判断；其它优先用来源给出的语言（字幕轨道的 srclang），没有再用逐句判断。
   *  · 明显已经是目标语言的句子（自动模式下的逐句判断）不再翻译成该语言。
   */
  _lineInfo(text) {
    const set = this.settings.source, det = detectLang(text);
    const hint = ['zh', 'en', 'fr'].includes(this.src?.lang) ? this.src.lang : null;
    const source = set !== 'auto' ? set : det === 'zh' ? 'zh' : hint || det || 'auto';
    let targets = this.settings.targets.filter((t) => t !== source);
    if (set === 'auto' && det) targets = targets.filter((t) => t !== det);
    return { source, targets };
  }

  _tick() {
    if (!this.on || this.doc.hidden) return;
    const found = readFirst(this.sources);
    if (found) { this.src = found; this.lastSeen = Date.now(); }
    else if (Date.now() - this.lastSeen > 8000) this.src = null;
    this.overlay.setAnchor(found?.video || this.src?.video || null);
    this.overlay.layout();
    const raw = found?.text || '';
    // 相邻两句之间网站常常会把字幕清空一瞬间：空白持续超过 250ms 才真正隐藏，避免闪烁
    if (!raw && this.cur) { this.emptySince ||= Date.now(); if (Date.now() - this.emptySince < 250) { this._status(); return; } } else this.emptySince = 0;
    const text = this.stab.push(raw, found?.rolling);
    if (text !== this.cur) { this.cur = text; this._render(); }
    this._status();
  }

  _translate(text) {
    if (!text) return;
    const { source, targets } = this._lineInfo(text);
    if (!targets.length) return;
    this.queue.translate(text, { source, targets, context: this.recent.slice(-3), prio: 'live' }).then(() => { if (this.cur === text) this._render(); });
    if (this.recent.at(-1) !== text) { this.recent.push(text); if (this.recent.length > 6) this.recent.shift(); }
  }

  _render() {
    if (!this.overlay) return;
    const text = this.cur;
    if (!text) { this.overlay.hide(); return; }
    const { source, targets } = this._lineInfo(text);
    const tr = targets.length ? this.queue.peek(text, source, targets) || {} : {};
    this.overlay.show({ orig: text, tr, targets: this.settings.targets, error: this.error });
  }

  /** 视频字幕轨道整条载入时，提前翻译接下来约 90 秒的字幕，播放到时译文已经在缓存里 */
  _prefetch() {
    if (!this.on || this.doc.hidden || this.src?.id !== 'texttrack') return;
    const up = this.sources.textTrack.upcoming(24, 90);
    for (const c of up) {
      const { source, targets } = this._lineInfo(c.text);
      if (!targets.length) continue;
      const k = this.queue.key(c.text, source, targets);
      if (this.prefetched.has(k) || this.queue.peek(c.text, source, targets)) continue;
      this.prefetched.add(k);
      this.queue.translate(c.text, { source, targets, context: c.prev ? [c.prev] : [], prio: 'bg' });
    }
  }

  _status() {
    const s = {
      on: this.on, site: this.site,
      source: this.src ? { id: this.src.id, label: this.src.label, lang: this.src.lang } : null,
      translated: this.queue.stats.ok, failed: this.queue.stats.failed,
      error: this.error, note: this.note, provider: this.provider || '',
    };
    const j = JSON.stringify(s);
    if (j !== this.lastStatus) { this.lastStatus = j; this.report(s); }
  }
}
