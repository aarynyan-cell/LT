// 本地数据库（IndexedDB，扩展自己的源，网页读不到）：
//   videos  每个视频一份转录（句子 + 译文）
//   tm      翻译记忆
//   saved   收藏的单词 / 句子
// 后台（service worker）与侧边栏页面都可以直接访问；内容脚本不能（要通过后台消息）。
import { mergeLines } from './transcript.js';

const NAME = 'lectureloop-subs';
const TM_MAX = 40_000, TM_PRUNE = 8_000;
let dbp;
const db = () => (dbp ||= new Promise((res, rej) => {
  const r = indexedDB.open(NAME, 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('videos', { keyPath: 'key' });
    d.createObjectStore('tm', { keyPath: 'k' }).createIndex('ts', 'ts');
    d.createObjectStore('saved', { keyPath: 'id' }).createIndex('ts', 'ts');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));

/** 在一个事务里执行 fn(store…)，事务完成后返回 fn 的返回值（fn 可返回 IDBRequest） */
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const out = fn(...[].concat(stores).map((s) => t.objectStore(s)), t);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// ---------- 转录 ----------
export const getVideo = (key) => run('videos', 'readonly', (s) => s.get(key));
export const listVideos = () => run('videos', 'readonly', (s) => s.getAll());
export const deleteVideo = (key) => run('videos', 'readwrite', (s) => s.delete(key));
/** 读 → 合并 → 写，在同一个事务里，不会丢并发写入 */
export async function upsertVideo(meta, lines) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('videos', 'readwrite');
    const s = t.objectStore('videos');
    const g = s.get(meta.key);
    g.onsuccess = () => {
      const cur = g.result || { key: meta.key, lines: [] };
      const next = { ...cur, ...meta, lines: mergeLines(cur.lines, lines), updated: Date.now() };
      s.put(next);
    };
    t.oncomplete = () => res(true);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// ---------- 翻译记忆 ----------
export async function tmGetMany(keys) {
  const out = new Map();
  if (!keys.length) return out;
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('tm', 'readonly');
    const s = t.objectStore('tm');
    for (const k of keys) s.get(k).onsuccess = (e) => { if (e.target.result) out.set(k, e.target.result); };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
export async function tmPutMany(entries) {
  await run('tm', 'readwrite', (s) => { for (const e of entries) s.put(e); });
  const n = await run('tm', 'readonly', (s) => s.count());
  if (n > TM_MAX) await tmPrune(n - TM_MAX + TM_PRUNE);
}
async function tmPrune(count) {
  await run('tm', 'readwrite', (s) => {
    let left = count;
    s.index('ts').openCursor().onsuccess = (e) => { const c = e.target.result; if (c && left-- > 0) { c.delete(); c.continue(); } };
  });
}

// ---------- 收藏 ----------
export const savedAll = () => run('saved', 'readonly', (s) => s.getAll());
export const savedPut = (item) => run('saved', 'readwrite', (s) => s.put({ ...item, ts: item.ts || Date.now() }));
export const savedDelete = (id) => run('saved', 'readwrite', (s) => s.delete(id));

// ---------- 统计 / 清理 ----------
export async function stats() {
  const [videos, tm, saved] = await Promise.all([run('videos', 'readonly', (s) => s.count()), run('tm', 'readonly', (s) => s.count()), run('saved', 'readonly', (s) => s.count())]);
  return { videos, tm, saved };
}
export const clearTranscripts = async () => { await run('videos', 'readwrite', (s) => s.clear()); await run('tm', 'readwrite', (s) => s.clear()); };
