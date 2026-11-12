// 用户自己的 AI 密钥翻译字幕（在 background 里调用；扩展的 host_permissions 让这些请求不受网页 CORS 限制）。
//   Anthropic → 原生 fetch 调 /v1/messages（字幕输出很短，不需要流式；SDK 太大，不打进插件）
//   其它     → 共享的 OpenAI 兼容客户端（askJsonOpenAI）
// 提示词与结果校验来自网页版共享的 ai-tasks.js。
import { ApiError } from '../../../app/public/js/lib/errors.js';
import { PROVIDERS, detectProvider, pickModels } from '../../../app/public/js/lib/providers.js';
import { askJsonOpenAI, listModels } from '../../../app/public/js/lib/llm-openai.js';
import { subtitleTask, alignTranslation, parseLooseJson } from '../../../app/public/js/lib/ai-tasks.js';

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT = 20_000;

const anthropicHeaders = (key) => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' });

async function withTimeout(fetchFn, url, init, ms = TIMEOUT) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetchFn(url, { ...init, signal: ctl.signal }); }
  catch (e) { throw new ApiError(e.name === 'AbortError' ? 'timeout' : 'network', e.name === 'AbortError' ? '翻译请求超时' : '无法连接翻译服务（网络问题）'); }
  finally { clearTimeout(timer); }
}

async function anthropicError(r) {
  const j = await r.json().catch(() => ({}));
  const msg = j?.error?.message || `HTTP ${r.status}`;
  if (r.status === 401 || r.status === 403) return new ApiError('auth', 'Claude 密钥无效或没有权限', r.status);
  if (r.status === 429) return new ApiError('rate_limit', 'Claude 请求过于频繁或额度不足', 429);
  if (r.status >= 500) return new ApiError('upstream', `Claude 服务错误 ${r.status}`, r.status);
  return new ApiError('bad_request', msg, r.status);
}

/**
 * Anthropic 非流式调用。模型或接口版本对 effort / 结构化输出的支持不一致时逐级降级：
 * 完整（effort + json_schema）→ 去掉 effort → 去掉结构化输出（把 Schema 写进提示词）。只在 400 且报错提到这些参数时才降级。
 */
export async function askAnthropicRaw({ key, model, base = PROVIDERS.anthropic.base, fetchFn = fetch }, { system, user, schema, effort, maxTokens }) {
  const build = (level) => {
    const sys = level < 2 ? system : `${system}\n\nReturn ONLY one JSON object (no markdown) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    const body = { model, max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] };
    if (level < 2) body.output_config = { ...(level === 0 && effort ? { effort } : {}), format: { type: 'json_schema', schema } };
    return body;
  };
  let level = 0, r;
  for (;;) {
    r = await withTimeout(fetchFn, `${base}/v1/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(build(level)) });
    if (r.ok) break;
    if (r.status === 400 && level < 2) {
      const msg = await r.clone().json().then((j) => j?.error?.message || '').catch(() => '');
      if (/effort|output_config|format|schema/i.test(msg)) { level = /effort/i.test(msg) && level === 0 ? 1 : 2; continue; }
    }
    throw await anthropicError(r);
  }
  const j = await r.json().catch(() => null);
  if (j?.stop_reason === 'refusal') throw new ApiError('refusal', '模型拒绝了这段字幕', 422);
  const text = (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { data: parseLooseJson(text), model: j.model || model }; } catch { throw new ApiError('bad_json', '模型返回的内容不是有效 JSON'); }
}

/** sel = { id, provider, key, model, base }；items = [{i,t}]。各目标语言并行请求。 */
export async function translateLLM({ sel, source, targets, items, context = [], glossary = [], fetchFn = fetch }) {
  if (!sel) throw new ApiError('no_key', '未设置 AI 密钥');
  if (!sel.model) throw new ApiError('no_model', `请先为 ${sel.provider.name} 选择模型`);
  const results = {};
  await Promise.all(targets.filter((t) => t !== source).map(async (target) => {
    const task = subtitleTask({ items, source, target, context, glossary });
    const { data } = sel.provider.kind === 'anthropic'
      ? await askAnthropicRaw({ key: sel.key, model: sel.model, base: sel.base, fetchFn }, task)
      : await askJsonOpenAI({ p: sel.provider, key: sel.key, model: sel.model, base: sel.base, fetchFn: (u, i) => withTimeout(fetchFn, u, i), ...task });
    const out = alignTranslation(items, data);
    if (!out) throw new ApiError('bad_json', '翻译结果为空');
    results[target] = out;
  }));
  return { provider: `ai:${sel.id}`, results };
}

async function anthropicModels(key, base, fetchFn) {
  const r = await withTimeout(fetchFn, `${base || PROVIDERS.anthropic.base}/v1/models?limit=100`, { headers: anthropicHeaders(key) });
  if (r.status === 401 || r.status === 403) throw new ApiError('auth', '密钥无效或没有权限', r.status);
  if (!r.ok) throw new ApiError('upstream', `HTTP ${r.status}`, r.status);
  return ((await r.json()).data || []).map((m) => m.id);
}

/**
 * 识别并验证密钥：按格式得到候选服务商，逐个读取 /models，第一个成功的就是它。
 * @returns {Promise<{ok:true,id,models,main,fast,base}|{ok:false,tried:{id,code,message}[]}>}
 */
export async function probeKey(key, { candidates, base, fetchFn = fetch } = {}) {
  const ids = candidates?.length ? candidates : detectProvider(key).map((c) => c.id);
  const tried = [];
  for (const id of ids) {
    const p = PROVIDERS[id];
    const b = base || p.base;
    try {
      const models = id === 'anthropic' ? await anthropicModels(key, b, fetchFn) : await listModels(p, key, { fetchFn: (u, i) => withTimeout(fetchFn, u, i), base: b });
      return { ok: true, id, models, base: b, ...pickModels(p, models) };
    } catch (e) { tried.push({ id, code: e.code || 'error', message: e.message }); }
  }
  return { ok: false, tried };
}
