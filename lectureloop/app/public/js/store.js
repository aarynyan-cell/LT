// 应用状态 + 动作。所有写入走这里：先写 IndexedDB，成功后更新内存并通知订阅者。
import { useState, useEffect, useRef } from './h.js';
import { db, openDb, exportAll, importAll, clearAll } from './db.js';
import { uid } from './lib/util.js';
import { buildSeed, DEFAULT_TAGS } from './lib/seed.js';
import { newSrs, review, queue } from './lib/srs.js';
import { segmentParts, applyAnchors, cueAt, estimateTimeline } from './lib/text.js';
import { titleParts, offlineNotes, offlineVocab, detectPatterns } from './lib/heuristics.js';
import { rulesFor, scanCorrections, applyCorrection, revertCorrection, DOMAIN } from './lib/glossary.js';
import { getConfig, aiNotes, aiLanguage, setApiConfig, aiAvailable } from './lib/api.js';

export const DEFAULTS = {
  srcLang: 'en', targets: ['zh'], fontSize: 30, fadeOriginal: false, hideFillers: false, showTr: true,
  noteLang: 'zh', recordingAck: false, seeded: false, trLang: 'zh', blind: false,
};

// ---------- 状态 ----------
let state = {
  ready: false, dbMode: 'idb', courses: [], lessons: [], clips: [], tags: [], settings: { ...DEFAULTS },
  config: null, toasts: [], busy: {}, cuesRev: {}, route: parseRoute(), ui: { importOpen: false, shortcuts: false },
};
const subs = new Set();
export const getState = () => state;
export function setState(p) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  subs.forEach((f) => f(state));
}
export function useStore(sel = (s) => s) {
  const [, force] = useState(0);
  const selRef = useRef(sel);
  selRef.current = sel;
  const last = useRef();
  last.current = sel(state);
  useEffect(() => {
    const f = (s) => { if (!Object.is(selRef.current(s), last.current)) force((n) => n + 1); };
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return last.current;
}

// ---------- 路由 ----------
export function parseRoute(hash = location.hash) {
  const [path, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const seg = path.split('/').filter(Boolean);
  return { name: seg[0] || 'home', params: { id: seg[1] }, query: Object.fromEntries(new URLSearchParams(qs)), path: '/' + seg.join('/') };
}
export const navigate = (p) => { location.hash = '#' + p; };
export const lessonUrl = (id, q = {}) => `/lesson/${id}${Object.keys(q).length ? '?' + new URLSearchParams(q) : ''}`;

// ---------- 小工具 ----------
const replaceBy = (arr, item) => (arr.some((x) => x.id === item.id) ? arr.map((x) => (x.id === item.id ? item : x)) : [...arr, item]);
export const getLesson = (id) => state.lessons.find((l) => l.id === id);
export const getCourse = (id) => state.courses.find((c) => c.id === id);
export const dueClips = (clips = state.clips, now = Date.now()) => queue(clips, now);

export function toast(msg, { undo, kind = 'info', ms = 4500 } = {}) {
  const id = uid('t_');
  setState((s) => ({ toasts: [...s.toasts, { id, msg, undo, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
export const dismissToast = (id) => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
const busy = (k, v) => setState((s) => ({ busy: { ...s.busy, [k]: v } }));

const tcache = new Map();
export async function getCues(lessonId) {
  if (tcache.has(lessonId)) return tcache.get(lessonId);
  const t = await db.get('transcripts', lessonId);
  const cues = t?.cues || [];
  tcache.set(lessonId, cues);
  return cues;
}

async function putLesson(l) {
  await db.put('lessons', l);
  setState((s) => ({ lessons: replaceBy(s.lessons, l) }));
  return l;
}
export async function saveCues(lessonId, cues) {
  await db.put('transcripts', { lessonId, cues });
  tcache.set(lessonId, cues);
  setState((s) => ({ cuesRev: { ...s.cuesRev, [lessonId]: (s.cuesRev[lessonId] || 0) + 1 } })); // 通知 Studio 刷新
  return cues;
}

/** 片段（按句索引）→ 时间区间 */
export function clipTimes(clip, cues) {
  const a = cues[Math.min(clip.startCue, cues.length - 1)], b = cues[Math.min(clip.endCue, cues.length - 1)];
  return a && b ? { start: a.start, end: b.end } : { start: 0, end: 0 };
}

// ---------- 启动 ----------
export async function boot() {
  const mode = await openDb();
  const [courses, lessons, clips, tags, kv] = await Promise.all(['courses', 'lessons', 'clips', 'tags', 'kv'].map((s) => db.all(s)));
  const saved = kv.find((k) => k.key === 'settings')?.value || {};
  const settings = { ...DEFAULTS, ...saved };
  setState({ dbMode: mode, courses, lessons, clips, tags, settings });
  if (!settings.seeded && !courses.length && !lessons.length) await loadSeed();
  getConfig().then((config) => { setApiConfig(config); setState({ config }); });
  window.addEventListener('hashchange', () => setState({ route: parseRoute() }));
  setState({ ready: true });
  if (mode === 'memory') toast('浏览器禁用了本地数据库（隐私模式？）：本次的修改在刷新后会丢失', { kind: 'warn', ms: 12000 });
}

export async function loadSeed() {
  const seed = buildSeed();
  for (const c of seed.courses) await db.put('courses', c);
  for (const l of seed.lessons) await db.put('lessons', l);
  for (const t of seed.transcripts) { await db.put('transcripts', t); tcache.set(t.lessonId, t.cues); }
  for (const c of seed.clips) await db.put('clips', c);
  for (const t of seed.tags) if (!state.tags.some((x) => x.id === t.id)) await db.put('tags', t);
  setState((s) => ({
    courses: [...s.courses, ...seed.courses], lessons: [...s.lessons, ...seed.lessons], clips: [...s.clips, ...seed.clips],
    tags: s.tags.length ? s.tags : seed.tags,
  }));
  await actions.setSetting('seeded', true);
}

// ---------- 动作 ----------
export const actions = {
  async setSetting(k, v) {
    const settings = { ...state.settings, [k]: v };
    setState({ settings });
    await db.put('kv', { key: 'settings', value: settings });
  },

  // ----- 课程 -----
  async createCourse({ name, term = '', srcLang = 'en', color }) {
    const c = { id: uid('c_'), name: name.trim() || '未命名课程', term, srcLang, color: color || ['#3b5bdb', '#0ca678', '#7048e8', '#e8590c', '#d6336c'][state.courses.length % 5], glossary: [], createdAt: Date.now() };
    await db.put('courses', c);
    setState((s) => ({ courses: [...s.courses, c] }));
    return c;
  },
  async updateCourse(id, patch) {
    const c = { ...getCourse(id), ...patch };
    await db.put('courses', c);
    setState((s) => ({ courses: replaceBy(s.courses, c) }));
    return c;
  },
  async deleteCourse(id) {
    for (const l of state.lessons.filter((x) => x.courseId === id)) await actions.deleteLesson(l.id, { silent: true });
    await db.del('courses', id);
    setState((s) => ({ courses: s.courses.filter((c) => c.id !== id) }));
  },
  async findOrCreateCourse(name, srcLang) {
    const n = (name || '').trim();
    return state.courses.find((c) => c.name.toLowerCase() === n.toLowerCase()) || actions.createCourse({ name: n || '未分类', srcLang });
  },

  // ----- 课时 -----
  /** 从导入草稿创建课时。audio 为可选 File。 */
  async importLesson({ draft, courseId, title, date, audio, sourceName }) {
    const id = uid('l_');
    const course = getCourse(courseId);
    const lesson = {
      id, courseId, title: title || draft.title, date: date || draft.date || new Date().toISOString().slice(0, 10), srcLang: draft.srcLang,
      duration: draft.duration, timeline: draft.timeline, hasAudio: !!audio, audioMime: audio?.type || '', parts: draft.parts, anchors: [],
      sourceName: sourceName || '', createdAt: Date.now(), stats: { sentences: draft.cues.length, words: draft.stats.words },
      corrections: scanCorrections(draft.cues, rulesFor(course)),
    };
    await saveCues(id, draft.cues);
    if (audio) await db.put('audio', { lessonId: id, blob: audio, mime: audio.type });
    await putLesson(lesson);
    return lesson;
  },

  /** 实时课堂归档 */
  async saveLive({ courseId, title, srcLang, cues, marks, blob, mime, duration }) {
    const id = uid('l_');
    const course = getCourse(courseId);
    const list = cues.map((c, i) => ({ ...c, i }));
    if (list.length) list[list.length - 1].end = Math.max(list.at(-1).end, duration);
    const parts = titleParts(list, segmentParts(list, { target: 500, min: 300, max: 900, tail: 80 }));
    const lesson = {
      id, courseId, title: title || '实时课堂', date: new Date().toISOString().slice(0, 10), srcLang, duration: Math.max(duration, list.at(-1)?.end || 0),
      timeline: 'real', hasAudio: !!blob, audioMime: mime || '', parts, anchors: [], sourceName: 'live', createdAt: Date.now(),
      stats: { sentences: list.length, words: list.reduce((s, c) => s + c.text.split(/\s+/).length, 0) },
      corrections: scanCorrections(list, rulesFor(course)),
    };
    await saveCues(id, list);
    if (blob) await db.put('audio', { lessonId: id, blob, mime });
    await putLesson(lesson);
    // 课中标记：按标记时刻映射到句子范围（约最近 15 秒）
    for (const m of marks) {
      if (!list.length) break;
      const end = cueAt(list, m.t);
      let start = end;
      while (start > 0 && list[start - 1].end >= m.t - 15) start--;
      await actions.addClip({ lessonId: id, kind: 'stuck', startCue: Math.max(0, Math.min(start, end)), endCue: end, source: 'live' });
    }
    return lesson;
  },

  async updateLesson(id, patch) { return putLesson({ ...getLesson(id), ...patch }); },
  async deleteLesson(id, { silent } = {}) {
    await db.del('lessons', id); await db.del('transcripts', id); await db.del('audio', id);
    tcache.delete(id);
    const mine = state.clips.filter((c) => c.lessonId === id);
    for (const c of mine) await db.del('clips', c.id);
    setState((s) => ({ lessons: s.lessons.filter((l) => l.id !== id), clips: s.clips.filter((c) => c.lessonId !== id) }));
    if (!silent) toast('课时已删除');
  },
  async getAudio(lessonId) { return db.get('audio', lessonId); },
  /** 给已有课时绑定录音：按录音时长重标定估算时间轴 */
  async attachAudio(lessonId, file, duration) {
    const lesson = getLesson(lessonId);
    const cues = [...(await getCues(lessonId))].map((c) => ({ ...c }));
    await db.put('audio', { lessonId, blob: file, mime: file.type });
    if (lesson.timeline !== 'real' && duration > 0) {
      const anchors = lesson.anchors || [];
      if (anchors.length) applyAnchors(cues, anchors, duration);
      else estimateTimeline(cues, { duration });
      await saveCues(lessonId, cues);
    }
    await putLesson({ ...lesson, hasAudio: true, audioMime: file.type, duration: duration || lesson.duration });
  },

  // ----- 时间轴校准 -----
  async addAnchor(lessonId, cueIdx, t) {
    const lesson = getLesson(lessonId);
    const anchors = [...(lesson.anchors || []).filter((a) => a.i !== cueIdx), { i: cueIdx, t }].sort((a, b) => a.i - b.i);
    const cues = (await getCues(lessonId)).map((c) => ({ ...c, anchor: anchors.some((a) => a.i === c.i) || undefined }));
    const total = applyAnchors(cues, anchors, lesson.duration);
    await saveCues(lessonId, cues);
    await putLesson({ ...lesson, anchors, timeline: 'calibrated', duration: Math.max(lesson.duration, total) });
    return cues;
  },
  async clearAnchors(lessonId) {
    const lesson = getLesson(lessonId);
    const cues = (await getCues(lessonId)).map((c) => { const { anchor, ...r } = c; return r; });
    const total = estimateTimeline(cues, { duration: lesson.hasAudio ? lesson.duration : 0 });
    await saveCues(lessonId, cues);
    await putLesson({ ...lesson, anchors: [], timeline: 'estimated', duration: lesson.hasAudio ? lesson.duration : total });
    return cues;
  },

  // ----- 句子编辑 -----
  async editCue(lessonId, idx, text) {
    const cues = (await getCues(lessonId)).map((c) => (c.i === idx ? { ...c, text, raw: c.raw ?? c.text, edited: true } : c));
    await saveCues(lessonId, cues);
    return cues;
  },
  async setCueTranslations(lessonId, patches) {
    const m = new Map(patches.map((p) => [p.i, p.tr]));
    const cues = (await getCues(lessonId)).map((c) => (m.has(c.i) ? { ...c, tr: { ...c.tr, ...m.get(c.i) } } : c));
    await saveCues(lessonId, cues);
    return cues;
  },

  // ----- 片段 / 卡点 -----
  async addClip(p) {
    const clip = {
      id: uid('cl_'), kind: 'stuck', reason: '', note: '', tags: [], status: 'open', source: 'manual', createdAt: Date.now(),
      ...p, practice: p.practice ?? (p.kind ?? 'stuck') === 'stuck', srs: newSrs(),
    };
    await db.put('clips', clip);
    setState((s) => ({ clips: [...s.clips, clip] }));
    return clip;
  },
  async updateClip(id, patch) {
    const clip = { ...state.clips.find((c) => c.id === id), ...patch };
    await db.put('clips', clip);
    setState((s) => ({ clips: replaceBy(s.clips, clip) }));
    return clip;
  },
  async deleteClip(id) {
    await db.del('clips', id);
    setState((s) => ({ clips: s.clips.filter((c) => c.id !== id) }));
  },
  async rateClip(id, rating, extra) {
    const clip = state.clips.find((c) => c.id === id);
    const { srs, status } = review(clip.srs, rating, extra);
    return actions.updateClip(id, { srs, status });
  },

  // ----- 标签 -----
  async addTag(name, color) {
    const t = { id: uid('tag_'), name: name.trim(), color };
    await db.put('tags', t);
    setState((s) => ({ tags: [...s.tags, t] }));
    return t;
  },
  async deleteTag(id) {
    await db.del('tags', id);
    setState((s) => ({ tags: s.tags.filter((t) => t.id !== id) }));
    for (const c of state.clips.filter((c) => c.tags?.includes(id))) await actions.updateClip(c.id, { tags: c.tags.filter((t) => t !== id) });
  },

  // ----- 笔记 -----
  async runNotes(lessonId) {
    const key = `notes:${lessonId}`;
    busy(key, true);
    try {
      const lesson = getLesson(lessonId), course = getCourse(lesson.courseId), cues = await getCues(lessonId);
      let parts = lesson.parts, notes = null, source = 'offline', model = null, fallbackReason = null;
      if (aiAvailable()) {
        try {
          const r = await aiNotes({ course: course?.name, title: lesson.title, noteLang: state.settings.noteLang, cues: cues.map((c) => ({ i: c.i, t: c.text })) });
          const n = r.notes;
          source = 'claude'; model = r.model;
          if (n.parts?.length >= 2) parts = n.parts.map((p, k) => ({ id: `p${k + 1}`, title: p.title || `Part ${k + 1}`, startCue: p.startCue, endCue: (n.parts[k + 1]?.startCue ?? cues.length) - 1, summary: p.summary }));
          notes = { overview: n.overview, keyPoints: n.keyPoints, concepts: n.concepts, formulas: n.formulas, emphasized: n.emphasized, questions: n.questions };
        } catch (e) {
          fallbackReason = e.message;
          toast(`AI 这次没有返回结果（${e.message}）。已生成离线版，可稍后重试。`, { kind: 'warn', ms: 8000 });
        }
      } else fallbackReason = '未配置 Claude 密钥（可在“设置”里填写）';
      if (!notes) {
        const off = offlineNotes(cues, parts);
        parts = parts.map((p) => ({ ...p, summary: p.summary || off.partSummaries[p.id] || '' })); // 只填补空白，不覆盖已有摘要
        const { partSummaries, source: _s, ...rest } = off;
        notes = rest;
      }
      await putLesson({ ...lesson, parts, notes: { ...notes, source, model, fallbackReason, generatedAt: Date.now(), userNotes: lesson.notes?.userNotes || '' } });
    } finally { busy(key, false); }
  },
  async setUserNotes(lessonId, text) {
    const l = getLesson(lessonId);
    await putLesson({ ...l, notes: { ...(l.notes || { source: 'none', keyPoints: [], concepts: [], formulas: [], emphasized: [], questions: [], overview: '' }), userNotes: text } });
  },
  async setPartSummary(lessonId, partId, summary) {
    const l = getLesson(lessonId);
    await putLesson({ ...l, parts: l.parts.map((p) => (p.id === partId ? { ...p, summary } : p)) });
  },

  // ----- 语言拆解 -----
  async runLanguage(lessonId) {
    const key = `lang:${lessonId}`;
    busy(key, true);
    try {
      const lesson = getLesson(lessonId), course = getCourse(lesson.courseId), cues = await getCues(lessonId);
      const prevVocab = new Map((lesson.language?.vocab || []).map((v) => [v.term.toLowerCase(), v.status]));
      let vocab, patterns, extraCorr = [], source = 'offline', model = null, fallbackReason = null;
      if (aiAvailable()) {
        try {
          const r = await aiLanguage({ course: course?.name, title: lesson.title, explainLang: state.settings.noteLang, cues: cues.map((c) => ({ i: c.i, t: c.text })), glossary: (course?.glossary || []).map((g) => g.term) });
          vocab = r.language.vocab; patterns = r.language.patterns; extraCorr = r.language.corrections;
          source = 'claude'; model = r.model;
        } catch (e) {
          fallbackReason = e.message;
          toast(`AI 这次没有返回结果（${e.message}）。已生成离线版，可稍后重试。`, { kind: 'warn', ms: 8000 });
        }
      } else fallbackReason = '未配置 Claude 密钥（可在“设置”里填写）';
      if (!vocab) { vocab = offlineVocab(cues, course?.glossary || []); patterns = detectPatterns(cues); }
      vocab = vocab.map((v) => ({ ...v, status: prevVocab.get(v.term.toLowerCase()) || v.status || 'new' }));
      // 纠错：保留已有条目（含已采纳/已忽略），追加离线规则扫描与 AI 新发现的建议（按 wrong 去重）
      const existing = lesson.corrections || [];
      const seen = new Set(existing.map((c) => c.wrong.toLowerCase()));
      const corrections = [...existing];
      for (const m of [...scanCorrections(cues, rulesFor(course), existing), ...extraCorr.map((c) => ({ ...c, src: 'claude' }))]) {
        if (seen.has(m.wrong.toLowerCase())) continue;
        seen.add(m.wrong.toLowerCase());
        corrections.push(m);
      }
      await putLesson({ ...lesson, corrections, language: { source, model, fallbackReason, generatedAt: Date.now(), vocab, patterns } });
    } finally { busy(key, false); }
  },
  async setVocabStatus(lessonId, term, status) {
    const l = getLesson(lessonId);
    await putLesson({ ...l, language: { ...l.language, vocab: l.language.vocab.map((v) => (v.term === term ? { ...v, status } : v)) } });
  },
  /** 重新扫描纠错建议（术语表变化后） */
  async rescanCorrections(lessonId) {
    const l = getLesson(lessonId), course = getCourse(l.courseId), cues = await getCues(lessonId);
    const fresh = scanCorrections(cues, rulesFor(course), l.corrections || []);
    await putLesson({ ...l, corrections: [...(l.corrections || []), ...fresh] });
    return fresh.length;
  },
  /** 设置某条纠错的状态：pending / applied / ignored。applied 会改写全文并保留 raw。 */
  async setCorrection(lessonId, wrong, next) {
    const l = getLesson(lessonId);
    let cues = (await getCues(lessonId)).map((c) => ({ ...c, fx: c.fx ? [...c.fx] : undefined }));
    const corr = l.corrections.find((c) => c.wrong === wrong);
    if (!corr || corr.state === next) return;
    if (next === 'applied') applyCorrection(cues, corr);
    else if (corr.state === 'applied') revertCorrection(cues, corr);
    cues.forEach((c) => { if (c.fx === undefined) delete c.fx; });
    await saveCues(lessonId, cues);
    await putLesson({ ...l, corrections: l.corrections.map((c) => (c.wrong === wrong ? { ...c, state: next } : c)) });
  },
  async applyAllCorrections(lessonId) {
    const l = getLesson(lessonId);
    for (const c of l.corrections.filter((c) => c.state === 'pending')) await actions.setCorrection(lessonId, c.wrong, 'applied');
  },

  // ----- 搜索 -----
  async search(q, limit = 120) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    for (const l of state.lessons) {
      const cues = await getCues(l.id);
      for (const c of cues) {
        if (c.text.toLowerCase().includes(q) || c.tr?.zh?.toLowerCase().includes(q) || c.tr?.fr?.toLowerCase().includes(q)) {
          out.push({ lessonId: l.id, courseId: l.courseId, i: c.i, start: c.start, text: c.text, tr: c.tr });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  },

  // ----- 数据 -----
  async exportData() { return exportAll(); },
  async importData(json) {
    await importAll(json);
    tcache.clear();
    const [courses, lessons, clips, tags] = await Promise.all(['courses', 'lessons', 'clips', 'tags'].map((s) => db.all(s)));
    setState({ courses, lessons, clips, tags });
  },
  async resetAll() {
    await clearAll();
    tcache.clear();
    setState({ courses: [], lessons: [], clips: [], tags: [], settings: { ...DEFAULTS, seeded: true } });
    await db.put('kv', { key: 'settings', value: { ...DEFAULTS, seeded: true } });
    for (const t of DEFAULT_TAGS) await db.put('tags', t);
    setState({ tags: DEFAULT_TAGS });
  },
  async removeSamples() {
    for (const l of state.lessons.filter((x) => x.sample)) await actions.deleteLesson(l.id, { silent: true });
    for (const c of state.courses.filter((x) => x.sample)) { await db.del('courses', c.id); }
    setState((s) => ({ courses: s.courses.filter((c) => !c.sample) }));
    toast('示例数据已删除');
  },
  setUi(patch) { setState((s) => ({ ui: { ...s.ui, ...patch } })); },
  /** 浏览器密钥变化后让依赖 AI 可用性的界面重新渲染 */
  touchConfig() { setState((s) => ({ config: { ...(s.config || {}) } })); },
};

// 笔记字段更新（概览等）
actions.updateNotes = async (lessonId, patch) => {
  const l = getLesson(lessonId);
  await putLesson({ ...l, notes: { ...(l.notes || { source: 'none', keyPoints: [], concepts: [], formulas: [], emphasized: [], questions: [], overview: '', userNotes: '' }), ...patch } });
};

// 手动把一个词加入课时词汇（例如听写时漏听的词）；离线词典里有则带上释义
actions.addVocabTerm = async (lessonId, term, cue) => {
  const l = getLesson(lessonId);
  const t = term.trim();
  if (!t) return false;
  const lang = l.language || { source: 'manual', generatedAt: Date.now(), vocab: [], patterns: [] };
  if (lang.vocab.some((v) => v.term.toLowerCase() === t.toLowerCase())) return false;
  const d = DOMAIN.find((x) => x.term === t.toLowerCase() || x.aliases.includes(t.toLowerCase()));
  const item = { term: d?.term || t, pos: d?.pos || '', kind: 'term', def: d?.def || { zh: '', en: '', fr: '' }, cue, count: 1, heardAs: [], status: 'new', manual: true };
  await putLesson({ ...l, language: { ...lang, vocab: [item, ...lang.vocab] } });
  return true;
};

// 实时课堂草稿（每 30 秒落盘，意外关闭后可恢复为课时）
actions.saveLiveDraft = (draft) => db.put('kv', { key: 'liveDraft', value: draft });
actions.getLiveDraft = async () => (await db.get('kv', 'liveDraft'))?.value || null;
actions.clearLiveDraft = () => db.del('kv', 'liveDraft');
