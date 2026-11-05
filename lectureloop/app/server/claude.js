// Claude 调用封装：结构化 JSON 输出 + 流式 + 拒答/截断处理 + 服务端回退。
// 使用官方 SDK（@anthropic-ai/sdk）。密钥来自环境变量 ANTHROPIC_API_KEY，绝不下发到浏览器。
import Anthropic from '@anthropic-ai/sdk';

export class AiError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const claudeEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// 默认主模型：Claude Opus 5.5。可用环境变量覆盖；CLAUDE_MODEL_FAST 用于低延迟的批量翻译（建议 claude-haiku-5-5）。
export const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';
export const FAST_MODEL = () => process.env.CLAUDE_MODEL_FAST || MODEL();

let client;
const getClient = () => (client ??= new Anthropic()); // 读取 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL

// 服务端 fallbacks:"default"（beta server-side-fallback-2026-07-01）：安全分类器误拒时由 API 自动换模型重试。
// Haiku 不支持该参数，故只对 Fable / Opus 5.x / Sonnet 5.5 开启。可设 CLAUDE_SERVER_FALLBACK=off 关闭。
const supportsFallback = (model) => /^claude-(fable|opus-5|sonnet-5-5)/.test(model);

async function runStream(c, params, beta) {
  const stream = beta ? c.beta.messages.stream(params) : c.messages.stream(params);
  return stream.finalMessage(); // 长输出走流式，避免请求超时
}

/**
 * 让 Claude 按 JSON Schema 返回结构化结果。
 * @returns {Promise<{data:any, model:string, usage:object}>}
 */
export async function askJson({ model = MODEL(), system, user, schema, effort = 'medium', maxTokens = 32000 }) {
  if (!claudeEnabled()) throw new AiError('no_key', '未配置 ANTHROPIC_API_KEY', 503);
  const c = getClient();
  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    // effort 控制思考深度（Opus 5.5 的思考不可关闭，只能调 effort）；format 要求严格 JSON
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  const useFallback = process.env.CLAUDE_SERVER_FALLBACK !== 'off' && supportsFallback(model);

  let msg;
  try {
    msg = useFallback
      ? await runStream(c, { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, true)
      : await runStream(c, base, false);
  } catch (e) {
    // 若账号/网关不接受 fallback beta，退回普通请求重试一次
    if (useFallback && e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(e.message || '')) {
      try {
        msg = await runStream(c, base, false);
      } catch (e2) {
        throw wrap(e2);
      }
    } else {
      throw wrap(e);
    }
  }

  // 先检查 stop_reason，再读 content
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new AiError('refusal', `模型拒绝了该请求（${d.category || 'unknown'}）${d.explanation ? '：' + d.explanation : ''}`, 422);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new AiError('max_tokens', '输出被截断（超过 max_tokens），请缩短输入或分段处理', 422);
  }
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('bad_json', '模型返回的内容不是有效 JSON', 502);
  }
  return { data, model: msg.model || model, usage: msg.usage };
}

function wrap(e) {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('auth', 'Claude 密钥无效或无权限', 401);
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limit', 'Claude 请求过于频繁，请稍后重试', 429);
  if (e instanceof Anthropic.BadRequestError) return new AiError('bad_request', `Claude 拒绝了请求参数：${e.message}`, 400);
  if (e instanceof Anthropic.APIConnectionError) return new AiError('upstream', '无法连接 Claude API（网络问题）', 502);
  if (e instanceof Anthropic.APIError) return new AiError('upstream', `Claude API 错误 ${e.status}：${e.message}`, 502);
  return new AiError('upstream', String(e?.message || e), 502);
}
