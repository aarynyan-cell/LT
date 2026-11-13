// 仿 YouTube 的测试数据：一段"自动生成字幕"——法语对白，词与词之间约 0.32 秒，句子之间多停 1 秒，没有任何标点。
const SENTENCES = [
  "en ville un homme menace toujours de se jeter du haut d'un immeuble",
  'les pompiers sont sur place',
  'il va sauter',
  'mais non pas du tout',
  'je te parie un euro qui saute',
  'et moi je te parie deux euros qui saute pas',
];
const WORD_GAP = 0.32, SENT_GAP = 1.0, T0 = 2;
/** 每个词：{ w, t }（秒） */
function asrWords() {
  const out = []; let t = T0;
  for (const s of SENTENCES) { for (const w of s.split(' ')) { out.push({ w, t: +t.toFixed(3) }); t += WORD_GAP; } t += SENT_GAP; }
  return out;
}
/** 每个句子开始的时间（用来断言断句与时间对齐） */
function sentenceStarts() {
  const starts = []; let t = T0;
  for (const s of SENTENCES) { starts.push(+t.toFixed(3)); t += s.split(' ').length * WORD_GAP + SENT_GAP; }
  return starts;
}
/** YouTube json3 格式：每个事件约 6 个词，segs 里第一个词没有 tOffsetMs，后面的有 */
function json3() {
  const words = asrWords(), events = [];
  for (let i = 0; i < words.length; i += 6) {
    const ws = words.slice(i, i + 6), t0 = ws[0].t;
    events.push({ tStartMs: Math.round(t0 * 1000), dDurationMs: Math.round((ws.at(-1).t - t0 + 0.4) * 1000), segs: ws.map((x, k) => ({ utf8: (k ? ' ' : '') + x.w, ...(k ? { tOffsetMs: Math.round((x.t - t0) * 1000) } : {}) })) });
    events.push({ tStartMs: Math.round((ws.at(-1).t + 0.4) * 1000), dDurationMs: 100, segs: [{ utf8: '\n' }] });
  }
  return { wireMagic: 'pb3', events };
}
module.exports = { SENTENCES, asrWords, sentenceStarts, json3, T0 };
