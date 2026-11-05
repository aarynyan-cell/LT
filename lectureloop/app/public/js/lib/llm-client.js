// 浏览器端的统一 AI 客户端：按"笔记/词汇"与"实时翻译"各自选中的服务商调用。
//   Anthropic → 官方 SDK 的浏览器打包（流式 + 结构化输出 + 服务端 fallbacks）
//   其它      → OpenAI 兼容接口（llm-openai.js）；浏览器跨域被拦截时自动走同源中继（/relay）
// 提示词、Schema 与结果校验在共享的 ai-tasks.js，所有服务商完全一致。
import { ApiError } from './errors.js';
import { byok } from './byok.js';
import { PROVIDERS, detectProvider, pickModels } from './providers.js';
import { askJsonOpenAI, listModels } from './llm-openai.js';
import { notesTask, sanitizeNotes, languageTask, sanitizeLanguage, translateTask, alignTranslation, supportsServerFallback, FALLBACK_BETA, looksLikeNotes, looksLikeLanguage } from './ai-tasks.js';

// ---------- 中继 ----------
const relay = { checked: false, ok: false };
async function relayAvailable() {
  if (relay.checked) return relay.ok;
  relay.checked = true;
  try { relay.ok = !!(await (await fetch('relay')).json()).relay; } catch { relay.ok = false; }
  return relay.ok;
}
/** 对 CORS 情况未知的服务商：先直连，网络层失败（TypeError，通常是跨域）再走中继 */
export function fetchFor(p) {
  return async (url, init = {}) => {
    if (p.cors === 'yes' || p.cors === 'direct') return fetch(url, init);
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!(e instanceof TypeError) || !(await relayAvailable())) throw e;
      return fetch('relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ?? null }) });
    }
  };
}

// ---------- Anthropic（官方 SDK 浏览器版）----------
let Anthropic = null;
let client = null;
let sig = '';
async function anthropicClient(key, base) {
  Anthropic ||= (await import('../../vendor/anthropic-sdk.mjs')).default;
  const s = `${key}|${base}`;
  if (!client || s !== sig) {
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, ...(base ? { baseURL: base } : {}) }); // 密钥属于用户本人，只在本人浏览器里使用
    sig = s;
  }
  return client;
}
function wrapAnthropic(e) {
  if (e instanceof ApiError) return e;
  if (Anthropic) {
    if (e instanceof Anthropic.AuthenticationError) return new ApiError('auth', 'Claude 密钥无效或无权限', 401);
    if (e instanceof Anthropic.PermissionDeniedError) return new ApiError('auth', '这个密钥没有调用该模型的权限', 403);
    if (e instanceof Anthropic.RateLimitError) return new ApiError('rate_limit', 'Claude 请求过于频繁或额度不足，请稍后重试', 429);
    if (e instanceof Anthropic.BadRequestError) return new ApiError('bad_request', `Claude 拒绝了请求参数：${e.message}`, 400);
    if (e instanceof Anthropic.APIConnectionError) return new ApiError('network', '无法连接 Claude API（网络或浏览器拦截）', 0);
    if (e instanceof Anthropic.APIError) return new ApiError('upstream', `Claude API 错误 ${e.status}：${e.message}`, e.status || 0);
  }
  return new ApiError('upstream', String(e?.message || e));
}
async function askAnthropic({ key, model, base }, { system, user, schema, effort, maxTokens }) {
  const c = await anthropicClient(key, base);
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { effort, format: { type: 'json_schema', schema } } };
  const fb = supportsServerFallback(model);
  let msg;
  try {
    msg = fb ? await c.beta.messages.stream({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }).finalMessage() : await c.messages.stream(body).finalMessage();
  } catch (e) {
    if (fb && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message || '')) {
      try { msg = await c.messages.stream(body).finalMessage(); } catch (e2) { throw wrapAnthropic(e2); }
    } else throw wrapAnthropic(e);
  }
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new ApiError('refusal', `模型拒绝了该请求（${d.category || 'unknown'}）${d.explanation ? '：' + d.explanation : ''}`, 422);
  }
  if (msg.stop_reason === 'max_tokens') throw new ApiError('max_tokens', '输出被截断（超过 max_tokens），请缩短输入', 422);
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { data: JSON.parse(text), model: msg.model || model }; } catch { throw new ApiError('bad_json', '模型返回的内容不是有效 JSON'); }
}

// ---------- 统一入口 ----------
async function ask(sel, task) {
  if (!sel) throw new ApiError('no_key', '未设置 API 密钥');
  if (!sel.model) throw new ApiError('no_model', `请先为 ${sel.provider.name} 选择模型`);
  if (sel.provider.kind === 'anthropic') return askAnthropic(sel, task);
  return askJsonOpenAI({ p: sel.provider, key: sel.key, model: sel.model, base: sel.base || sel.provider.base, fetchFn: fetchFor(sel.provider), ...task });
}

export async function notesInBrowser(p) {
  const { data, model } = await ask(byok.sel('main'), notesTask(p));
  if (!looksLikeNotes(data)) throw new ApiError('bad_json', '模型返回的结构不符合要求（可换一个更强的模型）');
  return { model, notes: sanitizeNotes(data, p.cues.length) };
}
export async function languageInBrowser(p) {
  const { data, model } = await ask(byok.sel('main'), languageTask(p));
  if (!looksLikeLanguage(data)) throw new ApiError('bad_json', '模型返回的结构不符合要求（可换一个更强的模型）');
  return { model, language: sanitizeLanguage(data, p.cues) };
}
export async function translateInBrowser({ source, targets, items, context = [], glossary = [] }, sel = byok.sel('fast')) {
  const results = {};
  await Promise.all(targets.filter((t) => t !== source).map(async (target) => {
    const { data } = await ask(sel, translateTask({ items, source, target, context, glossary }));
    const out = alignTranslation(items, data);
    if (!out) throw new ApiError('bad_json', '翻译结果为空');
    results[target] = out;
  }));
  return { provider: sel?.id || 'browser', results };
}

/** 用某个已保存的服务商翻译一句话，验证"能真正调用"（比只列模型更接近真实使用） */
export async function testProvider(id) {
  const e = byok.get(id);
  const provider = PROVIDERS[id];
  if (!e) throw new ApiError('no_key', '未保存该服务商的密钥');
  const picked = pickModels(provider, e.models || []);
  const sel = { id, provider, key: e.key, model: e.fastModel || e.model || picked.fast || picked.main, base: e.base || byok.baseOverride(id) || '' };
  const r = await translateInBrowser({ source: 'en', targets: ['zh'], items: [{ i: 0, t: 'Okay, so today we talk about decision trees.' }] }, sel);
  return r.results.zh?.[0]?.t || '';
}

// ---------- 识别 + 探测 ----------
async function anthropicModels(key, base) {
  let r;
  try {
    r = await fetch(`${base || PROVIDERS.anthropic.base}/v1/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
  } catch (e) {
    throw new ApiError('network', '无法连接 Anthropic（网络问题）');
  }
  if (r.status === 401 || r.status === 403) throw new ApiError('auth', '密钥无效或无权限', r.status);
  if (!r.ok) throw new ApiError('upstream', `HTTP ${r.status}`, r.status);
  return ((await r.json()).data || []).map((m) => m.id);
}

/**
 * 识别并验证密钥：按格式得到候选服务商，逐个调用其 /models，第一个返回成功的就是它。
 * @param {{candidates?:string[], base?:string}} opts  candidates 指定服务商（高级选项）；base 为自定义 Base URL
 * @returns {Promise<{ok:true,id:string,models:string[],main:string|null,fast:string|null}|{ok:false,tried:{id:string,code:string,message:string}[]}>}
 */
export async function probeKey(key, { candidates, base } = {}) {
  const ids = candidates?.length ? candidates : detectProvider(key).map((c) => c.id);
  const tried = [];
  for (const id of ids) {
    const p = PROVIDERS[id];
    const b = base || byok.baseOverride(id);
    try {
      const models = id === 'anthropic' ? await anthropicModels(key, b) : await listModels(p, key, { fetchFn: fetchFor(p), base: b || p.base });
      return { ok: true, id, models, ...pickModels(p, models) };
    } catch (e) {
      tried.push({ id, code: e.code || 'error', message: e.message });
    }
  }
  return { ok: false, tried };
}
