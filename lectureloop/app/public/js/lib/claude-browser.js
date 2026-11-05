// 浏览器直连 Claude（在线静态版 / 本地未配置服务端密钥时）。使用官方 SDK 的浏览器打包（vendor/anthropic-sdk.mjs，按需加载）。
// 提示词、Schema、结果校验与服务端共用 ai-tasks.js，行为一致。
import { ApiError } from './errors.js';
import { byok } from './byok.js';
import { notesTask, sanitizeNotes, languageTask, sanitizeLanguage, translateTask, alignTranslation, supportsServerFallback, FALLBACK_BETA } from './ai-tasks.js';

let Anthropic = null;
let client = null;
let sig = '';

async function getClient() {
  const key = byok.key;
  if (!key) throw new ApiError('no_key', '未设置 Claude 密钥');
  Anthropic ||= (await import('../../vendor/anthropic-sdk.mjs')).default;
  const s = `${key}|${byok.baseURL}`;
  if (!client || s !== sig) {
    // dangerouslyAllowBrowser：密钥属于用户本人、只在本人浏览器里使用（见设置页说明）
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, ...(byok.baseURL ? { baseURL: byok.baseURL } : {}) });
    sig = s;
  }
  return client;
}

function wrap(e) {
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

async function askJson({ model, system, user, schema, effort, maxTokens }) {
  const c = await getClient();
  const base = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { effort, format: { type: 'json_schema', schema } } };
  const fb = supportsServerFallback(model);
  let msg;
  try {
    msg = fb
      ? await c.beta.messages.stream({ ...base, betas: [FALLBACK_BETA], fallbacks: 'default' }).finalMessage()
      : await c.messages.stream(base).finalMessage(); // 长输出走流式，避免超时
  } catch (e) {
    if (fb && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message || '')) {
      try { msg = await c.messages.stream(base).finalMessage(); } catch (e2) { throw wrap(e2); }
    } else throw wrap(e);
  }
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new ApiError('refusal', `模型拒绝了该请求（${d.category || 'unknown'}）${d.explanation ? '：' + d.explanation : ''}`, 422);
  }
  if (msg.stop_reason === 'max_tokens') throw new ApiError('max_tokens', '输出被截断（超过 max_tokens），请缩短输入', 422);
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { data: JSON.parse(text), model: msg.model || model };
  } catch {
    throw new ApiError('bad_json', '模型返回的内容不是有效 JSON');
  }
}

export async function notesInBrowser(p) {
  const { data, model } = await askJson({ model: byok.model, ...notesTask(p) });
  return { model, notes: sanitizeNotes(data, p.cues.length) };
}

export async function languageInBrowser(p) {
  const { data, model } = await askJson({ model: byok.model, ...languageTask(p) });
  return { model, language: sanitizeLanguage(data, p.cues) };
}

export async function translateInBrowser({ source, targets, items, context = [], glossary = [] }) {
  const results = {};
  await Promise.all(targets.filter((t) => t !== source).map(async (target) => {
    const { data } = await askJson({ model: byok.fastModel, ...translateTask({ items, source, target, context, glossary }) });
    const out = alignTranslation(items, data);
    if (!out) throw new ApiError('bad_json', '翻译结果为空');
    results[target] = out;
  }));
  return { provider: 'claude-browser', results };
}

/** 设置页"测试密钥"：翻译一句话（成本极低） */
export async function testKey() {
  const r = await translateInBrowser({ source: 'en', targets: ['zh'], items: [{ i: 0, t: 'Okay, so today we talk about decision trees.' }] });
  return r.results.zh?.[0]?.t || '';
}
