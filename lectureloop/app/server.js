// LectureLoop 后端：静态托管 public/ + 4 个固定的 JSON 接口。
// 无状态；密钥只在服务端环境变量里；默认只监听 127.0.0.1。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnv } from './server/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(here);

const { AiError, claudeEnabled, MODEL, FAST_MODEL } = await import('./server/claude.js');
const { generateNotes, generateLanguage } = await import('./server/ai.js');
const { translateBatch, availableProviders } = await import('./server/translate.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(here, 'public');
const MAX_BODY = 8 * 1024 * 1024;
const MAX_CUES = 6000;
const MAX_CHARS = 700_000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.docx': 'application/octet-stream',
};

// ---- 极简限流（按 IP，每分钟）----
const hits = new Map();
function limited(ip, bucket, max) {
  const k = `${ip}|${bucket}`;
  const now = Date.now();
  const e = hits.get(k);
  if (!e || now - e.t > 60_000) { hits.set(k, { t: now, n: 1 }); return false; }
  return ++e.n > max;
}

const send = (res, status, body, headers = {}) => {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
};

const sendError = (res, e) => {
  if (e instanceof AiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
  if (e?.code === 'bad_request') return send(res, 400, { error: { code: 'bad_request', message: e.message } });
  console.error('[error]', e?.stack || e);
  return send(res, 500, { error: { code: 'internal', message: '服务器内部错误' } });
};

const badRequest = (message) => Object.assign(new Error(message), { code: 'bad_request' });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw badRequest('请求体过大');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw badRequest('无效的 JSON');
  }
}

function checkCues(cues) {
  if (!Array.isArray(cues) || !cues.length) throw badRequest('cues 不能为空');
  if (cues.length > MAX_CUES) throw badRequest(`cues 过多（>${MAX_CUES}）`);
  let chars = 0;
  const out = cues.map((c, k) => {
    const t = String(c?.t ?? '');
    chars += t.length;
    return { i: Number.isInteger(c?.i) ? c.i : k, t };
  });
  if (chars > MAX_CHARS) throw badRequest('文本过长，请分段处理');
  return out;
}

const lang = (v, d) => (['en', 'fr', 'zh'].includes(v) ? v : d);

// ---- API 路由 ----
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const p = availableProviders();
    return send(res, 200, {
      version: '0.1.0',
      claude: claudeEnabled(),
      model: MODEL(),
      fastModel: FAST_MODEL(),
      translate: p,
      translateAny: p.google || p.claude,
    });
  }
  if (req.method !== 'POST') return send(res, 405, { error: { code: 'method', message: 'Method Not Allowed' } });

  if (url.pathname === '/api/translate') {
    if (limited(ip, 'tr', 600)) return send(res, 429, { error: { code: 'rate_limit', message: '请求过于频繁' } });
    const b = await readJson(req);
    const source = lang(b.source, 'en');
    const targets = (Array.isArray(b.targets) ? b.targets : []).map((t) => lang(t, null)).filter(Boolean);
    if (!targets.length) throw badRequest('targets 不能为空');
    const items = checkCues(b.items);
    const out = await translateBatch({
      source, targets, items,
      context: (Array.isArray(b.context) ? b.context : []).map(String).slice(-3),
      glossary: (Array.isArray(b.glossary) ? b.glossary : []).map(String).slice(0, 100),
    });
    return send(res, 200, out);
  }

  if (url.pathname === '/api/ai/notes') {
    if (limited(ip, 'ai', 30)) return send(res, 429, { error: { code: 'rate_limit', message: '请求过于频繁' } });
    const b = await readJson(req);
    const cues = checkCues(b.cues);
    const out = await generateNotes({ course: String(b.course || '').slice(0, 120), title: String(b.title || '').slice(0, 160), noteLang: lang(b.noteLang, 'zh'), cues });
    return send(res, 200, out);
  }

  if (url.pathname === '/api/ai/language') {
    if (limited(ip, 'ai', 30)) return send(res, 429, { error: { code: 'rate_limit', message: '请求过于频繁' } });
    const b = await readJson(req);
    const cues = checkCues(b.cues);
    const out = await generateLanguage({
      course: String(b.course || '').slice(0, 120), title: String(b.title || '').slice(0, 160),
      explainLang: lang(b.explainLang, 'zh'), cues,
      glossary: (Array.isArray(b.glossary) ? b.glossary : []).map(String).slice(0, 200),
    });
    return send(res, 200, out);
  }

  return send(res, 404, { error: { code: 'not_found', message: 'Not Found' } });
}

// ---- 静态文件 ----
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.anthropic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found', { 'content-type': 'text/plain' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'content-security-policy': CSP,
      'permissions-policy': 'microphone=(self), camera=()',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { 'content-type': 'text/plain' });
    return serveStatic(req, res, url);
  } catch (e) {
    return sendError(res, e);
  }
});

// ---- 启动：--open 自动打开浏览器；端口被占用时先判断是否已有 LectureLoop 在运行 ----
const OPEN = process.argv.includes('--open');
const explicitPort = !!process.env.PORT;
let port = PORT;

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`  请在浏览器中打开：${url}`)); // 找不到浏览器命令时不要让服务崩溃
    child.unref();
  } catch { console.log(`  请在浏览器中打开：${url}`); }
}
const urlOf = (p) => `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${p}`;

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { console.error('启动失败：', e.message); process.exit(1); }
  // 已经有 LectureLoop 在这个端口运行 → 直接打开它（浏览器数据按端口隔离，换端口会"看不到"原来的课程）
  try {
    const r = await fetch(`${urlOf(port)}/api/config`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j?.version) {
      console.log(`\n  LectureLoop 已经在运行：${urlOf(port)}\n`);
      if (OPEN) openBrowser(urlOf(port));
      process.exit(0);
    }
  } catch { /* 不是 LectureLoop */ }
  if (explicitPort || port >= PORT + 10) { console.error(`端口 ${port} 被其他程序占用。可设置环境变量 PORT 换一个端口。`); process.exit(1); }
  port += 1;
  console.warn(`  端口 ${port - 1} 被其他程序占用，改用 ${port}（注意：不同端口下浏览器里保存的课程数据是分开的）`);
  server.listen(port, HOST);
});

server.on('listening', () => {
  const p = availableProviders();
  console.log(`\n  LectureLoop  →  ${urlOf(port)}\n`);
  console.log(`  Claude        ${claudeEnabled() ? `✔ ${MODEL()}  (翻译: ${FAST_MODEL()})` : '✘ 未配置 ANTHROPIC_API_KEY（可在网页“设置”里填自己的密钥，或使用离线版）'}`);
  console.log(`  Google 翻译    ${p.google ? '✔' : '✘ 未配置 GOOGLE_TRANSLATE_API_KEY'}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('  ⚠ 服务监听在非本机地址，请确认网络环境可信（接口会使用你的密钥）。');
  console.log('\n  关闭这个窗口（或按 Ctrl+C）即可停止。\n');
  if (OPEN) openBrowser(urlOf(port));
});

server.listen(port, HOST);
