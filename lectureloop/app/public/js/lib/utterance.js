// 话语跟踪器：把 Web Speech 的"临时/定稿"结果流变成带可靠时间的字幕句子。纯逻辑（不碰 DOM/定时器），可用模拟事件测试。
//
// 为什么需要：Chrome 连续识别时，有时会把还没定稿的临时字幕直接换成下一句，而不触发 isFinal。
// 只在"定稿"时才保存句子的话，那一句就永远丢了；而且"第一次出现临时字幕的时刻"被当成句子开始时间，
// 被丢掉的杂音/半句会让开始时间一直停在很早之前，导致时间轴与转写内容对不上。
//
// 做法：
//  1. 记录当前"假设"（pending）：文本、开始时间（该假设第一次出现）、最后更新时间。
//  2. 新的临时结果如果不是对旧假设的修订（前几个词不同、旧词大部分消失），说明引擎丢弃了旧假设：
//     先把旧假设保存成一句（provisional），再开始新的假设。
//  3. 被识别结束 / 暂停 / 停止打断时（flush），同样保存当前假设。
//  4. 保存时校正时间：结束时间用"最后一次更新"而不是"定稿到达"；时长不合理（语速低于 1.2 词/秒）时，
//     说明开始时间是陈旧的，把开始时间推迟到 结束 - 词数/1.2。
//  5. 之前保存的 provisional 句子，如果随后到来的定稿与它高度相似（引擎其实只是改写），就替换它，避免重复。
import { splitSentences, chunkSentences, units } from './text.js';

const MIN_WPS = 1.2;   // 低于这个语速，说明时间跨度里混进了没有文字的部分
const MAX_WPS = 6;     // 高于这个语速不现实
const MIN_WORDS_TO_KEEP = 3; // 太短的被丢弃假设多半是噪音，不保存
const FINAL_LAG = 1.2;       // 定稿通常比说完晚到约 1 秒

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** 新的临时文本是不是对旧假设的"修订/延长"（而不是另一句话） */
export function isRevision(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return true;
  const n = Math.min(4, x.length, y.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (x[i] === y[i]) same++;
  if (same >= Math.ceil(n * 0.5)) return true;
  if (x.length < 4) return false; // 很短的旧假设（"the" / "so now"）碰巧有词出现在新句里不能说明什么：只按前缀判断
  const set = new Set(y);
  return x.filter((w) => set.has(w)).length / x.length >= 0.6; // 中间被改写，但旧词大部分还在
}

export function similarity(a, b) {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export class UtteranceTracker {
  /** @param {{onInterim:(t:string)=>void, onFinal:(c:{start:number,end:number,text:string,provisional?:boolean,replace?:boolean})=>void}} o */
  constructor({ onInterim, onFinal }) {
    this.onInterim = onInterim; this.onFinal = onFinal;
    this.pending = null;   // { text, start, last }
    this.prov = null;      // 最近一次 provisional 保存：{ text, t }
    this.lastEnd = 0;
  }

  /** items：本次事件里从 resultIndex 开始的结果 [{text, final}]；t：当前录音时间（秒） */
  feed(items, t) {
    let interim = '';
    for (const it of items) {
      const text = String(it.text || '').trim();
      if (!text) continue;
      if (it.final) this._final(text, t);
      else interim += (interim ? ' ' : '') + text;
    }
    interim = interim.trim();
    if (interim) {
      if (this.pending && !isRevision(this.pending.text, interim)) this._commit(true); // 引擎换成了另一句：先保存旧的
      if (!this.pending) this.pending = { text: interim, start: t, last: t };
      else { this.pending.text = interim; this.pending.last = t; }
      this.onInterim(interim);
    } else {
      this.onInterim('');
    }
  }

  /** 识别被结束 / 暂停 / 停止时：保存还没定稿的假设 */
  flush() {
    if (this.pending) this._commit(true);
    this.onInterim('');
  }

  _final(text, t) {
    const p = this.pending;
    this.pending = null;
    const replace = !!(this.prov && t - this.prov.t < 10 && similarity(this.prov.text, text) >= 0.5);
    this.prov = null;
    // 结束时间：定稿通常在说完后约 1 秒内到达，而"最后一次临时更新"在假设只更新过一次时会偏早，所以取两者中较晚的
    const end = p ? Math.max(p.last, t - FINAL_LAG) : t;
    this._emit(text, p ? p.start : null, end, { replace });
  }

  _commit(provisional) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.onInterim('');
    if (units(p.text) < MIN_WORDS_TO_KEEP) return; // 噪音
    this.prov = { text: p.text, t: p.last };
    this._emit(p.text, p.start, p.last, { provisional });
  }

  /** 生成一句或几句，并校正时间 */
  _emit(text, start, end, flags) {
    const u = units(text);
    if (start == null) start = end - u / 2.5;
    // 时长不合理：语速太低 → 开始时间是陈旧的（混进了没有文字的部分）；太高 → 结束时间太早
    if (end - start > u / MIN_WPS) start = end - u / MIN_WPS;
    if (end - start < u / MAX_WPS) start = Math.max(0, end - u / MAX_WPS);
    if (!flags.replace && start < this.lastEnd && this.lastEnd < end - 0.3) start = this.lastEnd; // 不早于上一句的结束
    const pieces = chunkSentences(splitSentences(text), { minWords: 3, maxWords: 40 });
    const total = pieces.reduce((s, p) => s + units(p), 0) || 1;
    let at = start;
    pieces.forEach((p, k) => {
      const dur = ((end - start) * units(p)) / total;
      const last = k === pieces.length - 1;
      this.onFinal({ start: at, end: last ? end : at + dur, text: p, ...(flags.provisional ? { provisional: true } : {}), ...(flags.replace && k === 0 ? { replace: true } : {}) });
      at += dur;
    });
    this.lastEnd = end;
  }
}
