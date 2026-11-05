// AI 任务定义（服务端与浏览器共用）：提示词、JSON Schema、结果校验。纯函数，不依赖 Node 或 DOM。
// 本地版由 server/ai.js 调用；在线版（浏览器自带密钥）由 lib/claude-browser.js 调用——两端行为完全一致。

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** 容错解析：去掉 ```json 围栏，必要时截取第一个 { 到最后一个 } */
export function parseLooseJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* 继续尝试 */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('no json');
}
// 服务端 fallbacks:"default"（beta server-side-fallback-2026-07-01）只对 Fable / Opus 5.x / Sonnet 5.5 开启；Haiku 不支持
export const supportsServerFallback = (model) => /^claude-(fable|opus-5|sonnet-5-5)/.test(model);
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const LANG_NAME = { zh: 'Simplified Chinese (简体中文)', en: 'English', fr: 'French (français)' };
const langName = (l) => LANG_NAME[l] || LANG_NAME.zh;

// ---------- 通用辅助 ----------
const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });
const withCue = (props) => obj({ ...props, cue: int });

const lines = (cues) => cues.map((c) => `${c.i}|${c.t.replace(/\s+/g, ' ').trim()}`).join('\n');
const clampCue = (v, n) => (Number.isInteger(v) ? Math.min(Math.max(v, 0), Math.max(0, n - 1)) : 0);
const s = (v, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- 1) 笔记 ----------
const NOTES_SCHEMA = obj({
  overview: str,
  parts: arr(obj({ start_cue: int, title: str, summary: str })),
  key_points: arr(withCue({ text: str })),
  concepts: arr(withCue({ term: str, definition: str })),
  formulas: arr(withCue({ expression: str, spoken: str, explanation: str })),
  emphasized: arr(withCue({ text: str })),
  questions: arr(withCue({ text: str })),
});

const NOTES_SYSTEM = (noteLang) => `You turn a noisy automatic transcript of a university lecture into study notes for an international student who is not a native speaker of the lecture language.

The input is numbered transcript lines in the form "index|text". The transcript comes from speech recognition: it has filler words (okay, uh, so), broken sentences and WRONG WORDS, especially technical terms (for example "dog product" for "dot product", "decision treats" for "decision trees"). Use the lecture context to infer the intended technical term and use the correct term in your notes.

Rules:
- Be faithful. Include only what the lecturer actually said or clearly implied. Never invent facts, numbers or references. If a passage is unclear, leave it out instead of guessing.
- Every item in key_points, concepts, formulas, emphasized and questions has "cue": the index of the transcript line where the idea is stated. It must be an index that exists in the input, so the student can listen to the original sentence.
- Write the notes in ${langName(noteLang)}. Keep technical terms in English (the lecture language) and add a translation in parentheses the first time a term appears when the note language is different.
- parts: split the lecture into coherent topical parts of roughly 3-8 minutes of speech (about 400-1200 words each). start_cue values must be strictly increasing and the first must be 0. Each part gets a short title and a 2-4 sentence summary.
- overview: 3-5 sentences on what the lecture is about and how it progresses.
- key_points: 8-20 self-contained study points in lecture order (full statements, not topic labels).
- concepts: definitions given in the lecture (term + definition).
- formulas: any formula, equation or quantity the lecturer described. "expression" in plain text / Unicode math (e.g. y(wᵀx + b) ≥ 1); "spoken" is how the lecturer said it aloud; "explanation" says what it means. Use an empty array if there are none.
- emphasized: what the lecturer stressed to remember, warnings, exam hints ("keep in mind", "important", "remember").
- questions: at most 6 open questions worth asking the lecturer or reviewing.`;

export function notesTask({ course, title, noteLang = 'zh', cues }) {
  return {
    system: NOTES_SYSTEM(noteLang),
    user: `Course: ${course || '(unknown)'}\nLesson: ${title || '(untitled)'}\n\nTranscript:\n${lines(cues)}`,
    schema: NOTES_SCHEMA,
    effort: 'medium',
    maxTokens: 32000,
  };
}

export function sanitizeNotes(d, n) {
  d = d && typeof d === 'object' ? d : {};
  const g = (a, b) => d[a] ?? d[b];
  const withRef = (list, f) => (Array.isArray(list) ? list.slice(0, 60).map((x) => ({ ...f(x), cue: clampCue(x.cue, n) })) : []);
  let parts = (Array.isArray(d.parts) ? d.parts : [])
    .map((p) => ({ ...p, start_cue: p.start_cue ?? p.startCue }))
    .filter((p) => Number.isInteger(p.start_cue))
    .map((p) => ({ startCue: clampCue(p.start_cue, n), title: s(p.title, 120), summary: s(p.summary, 1200) }))
    .sort((a, b) => a.startCue - b.startCue)
    .filter((p, i, a) => i === 0 || p.startCue > a[i - 1].startCue);
  if (parts.length && parts[0].startCue !== 0) parts[0].startCue = 0;
  return {
    overview: s(d.overview, 2000),
    parts,
    keyPoints: withRef(g('key_points', 'keyPoints'), (x) => ({ text: s(x.text) })),
    concepts: withRef(d.concepts, (x) => ({ term: s(x.term, 120), definition: s(x.definition) })),
    formulas: withRef(d.formulas, (x) => ({ expression: s(x.expression, 300), spoken: s(x.spoken, 300), explanation: s(x.explanation) })),
    emphasized: withRef(d.emphasized, (x) => ({ text: s(x.text) })),
    questions: withRef(d.questions, (x) => ({ text: s(x.text) })).slice(0, 8),
  };
}

// ---------- 2) 语言拆解 ----------
const PATTERN_FN = ['introduce', 'define', 'emphasize', 'contrast', 'cause_effect', 'example', 'transition', 'check', 'summarize', 'condition'];
const LANGUAGE_SCHEMA = obj({
  corrections: arr(obj({ wrong: str, right: str, reason: str })),
  vocab: arr(
    obj({
      term: str,
      pos: str,
      kind: { type: 'string', enum: ['term', 'phrase', 'collocation'] },
      cue: int,
      def: obj({ zh: str, en: str, fr: str }),
      heard_as: arr(str),
    }),
  ),
  patterns: arr(
    obj({
      fn: { type: 'string', enum: PATTERN_FN },
      template: str,
      explain: str,
      cue: int,
      extensions: arr(obj({ en: str, zh: str })),
    }),
  ),
});

const LANGUAGE_SYSTEM = (explainLang) => `You help an international student turn a lecture transcript into language-learning material.

The input is numbered transcript lines "index|text" produced by speech recognition (errors are expected, especially in technical terms), plus an optional course glossary.

Produce:
- corrections: ASR errors you are confident about. "wrong" is the exact wording as it appears in the transcript (it must be a case-insensitive substring of at least one line), "right" is the intended term, "reason" is a short explanation in ${langName(explainLang)} of why it was misheard (similar sound, accent, weak vowel...). Only fix technical terms, names and fixed phrases where the context makes the intended word clear; at most 40. Do not fix grammar, fillers or style.
- vocab: 25-40 items worth learning for a student of this subject in this language: key technical terms, plus useful academic / lecture phrases and collocations. "term" is written in its corrected form. "pos" is short (n., v., adj., phrase). "kind" is term | phrase | collocation. "def" has short definitions in zh (Simplified Chinese), en (plain English, one sentence) and fr (French), each at most 25 words. "cue" is the index of one line where the item occurs. "heard_as" lists wrong ASR spellings of this item that appear in the transcript (empty array if none).
- patterns: 10-16 sentence frames the lecturer uses to structure the lecture. "fn" is one of ${PATTERN_FN.join(', ')}. "template" is a reusable frame with "…" for the blank (e.g. "Keep in mind that …"). "explain" is one short sentence in ${langName(explainLang)} saying when to use it. "cue" is the index of a line where the lecturer uses it. "extensions" are two NEW example sentences that use the frame about this subject, each with English and Simplified Chinese.

Be faithful to the transcript; do not invent content the lecturer never covered.`;

// ---------- 2) 语言拆解：任务 ----------
export function languageTask({ course, title, explainLang = 'zh', cues, glossary = [] }) {
  const gl = glossary.length ? `\n\nCourse glossary (known correct terms): ${glossary.slice(0, 200).join('; ')}` : '';
  return {
    system: LANGUAGE_SYSTEM(explainLang),
    user: `Course: ${course || '(unknown)'}\nLesson: ${title || '(untitled)'}${gl}\n\nTranscript:\n${lines(cues)}`,
    schema: LANGUAGE_SCHEMA,
    effort: 'medium',
    maxTokens: 32000,
  };
}

export function sanitizeLanguage(d, cues) {
  d = d && typeof d === 'object' ? d : {};
  const n = cues.length;
  const hay = cues.map((c) => c.t.toLowerCase());
  // 纠错：wrong 必须在原文真实出现（防幻觉），并统计出现次数与位置
  const seen = new Set();
  const corrections = [];
  for (const c of Array.isArray(d.corrections) ? d.corrections : []) {
    const wrong = s(c.wrong, 120);
    const right = s(c.right, 120);
    if (!wrong || !right || wrong.toLowerCase() === right.toLowerCase()) continue;
    const key = wrong.toLowerCase();
    if (seen.has(key)) continue;
    const at = [];
    hay.forEach((h, k) => h.includes(key) && at.push(cues[k].i));
    if (!at.length) continue;
    seen.add(key);
    corrections.push({ wrong, right, reason: s(c.reason, 200), count: at.length, cues: at.slice(0, 200), state: 'pending' });
  }
  const vocab = (Array.isArray(d.vocab) ? d.vocab : []).slice(0, 80).map((v) => ({
    term: s(v.term, 120),
    pos: s(v.pos, 20),
    kind: ['term', 'phrase', 'collocation'].includes(v.kind) ? v.kind : 'term',
    cue: clampCue(v.cue, n),
    def: { zh: s(v.def?.zh, 200), en: s(v.def?.en, 300), fr: s(v.def?.fr, 300) },
    heardAs: (Array.isArray(v.heard_as ?? v.heardAs) ? (v.heard_as ?? v.heardAs) : []).map((x) => s(x, 80)).filter(Boolean).slice(0, 8),
    status: 'new',
  })).filter((v) => v.term);
  const patterns = (Array.isArray(d.patterns) ? d.patterns : []).slice(0, 30).map((p) => ({
    fn: PATTERN_FN.includes(p.fn) ? p.fn : 'introduce',
    template: s(p.template, 200),
    explain: s(p.explain, 300),
    cue: clampCue(p.cue, n),
    extensions: (Array.isArray(p.extensions) ? p.extensions : []).slice(0, 4).map((e) => ({ en: s(e.en, 300), zh: s(e.zh, 300) })),
  })).filter((p) => p.template);
  return { corrections, vocab, patterns };
}

// ---------- 3) 字幕翻译 ----------
const TR_LANG = { zh: 'Simplified Chinese', en: 'English', fr: 'French' };
const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, t: { type: 'string' } }, required: ['i', 't'], additionalProperties: false } } },
  required: ['items'],
  additionalProperties: false,
};

export function translateTask({ items, source, target, context = [], glossary = [] }) {
  const system = `You translate live lecture subtitles from ${TR_LANG[source] || source} to ${TR_LANG[target] || target}.
Each input line is "index|text". The text comes from speech recognition: it has filler words (uh, um, okay) and sometimes wrong technical words - use the context to translate the intended meaning, but never add information.
Rules: natural, concise subtitle style; drop pure fillers; keep technical terms accurate and consistent${glossary.length ? ` (glossary: ${glossary.slice(0, 80).join('; ')})` : ''}; return exactly one item per input line with the same index; do not merge or split lines.`;
  const ctx = context.length ? `Previous lines (context only, do NOT translate):\n${context.slice(-3).join('\n')}\n\n` : '';
  const user = `${ctx}Translate these lines:\n${items.map((c) => `${c.i}|${c.t.replace(/\s+/g, ' ').trim()}`).join('\n')}`;
  return { system, user, schema: TRANSLATE_SCHEMA, effort: 'low', maxTokens: 8000 };
}

/** 按输入顺序对齐译文；缺失的行留空（前端只显示原文）。完全为空时返回 null。 */
export function alignTranslation(items, data) {
  const byI = new Map((data?.items || []).map((x) => [x.i, String(x.t || '')]));
  if (byI.size === 0) return null;
  return items.map((c) => ({ i: c.i, t: byI.get(c.i) ?? '' }));
}

/** 结构是否大致符合预期（防止把别的 JSON 当作笔记保存） */
export const looksLikeNotes = (d) => !!d && typeof d === 'object' && ('key_points' in d || 'keyPoints' in d || 'parts' in d || 'overview' in d);
export const looksLikeLanguage = (d) => !!d && typeof d === 'object' && ('vocab' in d || 'patterns' in d || 'corrections' in d);
