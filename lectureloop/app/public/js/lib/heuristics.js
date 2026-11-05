// 离线启发式：无 API 密钥时也能给出可用的 Part 标题、粗略笔记、词汇候选和"讲者话语标记"句式。
// 输出结构与 Claude 版本一致，界面会明确标注"离线粗略版"。纯函数。
import { units, hideFillers } from './text.js';
import { DOMAIN, phraseRegex } from './glossary.js';

export const STOP = new Set(`keep mind a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let's lets me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours
okay ok yeah uh um oh right well like really actually maybe something anything everything thing things know think going gonna want need look looking see say said let get got make makes take takes put come goes go one two three first second case example kind sort lot lots bit quite much many way ways also still even always usually typically basically simply just quickly exactly probably already
it's that's don't doesn't can't won't isn't aren't i'm you're we're they're i'll you'll we'll i've you've we've there's here's what's let's
good great nice important different similar specific general number numbers time times point points start end find found give gives given using use used called call mean means understand idea ideas question questions problem answer little big small large new old high low best better`.split(/\s+/));

const tokens = (s) => (s.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ'’-]*/g) || []).map((w) => w.replace(/[’]/g, "'"));
const content = (s) => tokens(s).filter((w) => w.length > 2 && !STOP.has(w));

const MARKERS = /\b(keep in mind|remember|important|note that|make sure|don'?t forget|key idea|core idea|the point is|pay attention|crucial|you need to|you have to|we call|is called|means that|the idea is)\b/i;

// ---------- Part 标题 ----------
export function titleParts(cues, parts) {
  const P = parts.length;
  const partTokens = parts.map((p) => cues.slice(p.startCue, p.endCue + 1).flatMap((c) => content(c.text)));
  const df = new Map();
  partTokens.forEach((ts) => new Set(ts).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  return parts.map((p, k) => {
    const tf = new Map();
    partTokens[k].forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    // bigram 加成
    const bi = new Map();
    for (let j = 0; j + 1 < partTokens[k].length; j++) {
      const key = `${partTokens[k][j]} ${partTokens[k][j + 1]}`;
      bi.set(key, (bi.get(key) || 0) + 1);
    }
    const scored = [];
    for (const [w, n] of tf) scored.push([w, n * Math.log((P + 1) / ((df.get(w) || 1) + 0.5))]);
    for (const [b, n] of bi) if (n >= 2) scored.push([b, n * 3.2 * Math.log((P + 1) / 1.5)]);
    scored.sort((a, b) => b[1] - a[1]);
    const picked = [];
    for (const [w] of scored) {
      if (picked.some((x) => x.includes(w) || w.includes(x))) continue;
      picked.push(w);
      if (picked.length === 3) break;
    }
    return { ...p, title: picked.length ? `${p.title.replace(/ ·.*/, '')} · ${picked.join(', ')}` : p.title };
  });
}

// ---------- 句子打分 ----------
function scoreCues(cues) {
  const freq = new Map();
  const per = cues.map((c) => content(c.text));
  per.forEach((ts) => ts.forEach((w) => freq.set(w, (freq.get(w) || 0) + 1)));
  return cues.map((c, k) => {
    const ts = per[k];
    const u = units(c.text);
    if (u < 6 || u > 45 || !ts.length) return 0;
    const w = ts.reduce((s, t) => s + (freq.get(t) >= 3 ? Math.log(1 + freq.get(t)) : 0), 0);
    let sc = w / Math.sqrt(ts.length + 2);
    if (MARKERS.test(c.text)) sc *= 1.6;
    return sc;
  });
}

const tidy = (t) => hideFillers(t).replace(/^(?:okay|ok|so|and|right|yeah|well)[,.]?\s+/i, '').replace(/^./, (x) => x.toUpperCase());

function pickSpread(scores, from, to, k, gap = 8) {
  const idx = [];
  for (let i = from; i <= to; i++) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a]);
  const out = [];
  for (const i of idx) {
    if (scores[i] <= 0) break;
    if (out.every((j) => Math.abs(j - i) >= gap)) out.push(i);
    if (out.length >= k) break;
  }
  return out.sort((a, b) => a - b);
}

// ---------- 离线笔记 ----------
const DEF_A = /\bwe (?:will |can )?call (?:this|that|it|them|these|each \w+) (?:a |an |the )?([a-z][a-z-]*(?: [a-z][a-z-]*){0,2}?)(?=[.,?!]|\s+(?:and|okay|which|because|so)\b|$)/i;
const DEF_B = /\bwhat we call (?:a |an |the )?([a-z][a-z-]*(?: [a-z][a-z-]*){0,2}?)(?=[.,?!]|\s+(?:and|okay|which|because|so)\b|$)/i;
const DEF_C = /\b([a-z][a-z-]*(?: [a-z][a-z-]*){0,2}) (?:is|are) (?:called|defined as|known as)\b/i;
const MATH = /\b(minus|plus|equals?|squared?|times|divided|norm|dot product|greater than|less than|superior|inferior|sigma|sum|log|probability|proportion|zero|one half)\b/gi;
const EMPH = /\b(keep (?:this |that )?in mind|remember|important|note that|make sure|don'?t forget|key idea|core idea|the point is|pay attention|crucial)\b/i;

export function offlineNotes(cues, parts) {
  const sc = scoreCues(cues);
  const n = cues.length;
  const kPoints = Math.min(20, Math.max(8, Math.round(n / 70)));
  const keyIdx = pickSpread(sc, 0, n - 1, kPoints, 10);
  const kws = topKeywords(cues, 6);
  const mins = Math.round(cues.at(-1).end / 60);

  const concepts = [];
  const seen = new Set();
  cues.forEach((c) => {
    const m = c.text.match(DEF_A) || c.text.match(DEF_B) || c.text.match(DEF_C);
    const term = m?.[1]?.trim().toLowerCase();
    const okTerm = term && term.length > 2 && !tokens(term).some((w) => STOP.has(w)); // 过滤 "on using this" 之类的碎片
    if (okTerm && !seen.has(term) && concepts.length < 12) {
      seen.add(term);
      concepts.push({ term, definition: tidy(c.text), cue: c.i });
    }
  });

  const formulas = cues
    .map((c) => ({ c, k: new Set((c.text.match(MATH) || []).map((x) => x.toLowerCase())).size }))
    .filter((x) => x.k >= 2)
    .sort((a, b) => b.k - a.k)
    .slice(0, 6)
    .sort((a, b) => a.c.i - b.c.i)
    .map(({ c }) => ({ expression: '', spoken: tidy(c.text), explanation: '', cue: c.i }));

  const emphasized = cues.filter((c) => EMPH.test(c.text) && units(c.text) >= 6).slice(0, 8).map((c) => ({ text: tidy(c.text), cue: c.i }));
  const questions = cues
    .filter((c) => /\?$/.test(c.text.trim()) && units(c.text) >= 8 && !/^(okay|ok|right|yes|yeah)\b/i.test(c.text))
    .slice(0, 5)
    .map((c) => ({ text: tidy(c.text), cue: c.i }));

  const partSummaries = {};
  for (const p of parts) {
    const top = pickSpread(sc, p.startCue, p.endCue, 2, 4);
    partSummaries[p.id] = top.map((i) => tidy(cues[i].text)).join(' … ');
  }

  return {
    source: 'offline',
    overview: `（离线粗略版，未使用 AI）本课约 ${mins} 分钟，共 ${n} 句，高频主题：${kws.join('、') || '—'}。下方为按词频与话语标记抽取的原句，请对照原文使用。`,
    keyPoints: keyIdx.map((i) => ({ text: tidy(cues[i].text), cue: i })),
    concepts,
    formulas,
    emphasized,
    questions,
    partSummaries,
  };
}

export function topKeywords(cues, k = 8) {
  const tf = new Map();
  cues.forEach((c) => content(c.text).forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)));
  return [...tf].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w);
}

// ---------- 离线词汇候选 ----------
/** 领域词典命中（含 aliases 与 heardAs，heardAs 被统计为"常被听成"） + 课程术语表 + 高频 n-gram */
export function offlineVocab(cues, glossary = [], limit = 40) {
  const text = cues.map((c) => c.text);
  const out = [];
  const used = new Set();
  const add = (entry, re, heard) => {
    let count = 0, cue = -1;
    const heardFound = new Set();
    text.forEach((t, k) => {
      const m = t.match(re);
      if (m) { count += m.length; if (cue < 0) cue = cues[k].i; }
      for (const h of heard) if (phraseRegex(h).test(t)) heardFound.add(h);
    });
    if (count > 0 || heardFound.size) {
      out.push({ ...entry, cue: cue < 0 ? 0 : cue, count: count + heardFound.size, heardAs: [...heardFound], status: 'new' });
      used.add(entry.term.toLowerCase());
    }
  };
  for (const d of DOMAIN) {
    const forms = [d.term, ...d.aliases].map((s) => s.replace(/-/g, '[ -]'));
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    add({ term: d.term, pos: d.pos, kind: 'term', def: d.def }, re, d.heardAs);
  }
  for (const g of glossary) {
    if (!g.term || used.has(g.term.toLowerCase())) continue;
    add({ term: g.term, pos: '', kind: 'term', def: { zh: g.note || '', en: '', fr: '' } }, phraseRegex(g.term), g.heardAs || []);
  }
  // 其余：高频 n-gram（无释义，提示用 AI 生成）
  const uni = new Map(), bi = new Map();
  const per = cues.map((c) => c.text.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ'-]*/g) || []);
  per.forEach((ws) => {
    for (let j = 0; j < ws.length; j++) {
      if (!STOP.has(ws[j]) && ws[j].length > 5) uni.set(ws[j], (uni.get(ws[j]) || 0) + 1);
      if (j + 1 < ws.length && !STOP.has(ws[j]) && !STOP.has(ws[j + 1]) && ws[j].length > 3 && ws[j + 1].length > 3) {
        const b = `${ws[j]} ${ws[j + 1]}`;
        bi.set(b, (bi.get(b) || 0) + 1);
      }
    }
  });
  const cands = [
    ...[...bi].filter(([, n]) => n >= 3).map(([t, n]) => [t, n * 2.2]),
    ...[...uni].filter(([, n]) => n >= 4).map(([t, n]) => [t, n]),
  ].sort((a, b) => b[1] - a[1]);
  for (const [t, sc] of cands) {
    if (out.length >= limit) break;
    if ([...used].some((u) => u.includes(t) || t.includes(u))) continue;
    const re = phraseRegex(t);
    const k = text.findIndex((x) => re.test(x));
    used.add(t);
    out.push({ term: t, pos: '', kind: t.includes(' ') ? 'collocation' : 'term', def: { zh: '', en: '', fr: '' }, cue: k < 0 ? 0 : cues[k].i, count: Math.round(sc), heardAs: [], status: 'new', needsDef: true });
  }
  return out.sort((a, b) => (b.def.zh ? 1 : 0) - (a.def.zh ? 1 : 0) || b.count - a.count).slice(0, limit);
}

// ---------- 话语标记句式 ----------
export const FN_LABEL = { introduce: '开场引入', define: '下定义', emphasize: '强调', contrast: '对比', cause_effect: '因果/推论', example: '举例', transition: '转场', check: '确认理解', summarize: '总结', condition: '条件' };

const P = (id, fn, template, explain, re) => ({ id, fn, template, explain, re });
const PATTERNS = [
  P('we-call', 'define', 'We call X … / What we call X …', '给新概念命名、下定义', /\bwe (?:will |can )?call\b|\bwhat we call\b/i),
  P('is-called', 'define', 'X is called / defined as / known as …', '被动式定义', /\b(?:is|are) (?:called|defined as|known as|referred to as)\b/i),
  P('means', 'cause_effect', 'This / That means that …', '解释含义、推出结论', /\b(?:this|that|it|which) means\b/i),
  P('keep-in-mind', 'emphasize', 'Keep in mind that … / Keep this in mind.', '提醒记住重点', /\bkeep (?:this |that )?in mind\b/i),
  P('remember', 'emphasize', 'Just remember (that) …', '强调需记住的结论', /\b(?:just |please |so )?remember\b/i),
  P('important', 'emphasize', 'It is important to … / The key idea is …', '标出关键点', /\b(?:it'?s |this is |are )?(?:really |very |quite )?important\b|\bthe (?:key|main|core) (?:idea|point)\b/i),
  P('for-instance', 'example', 'For instance, … / Let’s say … / Let’s take …', '引出例子', /\bfor (?:instance|example)\b|\blet'?s say\b|\blet'?s take\b/i),
  P('imagine', 'example', 'Imagine / Suppose / Assume …', '设定假设情境', /\b(?:imagine|suppose|assume)\b/i),
  P('in-that-case', 'condition', 'In that case, … / If …, then …', '条件与结果', /\bin that case\b|\bif\b[^.?!]{3,60}\bthen\b/i),
  P('contrary', 'contrast', 'On the contrary, … / Unlike … / Rather than …', '对比、转折', /\bon the contrary\b|\bunlike\b|\bin contrast\b|\bwhereas\b|\brather than\b|\binstead of\b/i),
  P('however', 'contrast', 'However, … / But in that case …', '转折', /\bhowever\b|\bbut (?:here|in that case|then|now)\b/i),
  P('thats-why', 'cause_effect', 'That’s why … / As a result, … / Therefore, …', '说明原因与结果', /\bthat'?s (?:why|because)\b|\bwhich is why\b|\bas a result\b|\btherefore\b|\bso that\b/i),
  P('lets-look', 'transition', 'Let’s look at … / Now, … / Next, …', '切换到下一个话题', /\b(?:let'?s|let us) (?:look|see|move|start|go|talk|discuss|now)\b|^(?:okay|ok|alright)?,?\s*(?:so )?(?:now|next)\b/i),
  P('later', 'transition', 'We will see that later. / I will go back to this …', '预告或回扣', /\bwe(?:'ll| will) (?:see|formali[sz]e|discuss|come back)\b|\bI will go back\b|\bwe will come back\b/i),
  P('check', 'check', 'Is that clear? / Does that make sense? / Any questions?', '检查理解', /\b(?:is that|does that|does it) (?:clear|make sense|okay)\b|\bdo you (?:see|understand|follow)\b|\bany questions\b/i),
  P('idea-is', 'summarize', 'The idea is … / In short, … / Basically, …', '概括思路', /\bthe (?:idea|goal|point) is\b|\bin (?:short|summary)\b|\bto summari[sz]e\b|\bbasically\b|\bin the end\b/i),
  P('today', 'introduce', 'Today we are going to … / We will start with …', '开场、引入主题', /\b(?:today|now) we(?:'re| are| will|'ll) (?:going to |gonna )?\w+|\bwe are going to\b|\bwe will start\b/i),
];

/** 返回按出现次数排序的句式，每个带最多 3 个例句 cue */
export function detectPatterns(cues, limit = 16) {
  const rows = [];
  for (const p of PATTERNS) {
    const hits = [];
    cues.forEach((c) => p.re.test(c.text) && units(c.text) >= 4 && hits.push(c.i));
    if (!hits.length) continue;
    const pick = [hits[0], hits[Math.floor(hits.length / 2)], hits.at(-1)].filter((v, i, a) => a.indexOf(v) === i);
    rows.push({ id: p.id, fn: p.fn, template: p.template, explain: p.explain, cue: pick[0], cues: pick, count: hits.length, extensions: [] });
  }
  rows.sort((a, b) => b.count - a.count);
  const perFn = {};
  return rows.filter((r) => (perFn[r.fn] = (perFn[r.fn] || 0) + 1) <= 3).slice(0, limit);
}
