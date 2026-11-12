// 翻译队列（内容脚本里用）：缓存 + 去重 + 批量合并。
//  · 当前正在显示的字幕（live）与提前翻译的字幕（bg）各有一个独立的"在途"名额：提前翻译永远不会挡住当前这句；
//  · 在途期间新来的句子合并成下一批（和课堂实时字幕同一套思路）；
//  · 失败不缓存（下次同一句还会重试），并通知调用方显示错误。
export class TranslateQueue {
  /** send({source,targets,items:[{i,t}],context}) → Promise<{provider?,note?,results:{zh:[{i,t}]}}> */
  constructor({ send, maxBatch = 8, bgBatch = 12, cap = 3000, onError, onOk, onResult, now = () => Date.now() }) {
    this.onResult = onResult || (() => {});
    this.send = send; this.maxBatch = maxBatch; this.bgBatch = bgBatch; this.cap = cap;
    this.onError = onError || (() => {}); this.onOk = onOk || (() => {});
    this.now = now;
    this.cache = new Map();
    this.pendingByKey = new Map();
    this.q = { live: [], bg: [] };
    this.running = { live: false, bg: false };
    this.bgPausedUntil = 0;
    this.stats = { ok: 0, failed: 0 };
  }
  key(text, source, targets) { return `${source}|${[...targets].sort().join(',')}|${text}`; }
  peek(text, source, targets) { return this.cache.get(this.key(text, source, targets)); }
  clear() { this.cache.clear(); }
  /** 直接放入一条已知的译文（来自已保存的转录）：这句再出现时立即命中，不请求翻译 */
  seed(text, source, targets, tr) { this._store(this.key(text, source, targets), tr); }

  /** → Promise<{[target]: string}>；失败时得到 {} */
  translate(text, { source = 'auto', targets, context = [], prio = 'live' }) {
    const key = this.key(text, source, targets);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const inflight = this.pendingByKey.get(key);
    if (inflight) {
      if (prio === 'live') this._promote(key); // 之前只是预翻译排队，现在需要立刻用到
      return inflight.promise;
    }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { key, text, source, targets: [...targets], context, resolve, prio, promise };
    this.pendingByKey.set(key, entry);
    this.q[prio].push(entry);
    this._pump();
    return promise;
  }

  _promote(key) {
    const e = this.pendingByKey.get(key);
    if (!e || e.prio === 'live' || e.sent) return;
    const i = this.q.bg.indexOf(e);
    if (i >= 0) { this.q.bg.splice(i, 1); e.prio = 'live'; this.q.live.push(e); this._pump(); }
  }

  _pump() {
    for (const prio of ['live', 'bg']) {
      if (this.running[prio] || !this.q[prio].length) continue;
      if (prio === 'bg' && this.now() < this.bgPausedUntil) continue;
      const first = this.q[prio][0];
      const sig = `${first.source}|${first.targets.join(',')}`;
      const max = prio === 'live' ? this.maxBatch : this.bgBatch;
      const batch = [];
      for (let i = 0; i < this.q[prio].length && batch.length < max; ) {
        const e = this.q[prio][i];
        if (`${e.source}|${e.targets.join(',')}` === sig) { batch.push(e); this.q[prio].splice(i, 1); } else i++;
      }
      this._run(prio, batch);
    }
  }

  async _run(prio, batch) {
    this.running[prio] = true;
    batch.forEach((e) => { e.sent = true; });
    const items = batch.map((e, i) => ({ i, t: e.text }));
    const first = batch[0];
    try {
      const r = await this.send({ source: first.source, targets: first.targets, items, context: first.context });
      const per = batch.map(() => ({}));
      for (const [target, arr] of Object.entries(r?.results || {})) for (const { i, t } of arr || []) if (per[i] && t) per[i][target] = t;
      batch.forEach((e, n) => {
        const out = per[n];
        if (Object.keys(out).length) { this._store(e.key, out); this.stats.ok++; this.onResult({ text: e.text, source: e.source, targets: e.targets, tr: out }); }
        this.pendingByKey.delete(e.key);
        e.resolve(out);
      });
      this.onOk(r);
    } catch (err) {
      this.stats.failed += batch.length;
      batch.forEach((e) => { this.pendingByKey.delete(e.key); e.resolve({}); });
      if (prio === 'bg') this.bgPausedUntil = this.now() + 10_000; // 预翻译失败（多半是限流）：暂停一会儿，别拖累当前字幕
      this.onError(err);
    } finally {
      this.running[prio] = false;
      this._pump();
    }
  }

  _store(key, val) {
    this.cache.set(key, val);
    if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value);
  }
}
