// 服务商注册表 + 密钥识别 + 默认模型挑选。纯函数，浏览器 / Node / Cloudflare Worker 共用。
//
// ⚠️ 除 Anthropic 外，其它服务商没有用真实密钥验证过（cors / 模型名 / 输出上限都是依据公开资料的预设）。
// 所以：模型名不写死，而是探测时读取 /models 列表再挑；预设只是后备；界面里这些服务商标“实验性”。

export const PROVIDERS = {
  anthropic: { name: 'Anthropic Claude', kind: 'anthropic', base: 'https://api.anthropic.com', cors: 'yes',
    pref: { main: [/^claude-opus-5-5$/, /^claude-opus-5/, /opus/], fast: [/^claude-haiku-5-5$/, /haiku/] }, defaults: { main: 'claude-opus-5-5', fast: 'claude-opus-5-5' } },
  openai: { name: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', cors: 'yes', json: 'schema', tokenParam: 'max_completion_tokens', maxOut: 32000,
    pref: { main: [/^gpt-5(\.\d+)?$/, /^gpt-4\.1$/, /^gpt-4o$/], fast: [/^gpt-5(\.\d+)?-mini$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/] } },
  gemini: { name: 'Google Gemini', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', cors: 'yes', json: 'schema', maxOut: 16000,
    pref: { main: [/^gemini-[\d.]+-pro$/], fast: [/^gemini-[\d.]+-flash$/] }, note: 'AIza… 格式同时也是 Google Translate 的密钥格式，这里按 Gemini 验证' },
  deepseek: { name: 'DeepSeek（深度求索）', kind: 'openai', base: 'https://api.deepseek.com', cors: 'unknown', json: 'object', maxOut: 8000, defaults: { main: 'deepseek-chat', fast: 'deepseek-chat' } },
  moonshot: { name: 'Moonshot Kimi（月之暗面）', kind: 'openai', base: 'https://api.moonshot.cn/v1', cors: 'unknown', json: 'object', maxOut: 8000,
    pref: { main: [/^kimi-k2-0905/, /^kimi-k2/], fast: [/^moonshot-v1-8k$/] }, defaults: { main: 'moonshot-v1-32k', fast: 'moonshot-v1-8k' } },
  zhipu: { name: '智谱 GLM', kind: 'openai', base: 'https://open.bigmodel.cn/api/paas/v4', cors: 'unknown', json: 'object', maxOut: 8000,
    pref: { main: [/^glm-4\.5$/, /^glm-4-plus$/], fast: [/^glm-4(\.5)?-flash$/, /^glm-4-flash$/] }, defaults: { main: 'glm-4-plus', fast: 'glm-4-flash' } },
  dashscope: { name: '阿里云百炼（通义千问）', kind: 'openai', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', cors: 'unknown', json: 'object', maxOut: 8000,
    pref: { main: [/^qwen-plus$/, /^qwen3-max$/], fast: [/^qwen-turbo$/, /^qwen-flash$/] }, defaults: { main: 'qwen-plus', fast: 'qwen-turbo' } },
  siliconflow: { name: '硅基流动 SiliconFlow', kind: 'openai', base: 'https://api.siliconflow.cn/v1', cors: 'unknown', json: 'object', maxOut: 8000,
    defaults: { main: 'Qwen/Qwen2.5-72B-Instruct', fast: 'Qwen/Qwen2.5-7B-Instruct' } },
  volcengine: { name: '火山方舟（豆包）', kind: 'openai', base: 'https://ark.cn-beijing.volces.com/api/v3', cors: 'unknown', json: 'object', maxOut: 8000, needsModel: true,
    note: '需要填写“接入点 ID”（ep- 开头）或模型名作为模型' },
  openrouter: { name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', cors: 'yes', json: 'object', maxOut: 16000, needsModel: true, note: '需要自己选择模型，例如 anthropic/claude-sonnet-4.5' },
  groq: { name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', cors: 'yes', json: 'object', maxOut: 8000, defaults: { main: 'llama-3.3-70b-versatile', fast: 'llama-3.1-8b-instant' } },
  xai: { name: 'xAI Grok', kind: 'openai', base: 'https://api.x.ai/v1', cors: 'unknown', json: 'object', maxOut: 16000, pref: { main: [/^grok-4$/, /^grok-3$/], fast: [/mini/] } },
  custom: { name: '自定义（OpenAI 兼容）', kind: 'openai', base: '', cors: 'direct', json: 'object', maxOut: 8000, needsModel: true, needsBase: true, note: '填写 Base URL（例如本地 Ollama：http://localhost:11434/v1）。只能从浏览器直连，不走中继' },
};

/** 允许走中继的主机名（custom 不在内：中继只代理白名单里的公开 API 主机，防止被当作开放代理） */
export const relayHosts = () => new Set(Object.entries(PROVIDERS).filter(([id, p]) => id !== 'custom' && p.base).map(([, p]) => new URL(p.base).hostname));
/** 浏览器直连需要在 CSP connect-src 里放行的来源 */
export const cspOrigins = () => [...new Set(Object.entries(PROVIDERS).filter(([id, p]) => id !== 'custom' && p.base).map(([, p]) => new URL(p.base).origin))];

/**
 * 根据密钥格式猜测服务商，返回按可能性排序的候选。
 * 有些格式无法区分（例如 sk- 加 32 位十六进制：DeepSeek 与 百炼），所以只是"候选"，要靠探测确认。
 * @returns {{id:string, confidence:'high'|'medium'|'low'}[]}
 */
export function detectProvider(key) {
  const k = String(key || '').trim();
  const one = (id, confidence = 'high') => [{ id, confidence }];
  if (!k) return [];
  if (/^sk-ant-/.test(k)) return one('anthropic');
  if (/^sk-or-/.test(k)) return one('openrouter');
  if (/^xai-/.test(k)) return one('xai');
  if (/^gsk_/.test(k)) return one('groq');
  if (/^AIza[\w-]{35}$/.test(k)) return one('gemini');
  if (/^sk-(proj|svcacct|admin)-/.test(k) || k.includes('T3BlbkFJ')) return one('openai');
  if (/^[0-9a-f]{32}\.[A-Za-z0-9]{8,32}$/.test(k)) return one('zhipu');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return one('volcengine', 'medium');
  if (/^sk-[0-9a-f]{32}$/.test(k)) return [{ id: 'deepseek', confidence: 'medium' }, { id: 'dashscope', confidence: 'medium' }];
  if (/^sk-[a-z]{48}$/.test(k)) return [{ id: 'siliconflow', confidence: 'medium' }, { id: 'moonshot', confidence: 'low' }, { id: 'openai', confidence: 'low' }];
  if (/^sk-[A-Za-z0-9]{40,64}$/.test(k)) return [{ id: 'moonshot', confidence: 'medium' }, { id: 'openai', confidence: 'low' }, { id: 'siliconflow', confidence: 'low' }];
  if (/^sk-/.test(k)) return ['openai', 'deepseek', 'moonshot', 'dashscope', 'siliconflow'].map((id) => ({ id, confidence: 'low' }));
  return [];
}

const NOT_CHAT = /embed|whisper|tts|dall|moderation|image|audio|realtime|transcribe|rerank|guard|speech/i;

/** 从 /models 返回的 id 里挑主模型与快速模型；列表为空或没有匹配时用预设后备 */
export function pickModels(p, ids = []) {
  const list = [...new Set(ids.map((x) => String(x).replace(/^models\//, '')).filter((x) => !NOT_CHAT.test(x)))];
  const find = (res) => { for (const re of res || []) { const hit = list.filter((m) => re.test(m)).sort().reverse()[0]; if (hit) return hit; } return null; };
  const main = find(p.pref?.main) || p.defaults?.main || null;
  const fast = find(p.pref?.fast) || p.defaults?.fast || main;
  return { main, fast, list };
}

export const maskKey = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');
