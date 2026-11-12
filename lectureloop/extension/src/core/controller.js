// 内容脚本的总控：轮询字幕 → 稳定化 → 翻译 → 悬浮层显示；并负责隐藏网站字幕、预翻译、状态上报。
import { buildSources, readFirst, seekTo, pickVideo } from './sources.js';
import { Recorder } from './recorder.js';
import { videoKeyOf } from './videokey.js';
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
   * @param o.rpc        (type, payload) => Promise  向后台读写转录（tx-get / tx-upsert）
   */
  constructor({ doc = globalThis.document, site, settings, send, saveSettings, report = () => {}, rpc = async () => ({}), timers = undefined }) {
    this.doc = doc; this.site = site; this.settings = settings; this.saveSettings = saveSettings; this.report = report; this.rpc = rpc;
    this.rec = new Recorder(); this.vk = null; this.ready = false; this.curLineId = ''; this.flushTimer = 0; this.loop = null;
    this.cachedHits = 0; this.on = false; this.cur = ''; this.src = null; this.lastSeen = 0; this.error = ''; this.note = ''; this.recent = [];
    this.queue = new TranslateQueue({
      send, onError: (e) => { this.error = e.message || '翻译失败'; this._render(); },
      onOk: (r) => { this.error = ''; this.note = r?.note || ''; if (r?.provider && r.provider !== 'cache') this.provider = r.provider; this.cachedHits += r?.cached || 0; },
      onResult: ({ text, tr }) => { this.rec.attach(text, tr); this._flushSoon(); },
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
    this.clearLoop();
    this._flush();
    this.vk = null; this.ready = false;
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
    if (prev.targets.join() !== s.targets.join()) this._seedFromLines();
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
    this._checkVideo();
    const found = readFirst(this.sources);
    if (found) { this.src = found; this.lastSeen = Date.now(); this.curVideo = found.video || this.curVideo; }
    else if (Date.now() - this.lastSeen > 8000) this.src = null;
    this.overlay.setAnchor(found?.video || this.src?.video || null);
    this.overlay.layout();
    const raw = found?.text || '';
    // 相邻两句之间网站常常会把字幕清空一瞬间：空白持续超过 250ms 才真正隐藏，避免闪烁
    if (!raw && this.cur) { this.emptySince ||= Date.now(); if (Date.now() - this.emptySince < 250) { this._status(); return; } } else this.emptySince = 0;
    const text = this.stab.push(raw, found?.rolling);
    if (text !== this.cur) { this.cur = text; this.curLineId = ''; this._render(); }
    if (this.ready) { this._loadTrack(); if (this.curLineId) this.rec.touch(this.curLineId, this._now()); }
    this._status();
  }

  _translate(text) {
    if (!text) return;
    this._record(text);
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

  // ---------- 转录记录 ----------
  _now() { const v = this.curVideo?.isConnected ? this.curVideo : pickVideo(this.doc); return v ? v.currentTime : 0; }

  /** 视频换了（地址变化：YouTube 自动播放下一个、Netflix 换集）→ 换一份转录，并读出之前保存的 */
  _checkVideo() {
    const loc = this.doc.defaultView?.location;
    if (!loc) return;
    const k = videoKeyOf(loc);
    if (this.vk?.key === k.key) return;
    this.vk = { ...k, title: (this.doc.title || '').trim() };
    this.ready = false; this.curLineId = ''; this.recent = [];
    this.rec.reset(this.vk);
    const key = k.key;
    this.rpc('tx-get', { key }).then((r) => {
      if (this.vk?.key !== key) return; // 读的过程中视频又换了
      if (r?.video?.lines?.length) { this.rec.load(r.video.lines); this._seedFromLines(); }
      this.ready = true;
    }).catch(() => { this.ready = true; });
  }

  /** 已保存的转录里有译文的句子，直接放进翻译缓存：同一个视频再看 / 循环播放时立即显示，不用请求 */
  _seedFromLines() {
    for (const l of this.rec.lines) {
      const { source, targets } = this._lineInfo(l.text);
      if (!targets.length || !targets.every((t) => l.tr?.[t])) continue;
      this.queue.seed(l.text, source, targets, Object.fromEntries(targets.map((t) => [t, l.tr[t]])));
    }
    this._render();
  }

  /** 字幕轨道整条载入：一次性把全部句子放进转录（侧边栏立刻能看到整部剧） */
  _loadTrack() {
    const all = this.sources?.textTrack.allCues?.();
    if (!all || all.sig === this.rec.loadedTrack) return;
    this.rec.loadedTrack = all.sig;
    this.rec.loadAll(all.cues, all.lang);
    this._seedFromLines();
    this._flushSoon();
  }

  /** 一句稳定下来：记进转录，并记下它的 id（侧边栏据此高亮当前句） */
  _record(text) {
    if (!this.vk) return;
    const lang = this.src?.lang || this._lineInfo(text).source;
    this.curLineId = this.rec.observe(text, Math.max(0, this._now() - 0.15), lang);
    this._flushSoon();
  }

  _flushSoon() { if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flush(), 2000); }
  _flush() {
    clearTimeout(this.flushTimer); this.flushTimer = 0;
    if (!this.vk || !this.rec.hasDirty) return;
    const lines = this.rec.take();
    const meta = { key: this.vk.key, site: this.vk.site, url: this.vk.url, title: (this.doc.title || '').trim() || this.vk.title, lang: this.src?.lang || lines[0]?.lang || null };
    this.rpc('tx-upsert', { video: meta, lines }).catch(() => {});
  }

  // ---------- 侧边栏的指令 ----------
  seek(t, play) { return seekTo(this.doc, t, play); }
  /** 循环播放 [start,end]：用 requestAnimationFrame 盯着播放位置（timeupdate 一秒才 4 次，会冲过头） */
  setLoop(start, end) {
    this.clearLoop();
    const v = pickVideo(this.doc);
    if (!v) return false;
    const s = Math.max(0, start), e = Math.max(end, s + 1.5);
    this.loop = { s, e, raf: 0 };
    const win = this.doc.defaultView;
    const step = () => {
      if (!this.loop) return;
      if (v.currentTime >= e - 0.03 || v.currentTime < s - 0.6) { v.currentTime = s; if (v.paused) v.play?.().catch(() => {}); }
      this.loop.raf = win.requestAnimationFrame(step);
    };
    v.currentTime = s; v.play?.().catch(() => {});
    step();
    return true;
  }
  clearLoop() { if (this.loop) { this.doc.defaultView?.cancelAnimationFrame(this.loop.raf); this.loop = null; } }

  /** 把转录里还没有译文的句子全部排进翻译队列（低优先级，不挡当前这句）。返回排了多少句 */
  translateAll() {
    let n = 0;
    const lines = this.rec.lines;
    lines.forEach((l, i) => {
      const { source, targets } = this._lineInfo(l.text);
      if (!targets.length || targets.every((t) => l.tr?.[t])) return;
      n++;
      this.queue.translate(l.text, { source, targets, context: lines[i - 1] ? [lines[i - 1].text] : [], prio: 'bg' });
    });
    return n;
  }

  _status() {
    const s = {
      on: this.on, site: this.site,
      source: this.src ? { id: this.src.id, label: this.src.label, lang: this.src.lang } : null,
      translated: this.queue.stats.ok, failed: this.queue.stats.failed, cached: this.cachedHits,
      error: this.error, note: this.note, provider: this.provider || '',
      video: this.vk ? { key: this.vk.key, title: this.vk.title, lineId: this.curLineId, n: this.rec.lines.length } : null,
    };
    const j = JSON.stringify(s);
    if (j !== this.lastStatus) { this.lastStatus = j; this.report(s); }
  }
}
