// 实时听课控制器（全局单例）。
//
// 录音会话不再属于"上课"页面：切换到课程库 / Studio / 设置，甚至切到别的浏览器标签，录音和字幕都不会停。
// 页面（上课页、悬浮字幕、顶部录音条）只订阅这里的状态并调用这里的方法。
//
// 防止后台被中断的措施：
//  - 识别被浏览器自动结束时立即重启（不依赖定时器：后台标签的定时器会被降频到每秒甚至每分钟一次）
//  - 页面在后台时，翻译立即发送，不做防抖
//  - 录音期间申请屏幕常亮（Wake Lock），避免电脑合盖/休眠前屏幕熄灭导致系统睡眠
//  - 关闭/刷新页面前提示；每 30 秒写草稿，意外关闭后可恢复
import { useState, useEffect, useRef } from '../h.js';
import { LiveSession } from './asr.js';
import { translate } from './api.js';
import { buildSeed } from './seed.js';
import { fmtTime, uid } from './util.js';
import { actions, getState, getCourse, toast } from '../store.js';

const demoCues = () => buildSeed().transcripts.find((t) => t.lessonId === 'l_seed_ml1').cues;

const INITIAL = { phase: 'idle', source: 'mic', lang: 'en', courseId: '', title: '', targets: [], lines: [], interim: '', marks: 0, status: '', trErr: null, flash: null };
let state = { ...INITIAL };
const subs = new Set();
const set = (p) => { state = { ...state, ...p }; subs.forEach((f) => f(state)); };

let ses = null;
let marks = [];
let pending = [];
let flushTimer = 0;
let flashTimer = 0;
let draftTimer = 0;
let titleTimer = 0;
let wakeLock = null;
let glossary = [];

export const getLive = () => state;
export const liveElapsed = () => ses?.elapsed() || 0;
export const isLive = () => state.phase !== 'idle';

/** 订阅直播状态；selector 返回值变化时才重新渲染（避免逐词刷新整个页面） */
export function useLive(sel = (s) => s) {
  const [, force] = useState(0);
  const selRef = useRef(sel); selRef.current = sel;
  const last = useRef(); last.current = sel(state);
  useEffect(() => {
    const f = (s) => { if (!Object.is(selRef.current(s), last.current)) force((n) => n + 1); };
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return last.current;
}

const stripIds = () => state.lines.map(({ id, ...c }) => c);
const saveDraft = () => state.lines.length && actions.saveLiveDraft({ courseId: state.courseId, title: state.title, lang: state.lang, lines: stripIds(), marks, ts: Date.now() });

// ---------- 翻译队列 ----------
async function flush() {
  const idxs = pending.splice(0);
  if (!idxs.length || !state.targets.length) return;
  const items = idxs.map((i) => ({ i, t: state.lines[i].text }));
  const context = state.lines.slice(Math.max(0, idxs[0] - 3), idxs[0]).map((l) => l.text);
  try {
    const r = await translate({ source: state.lang, targets: state.targets, items, context, glossary });
    const next = [...state.lines];
    for (const [tl, arr] of Object.entries(r.results || {})) for (const { i, t } of arr) if (next[i] && t) next[i] = { ...next[i], tr: { ...next[i].tr, [tl]: t } };
    set({ lines: next, trErr: null });
  } catch (e) {
    set({ trErr: e.message || '翻译不可用' });
  }
}

function onFinal(c) {
  set({ lines: [...state.lines, { ...c, id: uid('ln_') }] });
  const idx = state.lines.length - 1;
  if (!state.targets.filter((t) => !c.tr?.[t]).length) return; // 演示课堂自带参考译文
  pending.push(idx);
  clearTimeout(flushTimer);
  // 后台标签的定时器会被降频：页面不可见时立即发送
  if (pending.length >= 4 || document.hidden) flush(); else flushTimer = setTimeout(flush, 700);
}

// ---------- 保持运行 ----------
async function holdWakeLock() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 不支持或被拒绝：忽略 */ }
}
const onVisibility = () => { if (isLive() && getState().settings.keepAwake !== false) holdWakeLock(); };
const onBeforeUnload = (e) => { saveDraft(); e.preventDefault(); e.returnValue = ''; };

function attach() {
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);
  if (getState().settings.keepAwake !== false) holdWakeLock();
  draftTimer = setInterval(saveDraft, 30_000);
  const base = document.title.replace(/^● .*? · /, '');
  titleTimer = setInterval(() => { document.title = `● ${fmtTime(liveElapsed())} · ${base}`; }, 1000);
  attach.base = base;
}
function detach() {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('beforeunload', onBeforeUnload);
  clearInterval(draftTimer); clearInterval(titleTimer);
  if (attach.base) document.title = attach.base;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
}

// ---------- 对外方法 ----------
export const live = {
  /** @param {{courseId:string, lang:string, title:string, source:'mic'|'demo', targets:string[], demoSpeed?:number}} o */
  async start(o) {
    if (isLive()) return false;
    marks = []; pending = [];
    const lang = o.source === 'demo' ? 'en' : o.lang;
    glossary = (getCourse(o.courseId)?.glossary || []).map((g) => g.term);
    set({ ...INITIAL, phase: 'starting', source: o.source, lang, courseId: o.courseId, title: o.title, targets: o.targets.filter((t) => t !== lang).slice(0, 2) });
    const s = new LiveSession({
      lang, source: o.source, demoCues: o.source === 'demo' ? demoCues() : null, demoSpeed: o.demoSpeed || 2.2,
      onInterim: (t) => set({ interim: t }), onFinal, onStatus: (st) => set({ status: st }),
      onError: (code) => { set({ status: 'error' }); toast(`语音识别出错（${code}）。可改用“演示课堂”或导入转录。`, { kind: 'warn', ms: 9000 }); },
    });
    try {
      await s.start();
    } catch (e) {
      set({ ...INITIAL });
      throw e;
    }
    ses = s;
    set({ phase: 'running' });
    attach();
    return true;
  },
  pause() { if (state.phase !== 'running') return; ses.pause(); set({ phase: 'paused' }); },
  resume() { if (state.phase !== 'paused') return; ses.resume(); set({ phase: 'running' }); },
  mark() {
    if (state.phase !== 'running' || !ses) return;
    const t = ses.elapsed();
    marks.push({ t });
    set({ marks: marks.length, flash: `✓ 已标记 ${fmtTime(t)}` });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => set({ flash: null }), 1600);
  },
  /** 结束并归档，返回新课时；没有识别到内容时返回 null */
  async stop() {
    if (!ses || state.phase === 'saving') return null;
    set({ phase: 'saving' });
    clearTimeout(flushTimer);
    await Promise.race([flush(), new Promise((r) => setTimeout(r, 3000))]); // 最后一批译文：尽力而为
    const s = ses;
    ses = null;
    detach();
    const { blob, mime, duration } = await s.stop();
    const { lines, courseId, title, lang, source } = state;
    const m = marks;
    marks = [];
    let lesson = null;
    if (lines.length) {
      lesson = await actions.saveLive({ courseId, title: title.trim() || '实时课堂', srcLang: lang, cues: lines.map(({ id, ...c }) => c), marks: m, blob: source === 'demo' ? null : blob, mime, duration });
    }
    await actions.clearLiveDraft();
    set({ ...INITIAL });
    return lesson;
  },
  /** 放弃当前会话（不归档，草稿仍保留） */
  async abort() {
    if (!ses) return;
    saveDraft();
    detach();
    const s = ses; ses = null;
    await s.stop();
    set({ ...INITIAL });
  },
  setTitle(title) { set({ title }); },
};
