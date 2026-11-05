// 后端客户端：/api/config、/api/translate、/api/ai/*。失败统一抛出 ApiError{code,message}。
export class ApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

async function call(url, body, { timeout = 120_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j?.error?.code || 'upstream', j?.error?.message || `HTTP ${r.status}`, r.status);
    return j;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(e.name === 'AbortError' ? 'timeout' : 'network', e.name === 'AbortError' ? '请求超时' : '无法连接后端（请确认已运行 npm start）');
  } finally {
    clearTimeout(timer);
  }
}

export const getConfig = () => call('/api/config').catch(() => ({ claude: false, translate: { google: false, claude: false }, translateAny: false, offline: true }));

export const aiNotes = (p) => call('/api/ai/notes', p, { timeout: 300_000 });
export const aiLanguage = (p) => call('/api/ai/language', p, { timeout: 300_000 });

/** items: [{i,t}] → { provider, results: { zh: [{i,t}], fr: [...] } } */
export const translateRemote = (p) => call('/api/translate', p, { timeout: 30_000 });

// ---- 浏览器内置 Translator API（Chrome 新版；实验性降级）----
const BCP = { zh: 'zh', en: 'en', fr: 'fr' };
const localCache = new Map();
export async function localTranslatorAvailable(source, target) {
  try {
    if (!('Translator' in self)) return false;
    const a = await self.Translator.availability({ sourceLanguage: BCP[source], targetLanguage: BCP[target] });
    return a === 'available' || a === 'downloadable' || a === 'downloading';
  } catch { return false; }
}
export async function translateLocal(source, target, items) {
  const key = `${source}>${target}`;
  let tr = localCache.get(key);
  if (!tr) {
    tr = await self.Translator.create({ sourceLanguage: BCP[source], targetLanguage: BCP[target] });
    localCache.set(key, tr);
  }
  const out = [];
  for (const it of items) out.push({ i: it.i, t: await tr.translate(it.t) });
  return out;
}

/**
 * 统一翻译入口：后端(Google/Claude) → 浏览器内置 → 抛错（调用方静默降级为仅原文）
 */
export async function translate({ source, targets, items, context = [], glossary = [], config }) {
  targets = targets.filter((t) => t !== source);
  if (!targets.length || !items.length) return { provider: 'none', results: {} };
  if (config?.translateAny) return translateRemote({ source, targets, items, context, glossary });
  const results = {};
  for (const t of targets) {
    if (!(await localTranslatorAvailable(source, t))) throw new ApiError('no_provider', '未配置翻译服务');
    results[t] = await translateLocal(source, t, items);
  }
  return { provider: 'chrome', results };
}
