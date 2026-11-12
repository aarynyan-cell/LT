// 单词：切分、停用词、颜色。纯函数。
import { STOPWORDS } from './langs.js';

/** 收藏用的颜色：红 = 不会，黄 = 模糊，绿 = 会了，蓝 = 好句/备用（句子可用全部四种，单词默认三种） */
export const COLORS = {
  red: { label: '不会', hex: '#ff6b6b' },
  yellow: { label: '模糊', hex: '#ffd43b' },
  green: { label: '会了', hex: '#69db7c' },
  blue: { label: '好句', hex: '#74c0fc' },
};
export const WORD_COLORS = ['red', 'yellow', 'green'];

/** 把一句话切成片段：[{ t: '文字', word: true|false }]。优先用浏览器的 Intl.Segmenter（中文也能分词），没有就用正则 */
export function tokenize(text, lang = 'en') {
  const out = [];
  try {
    const seg = new Intl.Segmenter(lang === 'zh' ? 'zh' : lang, { granularity: 'word' });
    for (const s of seg.segment(text)) out.push({ t: s.segment, word: !!s.isWordLike });
    if (out.length) return mergeApostrophes(out);
  } catch { /* 不支持：用正则 */ }
  for (const m of text.matchAll(/(\p{L}[\p{L}\p{M}'’-]*)|([^\p{L}]+)/gu)) out.push({ t: m[0], word: !!m[1] });
  return out;
}
// Segmenter 会把 "l'immeuble" 切成 l' / immeuble，把 "don't" 保持为一个词——统一让省音前缀不单独成词
function mergeApostrophes(tokens) {
  const out = [];
  for (const k of tokens) {
    const prev = out.at(-1);
    if (prev && !prev.word && /^['’]$/.test(prev.t) && k.word && out.length >= 2 && out.at(-2).word) { const a = out.pop(); const b = out.pop(); out.push({ t: b.t + a.t + k.t, word: true }); }
    else out.push({ ...k });
  }
  return out;
}

export const wordKey = (w) => String(w).trim().toLowerCase().normalize('NFC').replace(/^['’-]+|['’-]+$/g, '');
export const isStop = (w, lang) => { const k = wordKey(w); const set = STOPWORDS[lang]; return k.length < 2 || /^\d+$/.test(k) || !!set?.has(k) || /^[ldjnmtsc]['’]/.test(k) && k.length <= 3; };

/** 统计一组句子里的词：[{ word, count, firstLine }]，按次数降序、字母升序；hideStop 时去掉停用词 */
export function wordStats(lines, lang, { hideStop = true } = {}) {
  const map = new Map();
  lines.forEach((l, idx) => {
    for (const k of tokenize(l.text, lang)) {
      if (!k.word) continue;
      const w = wordKey(k.t);
      if (!w || (hideStop && isStop(w, lang))) continue;
      const e = map.get(w) || { word: w, count: 0, firstLine: idx };
      e.count++; map.set(w, e);
    }
  });
  return [...map.values()].sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));
}
