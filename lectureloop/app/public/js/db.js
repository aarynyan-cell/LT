// IndexedDB 薄封装。IndexedDB 不可用（隐私模式等）时自动退化为内存存储，保证应用仍可使用。
const DB_NAME = 'lectureloop';
const VERSION = 1;
const STORES = {
  courses: { keyPath: 'id' },
  lessons: { keyPath: 'id', indexes: ['courseId'] },
  transcripts: { keyPath: 'lessonId' },
  audio: { keyPath: 'lessonId' },
  clips: { keyPath: 'id', indexes: ['lessonId'] },
  tags: { keyPath: 'id' },
  kv: { keyPath: 'key' },
};

let idb = null;
let mode = 'idb';
const mem = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function openDb() {
  try {
    if (!('indexedDB' in globalThis)) throw new Error('no indexedDB');
    idb = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const [name, o] of Object.entries(STORES)) {
          if (d.objectStoreNames.contains(name)) continue;
          const s = d.createObjectStore(name, { keyPath: o.keyPath });
          for (const ix of o.indexes || []) s.createIndex(ix, ix);
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
    mode = 'idb';
  } catch (e) {
    console.warn('[db] IndexedDB 不可用，改用内存存储', e);
    mode = 'memory';
  }
  return mode;
}

const keyOf = (store, v) => v[STORES[store].keyPath];
const store = (name, rw = 'readonly') => idb.transaction(name, rw).objectStore(name);

export const db = {
  get mode() { return mode; },
  async get(name, key) {
    if (mode === 'memory') return mem[name].get(key);
    return req(store(name).get(key));
  },
  async put(name, val) {
    if (mode === 'memory') { mem[name].set(keyOf(name, val), val); return val; }
    await req(store(name, 'readwrite').put(val));
    return val;
  },
  async del(name, key) {
    if (mode === 'memory') { mem[name].delete(key); return; }
    await req(store(name, 'readwrite').delete(key));
  },
  async all(name) {
    if (mode === 'memory') return [...mem[name].values()];
    return req(store(name).getAll());
  },
  async where(name, index, value) {
    if (mode === 'memory') return [...mem[name].values()].filter((v) => v[index] === value);
    return req(store(name).index(index).getAll(value));
  },
  async clear(name) {
    if (mode === 'memory') { mem[name].clear(); return; }
    await req(store(name, 'readwrite').clear());
  },
};

/** 导出全部数据（不含音频） */
export async function exportAll() {
  const out = { app: 'lectureloop', version: 1, exportedAt: new Date().toISOString() };
  for (const s of Object.keys(STORES)) if (s !== 'audio') out[s] = await db.all(s);
  return out;
}

export async function importAll(json, { replace = true } = {}) {
  if (json?.app !== 'lectureloop') throw new Error('不是 LectureLoop 备份文件');
  if (replace) for (const s of Object.keys(STORES)) await db.clear(s);
  for (const s of Object.keys(STORES)) {
    if (s === 'audio') continue;
    for (const v of json[s] || []) await db.put(s, v);
  }
}

export async function clearAll() {
  for (const s of Object.keys(STORES)) await db.clear(s);
}
