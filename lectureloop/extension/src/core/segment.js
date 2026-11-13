// 断句：把字幕（可能是一个词一个词滚动的自动字幕、没有标点、一句话被切成好几段）整理成完整的句子，
// 每句的开始/结束时间来自词的时间，因此与视频播放进度吻合。纯函数。
const TERMINAL = /[.!?…。！？]["'”’»)\]]*$/;
const COMMA = /[,;:，；：、]["'”’)\]]*$/;
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'm', 'mme', 'mlle', 'mm', 'etc', 'cf', 'no', 'p', 'fig']);
const BOUNDARY = new Set(['and', 'so', 'but', 'because', 'which', 'where', 'then', 'okay', 'ok', 'now', 'if', 'while', 'however', 'also', 'right', 'alright', 'et', 'mais', 'donc', 'parce', 'alors', 'puis', 'maintenant', 'ensuite', 'sinon', 'quand', 'comme', 'car']);
const NOISE = /^(\[[^\]]*\]|\([^)]*\)|♪+|♫+|[-–—]+)$/; // [Music] (applaudissements) ♪
const isCjk = (lang) => lang === 'zh' || lang === 'ja';

const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const wordDur = (w) => Math.min(0.9, 0.12 + 0.065 * [...w].length); // 估计一个词大约要说多久

/** cue 列表 → 词序列 [{ w, t, gap }]：gap = 这个词之前的静音秒数（据此判断停顿） */
export function cuesToWords(cues, lang = 'en') {
  const words = [];
  const cjk = isCjk(lang);
  let prevEnd = null;
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  for (const cue of sorted) {
    let toks;
    if (cue.words?.length) toks = cue.words.map((x) => ({ w: x.w, t: x.t, timed: true }));
    else {
      const parts = cjk ? [...cue.text.replace(/\s+/g, '')] : cue.text.split(/\s+/).filter(Boolean);
      const total = parts.reduce((s, p) => s + [...p].length + 1, 0) || 1;
      let acc = 0;
      toks = parts.map((w) => { const t = cue.start + ((cue.end - cue.start) * acc) / total; acc += [...w].length + 1; return { w, t, timed: false }; });
    }
    toks.forEach((x, i) => {
      if (NOISE.test(x.w)) return;
      const prev = words.at(-1);
      let gap;
      if (x.timed && prev && prev.timed) gap = Math.max(0, x.t - (prev.t + wordDur(prev.w)));
      else if (i === 0 && prevEnd != null) gap = Math.max(0, cue.start - prevEnd);
      else gap = 0;
      words.push({ w: x.w, t: x.t, gap, timed: x.timed });
    });
    prevEnd = cue.end;
  }
  return dropRepeats(words);
}

/** 去掉"滚动重复"：连续出现的同一段词（长度 ≥ 3）只留一份 */
function dropRepeats(words) {
  const out = [];
  for (const w of words) {
    out.push(w);
    for (let k = Math.min(12, Math.floor(out.length / 2)); k >= 3; k--) {
      let same = true;
      for (let j = 1; j <= k; j++) if (bare(out[out.length - j].w) !== bare(out[out.length - j - k].w)) { same = false; break; }
      if (same) { out.length -= k; break; }
    }
  }
  return out;
}

const isAbbrev = (w) => { const b = bare(w.replace(/\.+$/, '')); return b.length <= 4 && ABBR.has(b) && /\.$/.test(w); };
const endsSentence = (w) => TERMINAL.test(w) && !isAbbrev(w) && !/^\d+[.,]\d*$/.test(w);

/**
 * 词序列 → 句子 [{ start, end, text }]。
 *  1. 有标点：在句末标点处断开；没有标点（自动字幕）：在停顿处断开（≥ 0.5 秒且至少 5 个词，≥ 0.7 秒且至少 3 个词，或 ≥ 1.2 秒且至少 2 个词）；
 *  2. 太长的句子（词数或时长超限）在"最像句子边界"的位置再切：停顿 > 逗号 > 连接词；
 *  3. 太短的碎片并入相邻的句子；
 *  4. 补全首字母大写与句末标点（只用于显示与翻译，时间不受影响）。
 */
export function segmentSentences(words, { lang = 'en', maxWords = 26, maxSec = 9, minWords = 3 } = {}) {
  if (!words.length) return [];
  const cjk = isCjk(lang);
  const maxW = cjk ? maxWords * 2 : maxWords, minW = cjk ? minWords * 2 : minWords, five = cjk ? 10 : 5;
  const punctuated = words.filter((x) => endsSentence(x.w)).length >= Math.max(2, words.length / 60);

  // 1. 初分
  const chunks = [];
  let cur = [];
  words.forEach((x, i) => {
    cur.push(x);
    const next = words[i + 1];
    const brk = !next || (endsSentence(x.w) && (cur.length >= minW || (next.gap || 0) > 0.8)) || (!punctuated && ((next.gap >= 0.5 && cur.length >= five) || (next.gap >= 0.7 && cur.length >= minW) || (next.gap >= 1.2 && cur.length >= 2)));
    if (brk) { chunks.push(cur); cur = []; }
  });

  // 2. 太长的再切
  const split = (c) => {
    const dur = c.at(-1).t - c[0].t;
    if (c.length <= maxW && dur <= maxSec) return [c];
    let best = -1, bestScore = -Infinity;
    for (let i = minW; i <= c.length - minW; i++) {
      const prev = c[i - 1].w, nx = c[i];
      const score = (nx.gap || 0) * 2 + (COMMA.test(prev) ? 0.9 : 0) + (BOUNDARY.has(bare(nx.w)) ? 0.5 : 0) - Math.abs(i - c.length / 2) * 0.03;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) best = Math.floor(c.length / 2);
    return [...split(c.slice(0, best)), ...split(c.slice(best))];
  };
  let parts = chunks.flatMap(split);

  // 3. 碎片并入邻句（并入停顿更小的一侧，合并后不能超限）
  const fits = (a, b) => a.length + b.length <= maxW && b.at(-1).t - a[0].t <= maxSec;
  for (let i = 0; i < parts.length; ) {
    const c = parts[i];
    if (c.length >= minW || parts.length === 1) { i++; continue; }
    const prev = parts[i - 1], next = parts[i + 1];
    const gp = prev ? c[0].gap || 0 : Infinity, gn = next ? next[0].gap || 0 : Infinity;
    if (prev && gp <= gn && fits(prev, c)) { parts[i - 1] = [...prev, ...c]; parts.splice(i, 1); }
    else if (next && fits(c, next)) { parts[i] = [...c, ...next]; parts.splice(i + 1, 1); }
    else i++;
  }

  // 4. 组装文本与时间
  return parts.map((c, i) => {
    const nextStart = parts[i + 1]?.[0].t;
    const last = c.at(-1);
    let end = last.t + wordDur(last.w) + 0.25;
    if (nextStart != null) end = Math.min(end, nextStart);
    const start = c[0].t;
    end = Math.max(end, start + 0.6);
    return { start, end, text: finish(c.map((x) => x.w), cjk, lang) };
  });
}

function finish(ws, cjk, lang) {
  let t = cjk ? ws.join('') : ws.join(' ');
  t = t.replace(/\s+([,.;:!?…])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (lang === 'fr') t = t.replace(/(\p{L})\s*([?!])/gu, '$1 $2'); // 法语 ? ! 前留空格
  if (!cjk) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!TERMINAL.test(t)) t += cjk ? '。' : '.';
  return t;
}

/** 便捷入口：cue 列表 → 句子 */
export const cuesToSentences = (cues, lang, opts) => segmentSentences(cuesToWords(cues, lang), { lang, ...opts });
