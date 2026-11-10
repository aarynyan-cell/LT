// 话语跟踪器：把 Web Speech 的"临时/定稿"结果流变成带可靠时间的字幕句子。纯逻辑（不碰 DOM/定时器），可用模拟事件测试。
//
// 要解决的三个问题：
//  A. Chrome 有时把还没定稿的临时字幕直接换成下一句（不触发 isFinal）→ 只在定稿时保存就会丢字。
//  B. "第一次出现临时字幕的时刻"被当成句子开始时间，被丢掉的杂音会让开始时间停在很早之前 → 时间轴对不上。
//  C. 老师连续讲课不停顿时，Chrome 一直在同一条临时字幕后面追加、迟迟不定稿，而且桌面版英语识别没有标点
//     → 大段英文要等很久才出现，翻译更晚。
//
// 做法：
//  1. 记录当前"假设"（pending）：全文、开始时间、最后更新时间，以及已经提前提交的词数（off）。
//  2. 新的临时结果如果不是对旧假设的修订（前几个词不同、旧词大部分消失），说明引擎丢弃了旧假设：先保存旧的，再开始新的。
//  3. 识别结束 / 暂停 / 停止（flush）时同样保存当前假设。
//  4. 【稳定前缀提交】假设还在增长时：剩余词数 ≥ MAX（或停留 ≥ MAX_SEC 秒）就把"除最后 TAIL 个词以外"的部分提交成一句——
//     Chrome 修订的多是末尾几个词，开头基本稳定。提交点优先选在连接词（and/so/but/because/okay…）之前，没有就硬切。
//     之后的临时字幕仍然包含已提交的前缀，所以用词数偏移 off 跳过它。
//  5. 保存时校正时间：结束时间取"最后更新"与"定稿到达-1.2s"中较晚者；语速低于 1.2 词/秒说明开始时间陈旧，把它推迟。
//  6. 之前保存的 provisional 句子，如果随后到来的定稿与它高度相似（引擎其实只是改写），就替换它，避免重复。
import { splitSentences, chunkSentences, units } from './text.js';

const MIN_WPS = 1.2;   // 低于这个语速，说明时间跨度里混进了没有文字的部分
const MAX_WPS = 6;     // 高于这个语速不现实
const MIN_WORDS_TO_KEEP = 3; // 太短的被丢弃假设多半是噪音，不保存
const FINAL_LAG = 1.2;       // 定稿通常比说完晚到约 1 秒

// 稳定前缀提交的参数（词数用于空格分词的语言；中文按字数）
const SP = { max: 16, min: 7, tail: 3 };
const ZH = { max: 32, min: 14, tail: 6 };
const MAX_SEC = 6; // 一段话持续这么久还没提交，就提前提交（只要词数够）

const BOUNDARY = new Set(['and', 'so', 'but', 'because', 'which', 'where', 'then', 'okay', 'ok', 'now', 'if', 'while', 'whereas', 'however', 'also', 'right', 'alright', 'let', "let's", 'next', 'first', 'second', 'finally', 'et', 'mais', 'donc', 'parce', 'alors', 'ensuite', 'maintenant', 'puis']);
const CJK_RE = /[㐀-鿿豈-﫿]/g;

const isCjk = (s) => (s.match(CJK_RE) || []).length > s.replace(/\s+/g, '').length * 0.3;
const tok = (s, cjk) => (cjk ? Array.from(s.replace(/\s+/g, '')) : s.trim().split(/\s+/).filter(Boolean));
const join = (t, cjk) => t.join(cjk ? '' : ' ');
const bare = (w) => w.toLowerCase().replace(/[^\p{L}']/gu, '');
/** 在第 i 个词之前切开是否自然 */
const boundaryBefore = (toks, i, cjk) => (cjk ? /[，。？！；、,.?!;]/.test(toks[i - 1]) : /[,;:.?!]$/.test(toks[i - 1]) || BOUNDARY.has(bare(toks[i])));

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** 新的临时文本是不是对旧假设的"修订/延长"（而不是另一句话） */
export function isRevision(a, b) {
  // 中文没有空格，"词"切分失效：改按字符前缀判断（修订多发生在末尾，开头基本稳定）
  if (isCjk(a) || isCjk(b)) {
    const x = tok(a, true), y = tok(b, true);
    if (!x.length || !y.length) return true;
    const n = Math.min(6, x.length, y.length);
    let same = 0;
    for (let i = 0; i < n; i++) if (x[i] === y[i]) same++;
    return same >= Math.ceil(n * 0.6);
  }
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
  const cjk = isCjk(a) || isCjk(b);
  const x = new Set(cjk ? tok(a, true) : words(a)), y = new Set(cjk ? tok(b, true) : words(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export class UtteranceTracker {
  /** @param {{onInterim:(t:string)=>void, onFinal:(c:{start:number,end:number,text:string,provisional?:boolean,replace?:boolean})=>void}} o */
  constructor({ onInterim, onFinal }) {
    this.onInterim = onInterim; this.onFinal = onFinal;
    this.pending = null;   // { text, start, last, off, segStart }：text 是引擎给出的整段假设；off 是已提前提交的词数；segStart 是未提交部分的开始时间
    this.prov = null;      // 最近一次 provisional 保存：{ text, off, t }
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
      if (!this.pending) this.pending = { text: interim, start: t, last: t, off: 0, segStart: t };
      else { this.pending.text = interim; this.pending.last = t; }
      this._split(t);
      this.onInterim(this._remainder());
    } else {
      this.onInterim('');
    }
  }

  /** 识别被结束 / 暂停 / 停止时：保存还没定稿的假设 */
  flush() {
    if (this.pending) this._commit(true);
    this.onInterim('');
  }

  _remainder() {
    const p = this.pending;
    if (!p) return '';
    const cjk = isCjk(p.text);
    return join(tok(p.text, cjk).slice(p.off), cjk);
  }

  /** 连续说话：假设还在增长时，把稳定的前缀提前提交成一句 */
  _split(t) {
    const p = this.pending;
    const cjk = isCjk(p.text);
    const L = cjk ? ZH : SP;
    const toks = tok(p.text, cjk);
    for (;;) {
      const rest = toks.length - p.off;
      const dur = t - p.segStart;
      if (!(rest >= L.max || (dur >= MAX_SEC && rest >= L.min + L.tail))) return;
      const limit = toks.length - L.tail; // 最后几个词还可能被修订，不提交
      let cut = -1;
      for (let i = limit; i > p.off + L.min; i--) if (boundaryBefore(toks, i, cjk)) { cut = i; break; }
      if (cut < 0) cut = limit;
      if (cut <= p.off) return;
      const end = p.segStart + (dur * (cut - p.off)) / rest; // 按词数比例分配时间
      this._emit(join(toks.slice(p.off, cut), cjk), p.segStart, end, {});
      p.off = cut;
      p.segStart = end;
    }
  }

  _final(text, t) {
    const p = this.pending;
    this.pending = null;
    const replace = !!(this.prov && t - this.prov.t < 10 && similarity(this.prov.text, text) >= 0.5);
    const skip = replace ? this.prov.off : p ? p.off : 0; // 已经提前提交过的词不再重复
    this.prov = null;
    const cjk = isCjk(text);
    const rest = tok(text, cjk).slice(skip);
    if (!rest.length) return;
    // 结束时间：定稿通常在说完后约 1 秒内到达，而"最后一次临时更新"在假设只更新过一次时会偏早，所以取两者中较晚的
    const end = p ? Math.max(p.last, t - FINAL_LAG) : t;
    this._emit(join(rest, cjk), p ? p.segStart : null, end, { replace });
  }

  _commit(provisional) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.onInterim('');
    const cjk = isCjk(p.text);
    const text = join(tok(p.text, cjk).slice(p.off), cjk);
    if (units(text) < MIN_WORDS_TO_KEEP) return; // 噪音 / 只剩一两个尾词
    this.prov = { text: p.text, off: p.off, t: p.last };
    this._emit(text, p.segStart, p.last, { provisional });
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
