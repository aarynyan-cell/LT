// 后端客户端 + AI 路由：本地服务（密钥在服务端）→ 浏览器自带密钥（在线版）→ 离线。失败统一抛出 ApiError{code,message}。
import { ApiError } from './errors.js';
import { byok } from './byok.js';
export { ApiError };

let cfg = null;
/** 启动时由 store 写入 /api/config 的结果；在线静态版没有后端时为 { server:false, ... } */
export const setApiConfig = (c) => { cfg = c; };
/** 当前 AI 来源：'server' | 'browser' | null */
export const aiSource = () => (cfg?.claude ? 'server' : byok.key ? 'browser' : null);
export const aiAvailable = () => aiSource() !== null;

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

// 相对路径：本地版服务在根路径；在线静态版没有后端，请求会 404，或被托管平台（如 Cloudflare Pages）
// 回退成 index.html（状态 200）——所以必须校验返回的是不是 LectureLoop 的配置，而不是只看状态码。
const STATIC_CONFIG = { server: false, claude: false, translate: { google: false, claude: false }, translateAny: false };
export const getConfig = () => call('api/config')
  .then((j) => (j && typeof j.version === 'string' ? { ...j, server: true } : STATIC_CONFIG))
  .catch(() => STATIC_CONFIG);

export async function aiNotes(p) {
  if (cfg?.claude) return call('api/ai/notes', p, { timeout: 300_000 });
  if (byok.key) return (await import('./claude-browser.js')).notesInBrowser(p);
  throw new ApiError('no_key', '未配置 Claude 密钥');
}
export async function aiLanguage(p) {
  if (cfg?.claude) return call('api/ai/language', p, { timeout: 300_000 });
  if (byok.key) return (await import('./claude-browser.js')).languageInBrowser(p);
  throw new ApiError('no_key', '未配置 Claude 密钥');
}

/** items: [{i,t}] → { provider, results: { zh: [{i,t}], fr: [...] } } */
export const translateRemote = (p) => call('api/translate', p, { timeout: 30_000 });

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

export const translateAvailable = () => !!(cfg?.translateAny || byok.key || 'Translator' in self);

/**
 * 统一翻译入口：本地服务(Google/Claude) → 浏览器自带 Claude 密钥 → 浏览器内置翻译 → 抛错（调用方静默降级为仅原文）
 */
export async function translate({ source, targets, items, context = [], glossary = [] }) {
  targets = targets.filter((t) => t !== source);
  if (!targets.length || !items.length) return { provider: 'none', results: {} };
  if (cfg?.translateAny) return translateRemote({ source, targets, items, context, glossary });
  if (byok.key) return (await import('./claude-browser.js')).translateInBrowser({ source, targets, items, context, glossary });
  const results = {};
  for (const t of targets) {
    if (!(await localTranslatorAvailable(source, t))) throw new ApiError('no_provider', '未配置翻译服务');
    results[t] = await translateLocal(source, t, items);
  }
  return { provider: 'chrome', results };
}
