// 同源 CORS 中继：只给"浏览器直连会被跨域拦截"的服务商用。
// 只用 Web 标准 API（Request / Response / fetch），所以 Cloudflare Worker 与本地 Node 服务共用同一份代码。
//
// 安全边界：
//  - 只转发到白名单主机（providers.js 里的公开 API 主机），且只能是 https（测试主机除外）→ 不是开放代理
//  - 要求 Origin 与本站一致（别的网站不能借用你的中继）
//  - 只转发必要的请求头；不记录、不保存密钥与内容；不跟随重定向
import { relayHosts } from '../public/js/lib/providers.js';

const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'x-api-key', 'x-goog-api-key', 'anthropic-version']);
const MAX_BODY = 8 * 1024 * 1024;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** @param {Request} request  @param {{extraHosts?: string}} opts extraHosts：逗号分隔，仅用于本地测试（允许 http） */
export async function handleRelay(request, { extraHosts = '' } = {}) {
  if (request.method === 'GET') return json({ relay: true }); // 供前端探测中继是否可用
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'forbidden origin' }, 403);

  let env;
  try { env = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  let target;
  try { target = new URL(env.url); } catch { return json({ error: 'invalid url' }, 400); }
  const extra = new Set(String(extraHosts).split(',').map((s) => s.trim()).filter(Boolean));
  const allowed = relayHosts();
  if (!allowed.has(target.hostname) && !extra.has(target.hostname)) return json({ error: `host not allowed: ${target.hostname}` }, 403);
  if (target.protocol !== 'https:' && !extra.has(target.hostname)) return json({ error: 'https only' }, 403);

  const method = String(env.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (typeof env.body === 'string' && env.body.length > MAX_BODY) return json({ error: 'body too large' }, 413);
  const headers = {};
  for (const [k, v] of Object.entries(env.headers || {})) if (ALLOWED_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = String(v);

  let r;
  try {
    r = await fetch(target, { method, headers, body: method === 'POST' ? env.body ?? undefined : undefined, redirect: 'manual' });
  } catch {
    return json({ error: 'upstream unreachable' }, 502);
  }
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
}
