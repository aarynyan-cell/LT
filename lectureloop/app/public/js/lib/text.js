// 文本领域逻辑：断句 → 听力单元(Cue) → 估算时间轴 / 锚点校准 → 自动分 Part。纯函数，Node 与浏览器通用。
import { esc } from './util.js';

const CJK = /[㐀-鿿豈-﫿]/g;

/** "词数"：拉丁词 + 汉字/1.8（中文语速约为英文词速的 1.8 倍字符） */
export function units(text) {
  const cjk = (text.match(CJK) || []).length;
  const latin = (text.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  return latin + cjk / 1.8;
}

export const normalize = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// ---------------- 断句 ----------------
const ABBR = /\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|prof|fig|eq|cf|approx)\.$/i;

export function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /([。？！]+["”’）)\]]*)|([.?!…]+["'”’)\]]*)(?=\s|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const piece = text.slice(start, end).trim();
    if (m[2] === '.' && ABBR.test(piece)) continue; // 缩写不是句末，继续累积
    if (piece) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

const CONJ = /^(and|so|but|because|which|where|then|while|whereas|if|when)$/i;

function splitLong(s, maxWords) {
  if (units(s) <= maxWords) return [s];
  const toks = s.split(/\s+/);
  if (toks.length < 2) return [s];
  const out = [];
  let cur = [];
  for (let j = 0; j < toks.length; j++) {
    cur.push(toks[j]);
    const nxt = toks[j + 1];
    const soft = /[,;:]$/.test(toks[j]) || (nxt && CONJ.test(nxt.replace(/[^a-z]/gi, '')));
    const remaining = toks.length - j - 1;
    if ((cur.length >= maxWords * 0.5 && soft && remaining >= 6) || cur.length >= maxWords) {
      out.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) {
    if (cur.length < 4 && out.length) out[out.length - 1] += ' ' + cur.join(' ');
    else out.push(cur.join(' '));
  }
  return out;
}

/** 合并碎句（< minWords）、拆分长句（> maxWords），得到适合"精听"的单元 */
export function chunkSentences(sentences, { minWords = 4, maxWords = 40 } = {}) {
  const pieces = [];
  for (const s of sentences) pieces.push(...splitLong(s, maxWords));
  const out = [];
  let buf = '';
  for (let k = 0; k < pieces.length; k++) {
    const cur = buf ? `${buf} ${pieces[k]}` : pieces[k];
    const next = pieces[k + 1];
    if (units(cur) < minWords && next && units(cur) + units(next) <= maxWords) {
      buf = cur;
      continue;
    }
    out.push(cur);
    buf = '';
  }
  // 末尾仍然太短 → 并入前一句
  if (out.length > 1 && units(out.at(-1)) < minWords && units(out.at(-2)) + units(out.at(-1)) <= maxWords * 1.25) {
    out[out.length - 2] += ' ' + out.pop();
  }
  return out;
}

/** paragraphs: string[]  →  cues（无时间）。段首句标记 paraStart。 */
export function buildCues(paragraphs, opts = {}) {
  const cues = [];
  for (const para of paragraphs) {
    const sents = chunkSentences(splitSentences(normalize(para)), opts);
    sents.forEach((text, k) => cues.push({ i: cues.length, start: 0, end: 0, text, ...(k === 0 ? { paraStart: true } : {}) }));
  }
  return cues;
}

// ---------------- 时间轴 ----------------
const WPS_DEFAULT = 150 / 60;
const slot = (c, wps) => Math.max(1.2, units(c.text) / wps);

function finalizeEnds(cues, total) {
  for (let n = 0; n < cues.length; n++) cues[n].end = n + 1 < cues.length ? cues[n + 1].start : total;
}

/**
 * 估算时间轴：按词数/语速推进，段落边界加停顿。传入 duration（录音真实时长）则整体缩放。
 * 就地修改 cues 的 start/end，返回总时长。
 */
export function estimateTimeline(cues, { wpm = 150, gap = 0.25, paraGap = 0.8, duration = 0 } = {}) {
  const wps = wpm / 60;
  let t = 0;
  const starts = [];
  cues.forEach((c, k) => {
    if (k && c.paraStart) t += paraGap;
    starts.push(t);
    t += slot(c, wps) + gap;
  });
  const total = t;
  const k = duration > 0 && total > 0 ? duration / total : 1;
  cues.forEach((c, n) => { c.start = starts[n] * k; });
  const end = duration > 0 ? duration : total;
  finalizeEnds(cues, end);
  return end;
}

/**
 * 锚点校准：anchors=[{i,t}]（第 i 句起点为 t 秒）。锚点之间按词数加权线性插值。
 * 就地修改 cues，返回总时长。
 */
export function applyAnchors(cues, anchors, duration = 0, wps = WPS_DEFAULT) {
  const n = cues.length;
  if (!n) return 0;
  const A = anchors.filter((a) => a.i >= 0 && a.i < n).sort((a, b) => a.i - b.i);
  const pts = [];
  if (!A.length || A[0].i > 0) pts.push({ i: 0, t: 0 });
  for (const a of A) {
    if (pts.length && a.i === pts.at(-1).i) pts.pop();
    if (!pts.length || a.t > pts.at(-1).t) pts.push({ i: a.i, t: a.t });
  }
  const w = cues.map((c) => slot(c, wps) + 0.25);
  let rate = 1;
  for (let p = 0; p < pts.length; p++) {
    const a = pts[p];
    const b = pts[p + 1];
    const last = b ? b.i : n;
    let W = 0;
    for (let j = a.i; j < last; j++) W += w[j];
    const span = b ? b.t - a.t : null;
    const r = span != null ? span / W : rate;
    if (span != null) rate = r;
    let acc = 0;
    for (let j = a.i; j < last; j++) { cues[j].start = a.t + acc * r; acc += w[j]; }
    if (!b) {
      const end = a.t + acc * r;
      const total = duration > end ? duration : end;
      finalizeEnds(cues, total);
      return total;
    }
  }
  return 0;
}

/** 二分查找：start <= t 的最后一句 */
export function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 每 bucket 秒的词数密度，用于时间轴上的"语速/信息密度条"（近似波形） */
export function densityBuckets(cues, duration, bucket = 30) {
  const nb = Math.max(1, Math.ceil(duration / bucket));
  const out = new Array(nb).fill(0);
  for (const c of cues) {
    const u = units(c.text);
    const len = Math.max(0.001, c.end - c.start);
    let t = c.start;
    while (t < c.end - 1e-6) {
      const b = Math.min(nb - 1, Math.floor(t / bucket));
      const stop = Math.min(c.end, (b + 1) * bucket);
      out[b] += u * ((stop - t) / len);
      t = stop;
    }
  }
  const max = Math.max(1, ...out);
  return out.map((v) => v / max);
}

// ---------------- 分 Part ----------------
const STRONG = /^(?:(?:okay|ok|alright|all right|so|right|well|and)[,.]?\s+){0,2}(?:now|next|let'?s(?! (?:say|imagine|take|call|assume|suppose|see|do|check|try|consider))|let us|moving on|to start|first(?:ly)?|second(?:ly)?|finally|to summari[sz]e|in summary|to conclude|the next|another)\b/i;

/** 返回 [{id,title,startCue,endCue,summary}]，目标 400–1200 词/片段，优先在话题转换处切开 */
export function segmentParts(cues, { target = 700, min = 450, max = 1200, tail = 150 } = {}) {
  if (!cues.length) return [];
  const bounds = [0];
  let w = 0;
  for (let k = 0; k < cues.length; k++) {
    if (k > bounds.at(-1)) {
      const trans = STRONG.test(cues[k].text);
      if (w >= max || (w >= target && (trans || cues[k].paraStart)) || (w >= min && trans)) {
        bounds.push(k);
        w = 0;
      }
    }
    w += units(cues[k].text);
  }
  // 最后一段太短 → 并入前一段
  if (bounds.length > 1 && w < tail) bounds.pop();
  return bounds.map((s, p) => ({
    id: `p${p + 1}`,
    title: `Part ${p + 1}`,
    startCue: s,
    endCue: (bounds[p + 1] ?? cues.length) - 1,
    summary: '',
  }));
}

export const partOf = (parts, cueIdx) => parts.findIndex((p) => cueIdx >= p.startCue && cueIdx <= p.endCue);

// ---------------- 展示层工具 ----------------
/** 隐藏语气词（仅显示层，不改数据） */
export function hideFillers(text) {
  return text
    .replace(/\b(?:uh+|um+|uhm+|erm?|hmm+|mm+)\b[,.]?\s*/gi, '')
    .replace(/\s+([,.?!])/g, '$1')
    .replace(/(^|[.?!]\s+)[,]\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 搜索高亮：返回 [{t, hit}]（用节点拼装，避免 innerHTML） */
export function highlightParts(text, query) {
  const q = query.trim();
  if (!q) return [{ t: text, hit: false }];
  const re = new RegExp(`(${esc(q)})`, 'gi');
  return text.split(re).filter((s) => s !== '').map((s) => ({ t: s, hit: s.toLowerCase() === q.toLowerCase() }));
}
