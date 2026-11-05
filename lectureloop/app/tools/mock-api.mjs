// 本地模拟 Claude (/v1/messages，SSE 流式) 与 Google Translate v2，用于没有密钥时开发/联调/测试。
// 用法：npm run dev:mock（同时启动模拟服务与应用）；或单独 npm run mock。
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8788);
export const last = { claude: null, google: null };

const WRONG_RIGHT = [
  ['dog product', 'dot product', '近音 /t/→/g/'],
  ['decision treats', 'decision trees', '近音'],
  ['super vector', 'support vector', '弱读'],
  ["ginny's score", 'Gini score', '外来词读音'],
  ['linear reversion', 'linear regression', '近音'],
];

function parseLines(text, marker) {
  const body = text.split(marker).pop() || '';
  return body.split('\n').map((l) => l.match(/^(\d+)\|(.*)$/)).filter(Boolean).map((m) => ({ i: +m[1], t: m[2] }));
}

function answer(body) {
  const sys = String(body.system || '');
  const user = String(body.messages?.at(-1)?.content || '');
  if (user.includes('TRIGGER_REFUSAL')) return { refusal: true };

  if (sys.includes('study notes')) {
    const cues = parseLines(user, 'Transcript:\n');
    const n = cues.length;
    const step = Math.max(1, Math.floor(n / 6));
    const pick = (k) => cues[Math.min(n - 1, k)];
    const parts = [];
    for (let k = 0; k < n; k += Math.max(20, Math.floor(n / 5))) parts.push({ start_cue: cues[k].i, title: `第 ${parts.length + 1} 部分（模拟）`, summary: `模拟摘要：${pick(k).t.slice(0, 60)}…` });
    return {
      overview: '【模拟数据】本节课介绍了若干核心概念，并通过例子说明其用法。',
      parts,
      key_points: Array.from({ length: 6 }, (_, k) => ({ text: `【模拟】要点 ${k + 1}：${pick(k * step).t.slice(0, 80)}`, cue: pick(k * step).i })),
      concepts: [{ term: 'decision tree', definition: '【模拟】决策树：用一系列条件判断做分类的模型', cue: pick(1).i }],
      formulas: [{ expression: 'y(wᵀx + b) ≥ 1', spoken: 'y times w dot x plus b is greater than or equal to one', explanation: '【模拟】点被正确分类且位于间隔之外', cue: pick(2 * step).i }],
      emphasized: cues.filter((c) => /keep in mind|remember|important/i.test(c.t)).slice(0, 3).map((c) => ({ text: c.t.slice(0, 120), cue: c.i })),
      questions: [{ text: '【模拟】这一步为什么需要归一化？', cue: pick(3 * step).i }],
    };
  }

  if (sys.includes('language-learning')) {
    const cues = parseLines(user, 'Transcript:\n');
    const all = cues.map((c) => c.t.toLowerCase()).join('\n');
    const corrections = WRONG_RIGHT.filter(([w]) => all.includes(w)).map(([wrong, right, reason]) => ({ wrong, right, reason }));
    const c0 = cues[0]?.i ?? 0;
    return {
      corrections,
      vocab: [
        { term: 'decision tree', pos: 'n.', kind: 'term', cue: c0, def: { zh: '决策树', en: 'A model that classifies data with a series of yes/no questions.', fr: 'arbre de décision' }, heard_as: ['decision treats'] },
        { term: 'keep in mind', pos: 'phrase', kind: 'phrase', cue: c0, def: { zh: '记住', en: 'to remember something important', fr: 'garder à l’esprit' }, heard_as: [] },
      ],
      patterns: [{ fn: 'emphasize', template: 'Keep in mind that …', explain: '【模拟】用于强调需要记住的点', cue: c0, extensions: [{ en: 'Keep in mind that the margin depends only on the support vectors.', zh: '记住：间隔只取决于支持向量。' }] }],
    };
  }

  if (sys.includes('translate live lecture subtitles')) {
    const tag = /to Simplified Chinese/.test(sys) ? 'zh' : /to French/.test(sys) ? 'fr' : 'en';
    const cues = parseLines(user, 'Translate these lines:\n');
    return { items: cues.map((c) => ({ i: c.i, t: `【${tag}】${c.t}` })) };
  }
  return { error: 'unknown task' };
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function claudeResponse(res, body) {
  const out = answer(body);
  const base = { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } };
  if (out.refusal) {
    return sse(res, [
      ['message_start', { type: 'message_start', message: base }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'bio', explanation: 'mock refusal' } }, usage: { output_tokens: 0 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  }
  const json = JSON.stringify(out);
  const mid = Math.floor(json.length / 2);
  sse(res, [
    ['message_start', { type: 'message_start', message: base }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(0, mid) } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(mid) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

export function startMock(port = PORT) {
  const srv = http.createServer(async (req, res) => {
    // CORS：允许浏览器直连（测试在线版"自带密钥"路径）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__last') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(last)); }
    if (url.pathname.startsWith('/v1/messages')) {
      last.claude = { path: req.url, beta: req.headers['anthropic-beta'] || null, model: body.model, fallbacks: body.fallbacks ?? null, output_config: body.output_config, stream: body.stream, temperature: body.temperature ?? null };
      return claudeResponse(res, body);
    }
    if (url.pathname.endsWith('/language/translate/v2')) {
      last.google = { target: body.target, n: body.q?.length };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: { translations: body.q.map((q) => ({ translatedText: `[g:${body.target}] ${q}` })) } }));
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startMock();
  console.log(`mock Claude/Google API on http://127.0.0.1:${PORT}`);
}
