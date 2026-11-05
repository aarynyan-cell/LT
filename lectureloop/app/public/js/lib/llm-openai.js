// OpenAI 兼容的 chat/completions 调用（OpenAI、Gemini、DeepSeek、Kimi、智谱、百炼、Groq、OpenRouter、自定义…）。
// 只依赖 fetch，浏览器与 Node 通用；fetchFn 可注入（用于中继或测试）。
import { ApiError } from './errors.js';
import { parseLooseJson } from './ai-tasks.js';

const NET = '无法连接服务商（网络问题、浏览器跨域限制，或需要使用中继）';

async function statusError(r) {
  let msg = '';
  try { msg = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  if (r.status === 401 || r.status === 403) return new ApiError('auth', '密钥无效或没有权限', r.status);
  if (r.status === 429) return new ApiError('rate_limit', '请求过于频繁或额度不足', 429);
  if (r.status >= 500) return new ApiError('upstream', `服务商错误 ${r.status}`, r.status);
  return new ApiError('bad_request', `服务商拒绝了请求（${r.status}）${msg ? '：' + msg : ''}`, r.status);
}

/** GET {base}/models → 模型 id 列表；用于验证密钥与挑选默认模型 */
export async function listModels(p, key, { fetchFn = fetch, base } = {}) {
  let r;
  try {
    r = await fetchFn(`${base || p.base}/models`, { headers: { authorization: `Bearer ${key}` } });
  } catch (e) {
    if (e instanceof TypeError) throw new ApiError('network', NET);
    throw e;
  }
  if (!r.ok) throw await statusError(r);
  let j;
  try { j = await r.json(); } catch { throw new ApiError('bad_json', '服务商返回了无法解析的模型列表'); }
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
}

/**
 * 让模型按 JSON Schema 返回结果。
 *  - json:'schema'（OpenAI / Gemini）：response_format=json_schema（strict）
 *  - 其它：response_format=json_object，并把 Schema 写进提示词；解析时容忍 ```json 围栏
 *  - 服务商拒绝 response_format 时，自动降级到 json_object 重试一次
 */
export async function askJsonOpenAI({ p, key, model, system, user, schema, maxTokens = 8000, fetchFn = fetch, base, signal }) {
  const build = (mode) => {
    const sys = mode === 'schema' ? system : `${system}\n\nReturn ONLY one JSON object (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    const body = {
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      [p.tokenParam || 'max_tokens']: Math.min(maxTokens, p.maxOut || maxTokens),
      response_format: mode === 'schema' ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } : { type: 'json_object' },
    };
    return body;
  };
  const send = async (mode) => {
    let r;
    try {
      r = await fetchFn(`${base || p.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(build(mode)), signal });
    } catch (e) {
      if (e instanceof TypeError) throw new ApiError('network', NET);
      throw e;
    }
    return r;
  };

  let mode = p.json === 'schema' ? 'schema' : 'object';
  let r = await send(mode);
  if (!r.ok && mode === 'schema' && r.status === 400) {
    const txt = await r.clone().text().catch(() => '');
    if (/response_format|json_schema|schema|unsupported/i.test(txt)) { mode = 'object'; r = await send(mode); }
  }
  if (!r.ok) throw await statusError(r);

  const j = await r.json().catch(() => null);
  const choice = j?.choices?.[0];
  if (!choice) throw new ApiError('bad_json', '服务商没有返回内容');
  if (choice.message?.refusal || choice.finish_reason === 'content_filter') throw new ApiError('refusal', `模型拒绝了该请求${choice.message?.refusal ? '：' + choice.message.refusal : '（内容过滤）'}`, 422);
  if (choice.finish_reason === 'length') throw new ApiError('max_tokens', '输出被截断（超过该模型的输出上限），请换一个输出更长的模型或缩短输入', 422);
  try {
    return { data: parseLooseJson(choice.message?.content ?? ''), model: j.model || model };
  } catch {
    throw new ApiError('bad_json', '模型返回的内容不是有效 JSON');
  }
}
