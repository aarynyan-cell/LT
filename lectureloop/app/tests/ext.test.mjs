// Chrome 插件（字幕翻译）的纯逻辑测试：语言判断、字幕稳定器、翻译队列、翻译引擎与降级、设置/密钥存取、构建产物是否最新。
// 页面行为（悬浮层、字幕读取、选取器、全屏）在 tests/e2e/extension.cjs 里用真实 Chromium 加载插件来测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectLang, targetsFor } from '../../extension/src/core/langs.js';
import { Stabilizer } from '../../extension/src/core/stabilizer.js';
import { TranslateQueue } from '../../extension/src/core/translator.js';
import { translateGtx, translateBatch } from '../../extension/src/core/engines.js';
import { askAnthropicRaw, translateLLM, probeKey } from '../../extension/src/core/llm.js';
import { normalize, DEFAULTS, siteOf } from '../../extension/src/core/settings.js';
import { loadKeys, saveKey, removeKey, selection } from '../../extension/src/core/keys.js';
import { Controller } from '../../extension/src/core/controller.js';
import { findMatch, mergeLines, norm } from '../../extension/src/core/transcript.js';
import { Recorder } from '../../extension/src/core/recorder.js';
import { videoKeyOf } from '../../extension/src/core/videokey.js';
import { tokenize, wordKey, wordStats, isStop } from '../../extension/src/core/words.js';
import { translateWithTM, tmKey } from '../../extension/src/core/tm.js';
import { parseJson3, parseXml, cuesFromPanel, parseTimestamp, extractCaptionTracksFromHtml, pickTrack, withFormat, isYouTubeUrl, decodeEntities } from '../../extension/src/core/captions.js';
import { cuesToWords, segmentSentences, cuesToSentences } from '../../extension/src/core/segment.js';
import { Resampler, Chunker, encodeWav, toBase64, fromBase64, rms } from '../../extension/src/core/pcm.js';
import { asrSelection, cleanSegments, transcribe } from '../../extension/src/core/asr-api.js';
import { subtitleTask } from '../public/js/lib/ai-tasks.js';
import { bundle, manifest, packageFiles, zipFiles } from '../tools/build-ext.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');

// ---------- 语言判断 ----------
test('detectLang：法语 / 英语 / 中文 / 无法判断', () => {
  assert.equal(detectLang("Je ne sais pas ce que vous voulez, mais c'est trop tard."), 'fr');
  assert.equal(detectLang("Qu'est-ce que tu fais là ? Ça va ?"), 'fr');
  assert.equal(detectLang('Merci.'), 'fr');
  assert.equal(detectLang("I don't know what you want, but it's too late."), 'en');
  assert.equal(detectLang('Yeah, okay.'), 'en');
  assert.equal(detectLang('你到底想要什么？已经太晚了。'), 'zh');
  assert.equal(detectLang('Hello 你好吗，我很好'), 'zh');
  assert.equal(detectLang('♪'), null);
  assert.equal(detectLang('Xyzzy Plugh'), null);
  assert.equal(detectLang(''), null);
});

test('targetsFor：已经是目标语言的句子不再翻译成它', () => {
  assert.deepEqual(targetsFor('你好吗', 'auto', ['zh']), []);
  assert.deepEqual(targetsFor('你好吗', 'auto', ['zh', 'en']), ['en']);
  assert.deepEqual(targetsFor("How are you today, my friend?", 'auto', ['zh', 'en']), ['zh']);
  assert.deepEqual(targetsFor('Qu’est-ce que vous faites ?', 'fr', ['zh', 'fr']), ['zh']); // 明确指定了源语言
  assert.deepEqual(targetsFor('♪', 'auto', ['zh']), ['zh']); // 判断不了就交给翻译引擎
});

// ---------- 稳定器 ----------
function fakeTimers() {
  let now = 0, id = 0; const q = new Map();
  return {
    set: (fn, ms) => { q.set(++id, { at: now + ms, fn }); return id; },
    clear: (i) => q.delete(i),
    advance(ms) { now += ms; for (const [k, t] of [...q]) if (t.at <= now) { q.delete(k); t.fn(); } },
  };
}
test('Stabilizer：整句出现很快稳定；滚动增长要等停下来；空文本不触发', () => {
  const tm = fakeTimers(); const settled = [];
  const s = new Stabilizer({ onSettle: (t) => settled.push(t), timers: tm });
  s.push('Where are you going?'); tm.advance(100);
  assert.deepEqual(settled, ['Where are you going?']);
  s.push('Where are you going? I'); tm.advance(100);        // 在原文后面增长
  s.push('Where are you going? I need to'); tm.advance(100);
  s.push('Where are you going? I need to leave.'); tm.advance(300);
  assert.equal(settled.length, 1, '增长期间不应翻译');
  tm.advance(400);
  assert.equal(settled.at(-1), 'Where are you going? I need to leave.');
  assert.equal(settled.length, 2);
  s.push(''); tm.advance(1000);
  assert.equal(settled.length, 2);
  s.push('Totally different line.'); tm.advance(100);
  assert.equal(settled.at(-1), 'Totally different line.');
  s.push('Totally different line.'); tm.advance(1000); // 相同文本不重复触发
  assert.equal(settled.length, 3);
});

// ---------- 翻译队列 ----------
const echoSend = (log) => async ({ source, targets, items, context }) => {
  log.push({ source, targets, items: items.map((x) => x.t), context });
  return { results: Object.fromEntries(targets.map((t) => [t, items.map((x) => ({ i: x.i, t: `[${t}]${x.t}` }))])) };
};
test('TranslateQueue：缓存 + 去重 + 在途期间合并成下一批', async () => {
  const log = []; let release;
  const gate = new Promise((r) => { release = r; });
  const send = async (req) => { if (!log.length) await gate; return echoSend(log)(req); };
  const q = new TranslateQueue({ send });
  const a = q.translate('one', { targets: ['zh'] });
  const b = q.translate('two', { targets: ['zh'] }); // 第一个在途：它排队
  const c = q.translate('three', { targets: ['zh'] });
  const dup = q.translate('two', { targets: ['zh'] });  // 同一句：复用同一个 promise
  release();
  assert.deepEqual(await a, { zh: '[zh]one' });
  assert.deepEqual(await b, { zh: '[zh]two' });
  assert.deepEqual(await c, { zh: '[zh]three' });
  assert.deepEqual(await dup, { zh: '[zh]two' });
  assert.equal(log.length, 2, '后两句合并成一批');
  assert.deepEqual(log[1].items, ['two', 'three']);
  assert.deepEqual(await q.translate('one', { targets: ['zh'] }), { zh: '[zh]one' });
  assert.equal(log.length, 2, '命中缓存不再请求');
  assert.deepEqual(q.peek('one', 'auto', ['zh']), { zh: '[zh]one' });
});

test('TranslateQueue：目标语言不同的句子不混在一个批次；两个目标语言都返回', async () => {
  const log = [];
  const q = new TranslateQueue({ send: echoSend(log) });
  const [x, y] = await Promise.all([q.translate('hello', { targets: ['zh', 'fr'] }), q.translate('bonjour', { targets: ['en'] })]);
  assert.deepEqual(x, { zh: '[zh]hello', fr: '[fr]hello' });
  assert.deepEqual(y, { en: '[en]bonjour' });
  assert.equal(log.length, 2);
});

test('TranslateQueue：失败不缓存，会重试；预翻译失败只暂停预翻译，不拖累当前这句', async () => {
  let fail = true, t = 0; const errs = [];
  const send = async (req) => { if (fail) throw new Error('boom'); return echoSend([])(req); };
  const q = new TranslateQueue({ send, onError: (e) => errs.push(e.message), now: () => t });
  assert.deepEqual(await q.translate('a', { targets: ['zh'] }), {});
  assert.deepEqual(errs, ['boom']);
  fail = false;
  assert.deepEqual(await q.translate('a', { targets: ['zh'] }), { zh: '[zh]a' }, '失败没有被缓存');
  fail = true;
  assert.deepEqual(await q.translate('p1', { targets: ['zh'], prio: 'bg' }), {});
  fail = false;
  q.translate('p2', { targets: ['zh'], prio: 'bg' }); // 暂停期内：留在队列里
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.peek('p2', 'auto', ['zh']), undefined);
  assert.deepEqual(await q.translate('live', { targets: ['zh'] }), { zh: '[zh]live' }, '当前这句不受影响');
  t = 11_000;
  q._pump();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(q.peek('p2', 'auto', ['zh']), { zh: '[zh]p2' }, '暂停结束后继续预翻译');
});

test('TranslateQueue：预翻译排队中的句子被当前播放用到时，提升为当前优先级', async () => {
  const log = []; let release;
  const gate = new Promise((r) => { release = r; });
  const send = async (req) => { if (req.items.some((i) => i.t === 'first')) await gate; return echoSend(log)(req); };
  const q = new TranslateQueue({ send });
  q.translate('first', { targets: ['zh'], prio: 'bg' });   // bg 在途（被 gate 挡住）
  q.translate('later', { targets: ['zh'], prio: 'bg' });   // bg 排队
  const p = q.translate('later', { targets: ['zh'], prio: 'live' }); // 现在就要用它
  assert.deepEqual(await p, { zh: '[zh]later' }, '不需要等 bg 在途请求结束');
  release();
});

// ---------- 翻译引擎 ----------
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, clone() { return this; }, text: async () => JSON.stringify(o) });
const gtxFetch = (calls) => async (url) => {
  calls.push(url);
  const u = new URL(url);
  return json([[[`译:${u.searchParams.get('q')}`, u.searchParams.get('q'), null, null, 10]], null, 'en']);
};
test('translateGtx：每句一个请求，语言代码正确，结果按 i 对齐', async () => {
  const calls = [];
  const r = await translateGtx({ source: 'en', targets: ['zh', 'fr'], items: [{ i: 0, t: 'Hi there' }, { i: 1, t: 'Bye' }], fetchFn: gtxFetch(calls) });
  assert.equal(calls.length, 4);
  assert.ok(calls.some((u) => /sl=en&tl=zh-CN/.test(u)) && calls.some((u) => /tl=fr/.test(u)));
  assert.deepEqual(r.results.zh, [{ i: 0, t: '译:Hi there' }, { i: 1, t: '译:Bye' }]);
  const auto = await translateGtx({ source: 'auto', targets: ['zh'], items: [{ i: 0, t: 'x' }], fetchFn: gtxFetch([]) });
  assert.equal(auto.provider, 'gtx');
});
test('translateGtx：限流与网络错误给出明确的错误码', async () => {
  await assert.rejects(translateGtx({ source: 'en', targets: ['zh'], items: [{ i: 0, t: 'a' }], fetchFn: async () => json({}, 429) }), { code: 'rate_limit' });
  await assert.rejects(translateGtx({ source: 'en', targets: ['zh'], items: [{ i: 0, t: 'a' }], fetchFn: async () => { throw new TypeError('x'); } }), { code: 'network' });
  await assert.rejects(translateGtx({ source: 'en', targets: ['zh'], items: [{ i: 0, t: 'a' }], fetchFn: async () => json({ no: 1 }) }), { code: 'bad_json' });
});

const anthropicOk = (items, tag = 'ai') => ({ id: 'm', type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: items.map((x) => ({ i: x.i, t: `${tag}:${x.t}` })) }) }] });
test('Anthropic 非流式调用：带 effort + 结构化输出；报错提到 effort 时降级重试', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    assert.equal(init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    if (b.output_config?.effort) return json({ type: 'error', error: { message: 'output_config.effort is not supported for this model' } }, 400);
    return json(anthropicOk([{ i: 0, t: 'x' }]));
  };
  const task = subtitleTask({ items: [{ i: 0, t: 'x' }], source: 'en', target: 'zh' });
  const r = await askAnthropicRaw({ key: 'sk-ant-test', model: 'claude-haiku-5-5', fetchFn }, task);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].output_config.effort, 'low');
  assert.equal(bodies[1].output_config.effort, undefined);
  assert.equal(bodies[1].output_config.format.type, 'json_schema');
  assert.deepEqual(r.data.items, [{ i: 0, t: 'ai:x' }]);
});
test('Anthropic：不支持结构化输出时，把 Schema 写进提示词；与 effort/format 无关的 400 不重试', async () => {
  const seen = [];
  const f = async (url, init) => {
    const b = JSON.parse(init.body); seen.push(b);
    if (b.output_config) return json({ error: { message: 'output_config.format is not supported' } }, 400);
    return json(anthropicOk([{ i: 0, t: 'x' }]));
  };
  await askAnthropicRaw({ key: 'k', model: 'm', fetchFn: f }, subtitleTask({ items: [{ i: 0, t: 'x' }], source: 'en', target: 'zh' }));
  assert.equal(seen.length, 2);
  assert.match(seen[1].system, /JSON Schema/);
  const n = [];
  await assert.rejects(askAnthropicRaw({ key: 'k', model: 'm', fetchFn: async (u, i) => { n.push(1); return json({ error: { message: 'max_tokens too large' } }, 400); } }, subtitleTask({ items: [{ i: 0, t: 'x' }], source: 'en', target: 'zh' })), { code: 'bad_request' });
  assert.equal(n.length, 1);
  await assert.rejects(askAnthropicRaw({ key: 'k', model: 'm', fetchFn: async () => json({}, 401) }, subtitleTask({ items: [], source: 'en', target: 'zh' })), { code: 'auth' });
  await assert.rejects(askAnthropicRaw({ key: 'k', model: 'm', fetchFn: async () => json({}, 429) }, subtitleTask({ items: [], source: 'en', target: 'zh' })), { code: 'rate_limit' });
});

test('translateLLM：Anthropic 与 OpenAI 兼容两条路径；多个目标语言并行', async () => {
  const sel = (id) => selection({ keys: { [id]: { key: 'k', models: ['claude-haiku-5-5', 'gpt-5-mini', 'mock-large'], ...(id === 'custom' ? { base: 'http://127.0.0.1:1/v1', fastModel: 'mock-large' } : {}) } }, use: id });
  const a = await translateLLM({ sel: sel('anthropic'), source: 'fr', targets: ['zh', 'en'], items: [{ i: 0, t: 'Salut' }], fetchFn: async (u, init) => json(anthropicOk([{ i: 0, t: 'Salut' }], /Chinese/.test(JSON.parse(init.body).system) ? 'zh' : 'en')) });
  assert.deepEqual(a.results.zh, [{ i: 0, t: 'zh:Salut' }]);
  assert.deepEqual(a.results.en, [{ i: 0, t: 'en:Salut' }]);
  assert.equal(a.provider, 'ai:anthropic');
  const o = await translateLLM({ sel: sel('custom'), source: 'en', targets: ['zh'], items: [{ i: 3, t: 'Hi' }], fetchFn: async (u, init) => { assert.match(u, /\/chat\/completions$/); return json({ model: 'm', choices: [{ message: { content: JSON.stringify({ items: [{ i: 3, t: '你好' }] }) }, finish_reason: 'stop' }] }); } });
  assert.deepEqual(o.results.zh, [{ i: 3, t: '你好' }]);
  await assert.rejects(translateLLM({ sel: selection({ keys: { custom: { key: 'k', models: ['a', 'b'], base: 'http://x/v1' } }, use: 'custom' }), source: 'en', targets: ['zh'], items: [] }), { code: 'no_model' }, '自定义服务商没有选模型时给出明确提示');
  await assert.rejects(translateLLM({ sel: null, source: 'en', targets: ['zh'], items: [] }), { code: 'no_key' });
});

test('translateBatch：auto = AI → Google 免费；AI 失败时降级并带说明；只用 AI 时失败就报错', async () => {
  const keys = { keys: { anthropic: { key: 'k', models: ['claude-haiku-5-5'] } }, use: 'anthropic' };
  const calls = [];
  const fetchFn = async (url, init) => {
    if (String(url).includes('/v1/messages')) { calls.push('ai'); return json({}, 429); }
    calls.push('gtx'); return gtxFetch([])(url);
  };
  const req = { source: 'en', targets: ['zh'], items: [{ i: 0, t: 'hey' }], engine: 'auto' };
  const r = await translateBatch(req, { keys, fetchFn });
  assert.deepEqual(calls, ['ai', 'gtx']);
  assert.equal(r.provider, 'gtx');
  assert.match(r.note, /AI 翻译失败.*Google 免费/);
  await assert.rejects(translateBatch({ ...req, engine: 'llm' }, { keys, fetchFn }), { code: 'rate_limit' });
  const none = await translateBatch(req, { keys: { keys: {}, use: '' }, fetchFn: gtxFetch([]) });
  assert.equal(none.provider, 'gtx'); assert.equal(none.note, '', '没有密钥不是"失败"，不用提示');
  await assert.rejects(translateBatch({ ...req, engine: 'llm' }, { keys: { keys: {}, use: '' }, fetchFn }), { code: 'no_key' });
  await assert.rejects(translateBatch({ ...req, engine: 'chrome' }, { keys, fetchFn }), { code: 'no_provider' });
});

test('probeKey：按格式识别服务商并读取模型列表；失败时列出每个候选的原因', async () => {
  const f = async (url, init) => {
    if (String(url).includes('api.anthropic.com/v1/models')) return json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] });
    return json({ error: 'no' }, 401);
  };
  const ok = await probeKey('sk-ant-abc', { fetchFn: f });
  assert.equal(ok.ok, true); assert.equal(ok.id, 'anthropic'); assert.equal(ok.fast, 'claude-haiku-5-5');
  const bad = await probeKey('sk-' + 'a'.repeat(32), { fetchFn: f });
  assert.equal(bad.ok, false); assert.ok(bad.tried.length >= 2 && bad.tried.every((t) => t.code === 'auth'));
  const cust = await probeKey('x', { candidates: ['custom'], base: 'http://localhost:11434/v1', fetchFn: async (u) => { assert.equal(u, 'http://localhost:11434/v1/models'); return json({ data: [{ id: 'llama3' }] }); } });
  assert.equal(cust.ok, true); assert.equal(cust.fast, null);
});

test('subtitleTask：影视字幕提示词（语气/俚语、已经是目标语言原样返回、auto 来源）', () => {
  const t = subtitleTask({ items: [{ i: 0, t: 'Salut,  ça va ?' }], source: 'auto', target: 'zh', context: ['a', 'b', 'c', 'd'] });
  assert.match(t.system, /TV shows, films/); assert.match(t.system, /Simplified Chinese/); assert.match(t.system, /detect it per line/);
  assert.match(t.system, /already in the target language/);
  assert.match(t.user, /0\|Salut, ça va \?/); assert.ok(!t.user.includes('\na\n'), '只带最近 3 句上下文');
  assert.equal(subtitleTask({ items: [], source: 'fr', target: 'en' }).system.includes('from French to English'), true);
});

// ---------- 设置 / 密钥 ----------
test('normalize：补全默认值，纠正非法值', () => {
  assert.deepEqual(normalize({}), DEFAULTS);
  const s = normalize({ source: 'jp', targets: ['en', 'en', 'xx', 'fr', 'zh'], engine: 'x', fontScale: 99, bg: -3, pos: { cx: 2, by: 0 }, sites: 5 });
  assert.equal(s.source, 'auto'); assert.deepEqual(s.targets, ['en', 'fr']); assert.equal(s.engine, 'auto');
  assert.equal(s.fontScale, 2.5); assert.equal(s.bg, 0); assert.deepEqual(s.pos, { cx: 1, by: 0.05 }); assert.deepEqual(s.sites, {});
  assert.deepEqual(normalize({ targets: [] }).targets, ['zh']);
  assert.equal(normalize({ pos: { cx: 'a' } }).pos, null);
});
test('siteOf：iframe 里取最顶层页面的主机名', () => {
  assert.equal(siteOf({ href: 'https://www.netflix.com/watch/1', ancestorOrigins: [] }), 'www.netflix.com');
  assert.equal(siteOf({ href: 'https://player.example.net/x', ancestorOrigins: ['https://parent.example.com', 'https://top.example.org'] }), 'top.example.org');
  assert.equal(siteOf({ href: 'https://player.example.net/x', ancestorOrigins: ['null'] }), 'player.example.net');
});
test('keys：保存 / 选用 / 删除；选用快速模型', async () => {
  const mem = {};
  const c = { storage: { local: { get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])])), set: async (o) => Object.assign(mem, structuredClone(o)) } } };
  assert.deepEqual(await loadKeys(c), { keys: {}, use: '' });
  await saveKey('anthropic', { key: 'sk-ant-1', models: ['claude-opus-5-5', 'claude-haiku-5-5'], model: 'claude-opus-5-5', fastModel: 'claude-haiku-5-5' }, c);
  await saveKey('deepseek', { key: 'sk-x', models: ['deepseek-chat'] }, c);
  let k = await loadKeys(c);
  assert.equal(k.use, 'anthropic');
  assert.equal(selection(k).model, 'claude-haiku-5-5');
  await removeKey('anthropic', c);
  k = await loadKeys(c);
  assert.equal(k.use, 'deepseek');
  assert.equal(selection(k).model, 'deepseek-chat');
  assert.equal(selection({ keys: {}, use: '' }), null);
});

// ---------- 控制器：逐句翻译参数 ----------
test('Controller._lineInfo：显式语言 / 轨道语言提示 / 逐句判断 / 已是目标语言', () => {
  const mk = (settings, lang) => { const c = new Controller({ site: 'x', settings: { ...DEFAULTS, ...settings }, send: async () => ({}), saveSettings() {} }); c.src = lang ? { lang } : null; return c; };
  // 自动模式 + 法语字幕轨道：法语句子 → 译成中文；其中混着的中文句子不再译成中文
  const a = mk({ targets: ['zh'] }, 'fr');
  assert.deepEqual(a._lineInfo("Je ne sais pas ce que vous voulez."), { source: 'fr', targets: ['zh'] });
  assert.deepEqual(a._lineInfo('你到底想要什么？'), { source: 'zh', targets: [] });
  // 英语句子出现在法语轨道里：仍按轨道语言翻译（引擎自己会处理），但目标里有英语时不再译成英语
  assert.deepEqual(a._lineInfo("I don't know what you want, my friend."), { source: 'fr', targets: ['zh'] });
  assert.deepEqual(mk({ targets: ['en', 'zh'] }, 'fr')._lineInfo("I don't know what you want, my friend."), { source: 'fr', targets: ['zh'] });
  // 没有来源提示（网站 DOM 字幕）：靠逐句判断
  const b = mk({ targets: ['zh', 'fr'] }, null);
  assert.deepEqual(b._lineInfo("I don't know what you want, my friend."), { source: 'en', targets: ['zh', 'fr'] });
  assert.deepEqual(b._lineInfo("Qu'est-ce que vous faites ici ?"), { source: 'fr', targets: ['zh'] });
  assert.deepEqual(b._lineInfo('♪'), { source: 'auto', targets: ['zh', 'fr'] });
  // 用户明确指定了字幕语言：以它为准，不做逐句排除
  const c = mk({ source: 'fr', targets: ['zh', 'fr'] }, 'en');
  assert.deepEqual(c._lineInfo("I don't know what you want."), { source: 'fr', targets: ['zh'] });
});

// ---------- 转录记录 / 侧边栏数据 ----------
const L = (id, start, end, text, tr) => ({ id, start, end, text, ...(tr ? { tr } : {}) });

test('norm / findMatch：忽略大小写和标点，时间相近才算同一句', () => {
  assert.equal(norm("  Je ne SAIS pas,  vraiment ! "), 'je ne sais pas vraiment');
  const lines = [L('a', 10, 12, 'Merci.'), L('b', 50, 52, 'Merci !'), L('c', 20, 22, 'Autre chose')];
  assert.equal(findMatch(lines, 'merci', 11), 0);
  assert.equal(findMatch(lines, 'merci', 51), 1, '同样的词在别处出现是另一句');
  assert.equal(findMatch(lines, 'Merci', 30), -1, '相差太远不算同一句');
  assert.equal(findMatch(lines, '', 0), -1);
});

test('mergeLines：同 id / 同文同时间合并（译文、结束时间），不同文字另起一行，按时间排序', () => {
  const a = mergeLines([], [L('t2000', 2, 4, 'Deux'), L('t0', 0, 2, 'Un')]);
  assert.deepEqual(a.map((l) => l.id), ['t0', 't2000']);
  const b = mergeLines(a, [L('t0', 0, 2.5, 'Un', { zh: '一' }), L('d9', 2.2, 4.4, 'deux!', { zh: '二' })]); // 同一句（标点/大小写不同，时间相近）
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].tr, { zh: '一' }); assert.equal(b[0].end, 2.5);
  assert.deepEqual(b[1].tr, { zh: '二' }); assert.equal(b[1].end, 4.4);
  const c = mergeLines(b, [L('t0', 0, 2, 'Complètement différent')]); // 同 id 不同内容：新的一行（id 不冲突）
  assert.equal(c.length, 3); assert.equal(new Set(c.map((l) => l.id)).size, 3);
  assert.ok(!('tr' in mergeLines([], [L('a', 0, 1, 'x')])[0]) || mergeLines([], [L('a', 0, 1, 'x')])[0].tr === undefined);
});

test('mergeLines：上千句的轨道载入足够快', () => {
  const big = Array.from({ length: 2000 }, (_, i) => L(`t${i * 3000}`, i * 3, i * 3 + 2, `Phrase numéro ${i} avec quelques mots`));
  const t0 = Date.now();
  const m = mergeLines(mergeLines([], big), big);
  assert.equal(m.length, 2000);
  assert.ok(Date.now() - t0 < 1500, `合并 2000 句耗时 ${Date.now() - t0}ms`);
});

test('Recorder：轨道整条载入；DOM 字幕边播边记；循环播放认出已有的句子；译文补给同文句子', () => {
  const r = new Recorder();
  r.reset({ key: 'k' });
  r.loadAll([{ start: 0, end: 2, text: 'Salut' }, { start: 2.5, end: 4, text: 'Ça va ?' }, { start: 5, end: 6, text: 'Salut' }], 'fr');
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.take().map((l) => l.id), ['t0', 't2500', 't5000']);
  assert.equal(r.hasDirty, false);
  r.loadAll([{ start: 0, end: 2, text: 'Salut' }, { start: 2.5, end: 4, text: 'Ça va ?' }, { start: 5, end: 6, text: 'Salut' }], 'fr'); // 同一条轨道再载入：没有变化
  assert.equal(r.hasDirty, false);
  r.attach('salut', { zh: '你好' });
  assert.deepEqual(r.lines.filter((l) => l.tr).map((l) => l.id), ['t0', 't5000'], '同文的两句都补上译文');
  assert.equal(r.idAt(3), 't2500');
  assert.deepEqual(r.missing(['zh']).map((l) => l.id), ['t2500']);

  const d = new Recorder();
  d.reset({ key: 'dom' });
  const id1 = d.observe('Where are you going?', 10, 'en');
  d.touch(id1, 12);
  const id2 = d.observe('I need to leave.', 13, 'en');
  assert.notEqual(id1, id2);
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines[0].end, 12);
  // 循环：视频回到开头再播一遍 → 同一句、相近时间，复用已有 id，不新增
  assert.equal(d.observe('Where are you going?', 10.4, 'en'), id1);
  assert.equal(d.lines.length, 2);
  // 重新打开页面：从保存的转录载入
  const e = new Recorder();
  e.reset({ key: 'dom' }); e.load(JSON.parse(JSON.stringify(d.take())));
  assert.equal(e.hasDirty, false);
  assert.equal(e.observe('where are you going', 9.8, 'en'), id1);
  assert.equal(e.lines.length, 2);
});

test('Recorder：滚动字幕（新句子以上一句开头）延长上一句而不是另记一行', () => {
  const r = new Recorder();
  r.reset({ key: 'roll' });
  const a = r.observe('Where are you', 5, 'en');
  const b = r.observe('Where are you going tonight', 5.8, 'en');
  assert.equal(a, b); assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, 'Where are you going tonight');
  const c = r.observe('Something else entirely', 9, 'en');
  assert.notEqual(c, a);
});

test('videoKeyOf：同一个视频同一个 key（忽略时间/列表参数），不同视频不同', () => {
  const k = (href) => videoKeyOf({ href, hostname: new URL(href).hostname, pathname: new URL(href).pathname, search: '' });
  assert.equal(k('https://www.youtube.com/watch?v=abc12345678&t=30s&list=PL1').key, 'yt:abc12345678');
  assert.equal(k('https://www.youtube.com/watch?v=abc12345678').key, 'yt:abc12345678');
  assert.equal(k('https://www.youtube.com/embed/abc12345678').key, 'yt:abc12345678');
  assert.equal(k('https://www.youtube.com/shorts/abc12345678').key, 'yt:abc12345678');
  assert.equal(k('https://www.netflix.com/watch/81234567?trackId=1').key, 'nf:81234567');
  assert.equal(k('https://example.com/video/12/?utm_source=x&start=30').key, 'u:example.com/video/12');
  assert.notEqual(k('https://example.com/video/12').key, k('https://example.com/video/13').key);
  assert.equal(k('https://example.com/p?b=2&a=1').key, k('https://example.com/p?a=1&b=2').key);
  assert.equal(k('https://www.youtube.com/watch?v=abc12345678').url, 'https://www.youtube.com/watch?v=abc12345678');
});

test('words：法语省音词不拆开，中文用分词，停用词与统计', () => {
  const t = tokenize("L'immeuble n'est pas là, c'est vrai.", 'fr').filter((x) => x.word).map((x) => x.t);
  assert.deepEqual(t, ["L'immeuble", "n'est", 'pas', 'là', "c'est", 'vrai']);
  const zh = tokenize('我不知道你想要什么', 'zh').filter((x) => x.word).map((x) => x.t);
  assert.ok(zh.length >= 3 && zh.join('') === '我不知道你想要什么', '中文被分成多个词：' + zh);
  assert.equal(wordKey("  L'Immeuble "), "l'immeuble");
  assert.equal(isStop('le', 'fr'), true); assert.equal(isStop('menace', 'fr'), false); assert.equal(isStop('1', 'fr'), true);
  const st = wordStats([L('a', 0, 1, 'Le pompier saute. Le pompier regarde.'), L('b', 1, 2, 'Il saute encore')], 'fr');
  assert.deepEqual(st.slice(0, 2).map((x) => [x.word, x.count]), [['pompier', 2], ['saute', 2]]);
  assert.ok(!st.some((x) => x.word === 'le'), '停用词被隐藏');
  assert.ok(wordStats([L('a', 0, 1, 'Le pompier')], 'fr', { hideStop: false }).some((x) => x.word === 'le'));
});

test('translateWithTM：命中记忆的句子不请求翻译；未命中的才翻译并写回；免费翻译质量的条目在用 AI 时重翻', async () => {
  const mem = new Map();
  const calls = [];
  const deps = (wantAI, provider = 'gtx') => ({
    getMany: async (keys) => new Map(keys.filter((k) => mem.has(k)).map((k) => [k, mem.get(k)])),
    putMany: async (es) => es.forEach((e) => mem.set(e.k, e)),
    run: async (r) => { calls.push(r.items.map((i) => i.t)); return { provider, results: Object.fromEntries(r.targets.map((t) => [t, r.items.map((i) => ({ i: i.i, t: `${t}:${i.t}` }))])) }; },
    wantAI,
  });
  const req = (texts) => ({ source: 'fr', targets: ['zh'], items: texts.map((t, i) => ({ i, t })), engine: 'auto' });
  const r1 = await translateWithTM(req(['Salut', 'Merci']), deps(false));
  assert.equal(r1.provider, 'gtx'); assert.deepEqual(calls, [['Salut', 'Merci']]);
  assert.ok(mem.has(tmKey('fr', 'zh', 'Salut')));
  const r2 = await translateWithTM(req(['Merci', 'Nouveau', 'Salut']), deps(false));
  assert.deepEqual(calls.at(-1), ['Nouveau'], '只翻译没见过的');
  assert.deepEqual(r2.results.zh, [{ i: 0, t: 'zh:Merci' }, { i: 1, t: 'zh:Nouveau' }, { i: 2, t: 'zh:Salut' }], '结果按原顺序对齐');
  assert.equal(r2.cached, 2);
  const n = calls.length;
  const r3 = await translateWithTM(req(['Merci', 'Salut']), deps(false));
  assert.equal(calls.length, n, '全部命中：没有请求');
  assert.equal(r3.provider, 'cache');
  const r4 = await translateWithTM(req(['Merci']), deps(true, 'ai:anthropic'));
  assert.deepEqual(calls.at(-1), ['Merci'], '用 AI 时不接受免费翻译质量的记忆');
  assert.equal(mem.get(tmKey('fr', 'zh', 'Merci')).p, 'ai');
  const m2 = calls.length;
  await translateWithTM(req(['Merci']), deps(true, 'ai:anthropic'));
  assert.equal(calls.length, m2, 'AI 质量的记忆可以复用');
  // 记忆写失败不影响结果
  const bad = { ...deps(false), putMany: async () => { throw new Error('quota'); } };
  const r5 = await translateWithTM(req(['Zzz']), bad);
  assert.deepEqual(r5.results.zh, [{ i: 0, t: 'zh:Zzz' }]);
});

// ---------- YouTube 转写：解析与断句 ----------
test('parseJson3：自动字幕带逐词时间；人工字幕整句；跳过只有换行的事件', () => {
  const asr = parseJson3({ events: [
    { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'je' }, { utf8: ' ne', tOffsetMs: 300 }, { utf8: ' sais', tOffsetMs: 600 }, { utf8: ' pas', tOffsetMs: 1000 }] },
    { tStartMs: 4000, dDurationMs: 100, segs: [{ utf8: '\n' }] },
    { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: "c'est trop tard" }] },
  ] });
  assert.equal(asr.length, 2);
  assert.deepEqual(asr[0].words.map((w) => [w.w, w.t]), [['je', 1], ['ne', 1.3], ['sais', 1.6], ['pas', 2]]);
  assert.equal(asr[1].words, undefined); assert.equal(asr[1].text, "c'est trop tard"); assert.equal(asr[1].start, 5);
});
test('parseXml：srv1（text start/dur，实体二次编码）与 srv3（p t/d，s 逐词）', () => {
  const v1 = parseXml('<?xml version="1.0"?><transcript><text start="1.5" dur="2.25">Qu&amp;#39;est-ce que tu fais ?</text><text start="4" dur="1">&lt;i&gt;Non&lt;/i&gt;</text></transcript>');
  assert.deepEqual(v1.map((c) => [c.start, c.end, c.text]), [[1.5, 3.75, "Qu'est-ce que tu fais ?"], [4, 5, 'Non']]);
  const v3 = parseXml('<timedtext><body><p t="1000" d="2000"><s>Hello</s><s t="500"> world</s></p><p t="4000" d="1000">Plain &amp;amp; simple</p></body></timedtext>');
  assert.equal(v3.length, 2);
  assert.deepEqual(v3[0].words.map((w) => [w.w, w.t]), [['Hello', 1], ['world', 1.5]]);
  assert.equal(v3[1].text, 'Plain & simple');
  assert.equal(decodeEntities('&#233;t&#xE9;&amp;'), 'été&');
});
test('面板与页面数据：转写面板行、时间戳、HTML 里的 captionTracks、选轨道、URL 校验', () => {
  assert.equal(parseTimestamp('1:02:03'), 3723); assert.equal(parseTimestamp('0:09'), 9); assert.ok(Number.isNaN(parseTimestamp('abc')));
  const cues = cuesFromPanel([{ t: 5, text: 'deux' }, { t: 0, text: ' un  ' }, { t: 9, text: '' }, { t: 7, text: 'trois' }]);
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[0, 5, 'un'], [5, 7, 'deux'], [7, 12, 'trois']]);
  const html = 'x={"a":1,"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=1&lang=fr","name":{"simpleText":"French [auto]"},"languageCode":"fr","kind":"asr"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=1&lang=en","languageCode":"en","name":{"simpleText":"a]b"}}],"audioTracks":[]}';
  const tracks = extractCaptionTracksFromHtml(html);
  assert.equal(tracks.length, 2); assert.equal(tracks[1].name.simpleText, 'a]b');
  assert.deepEqual(extractCaptionTracksFromHtml('no tracks here'), []);
  const t = [{ baseUrl: 'https://www.youtube.com/a', languageCode: 'en', name: 'English' }, { baseUrl: 'https://www.youtube.com/b', languageCode: 'fr', kind: 'asr', name: 'French (auto)' }, { baseUrl: 'https://www.youtube.com/c', languageCode: 'fr', name: 'Français' }];
  assert.equal(pickTrack(t).kind, 'manual'); assert.equal(pickTrack(t).lang, 'fr', '同语言的人工字幕优先于自动生成');
  assert.equal(pickTrack(t.slice(0, 2)).kind, 'asr', '没有同语言人工字幕就用自动生成（它的语言就是视频里说的语言）');
  assert.equal(pickTrack(t, { source: 'en' }).lang, 'en');
  assert.equal(pickTrack(t, { source: 'zh' }), null);
  assert.equal(pickTrack([]), null);
  assert.equal(withFormat('https://www.youtube.com/api/timedtext?v=1&fmt=srv3', 'json3'), 'https://www.youtube.com/api/timedtext?v=1&fmt=json3');
  assert.ok(!withFormat('https://www.youtube.com/api/timedtext?v=1&fmt=srv3', null).includes('fmt'));
  assert.equal(isYouTubeUrl('https://www.youtube.com/api/timedtext?v=1'), true);
  assert.equal(isYouTubeUrl('https://evil.example.com/?u=youtube.com'), false);
  assert.equal(isYouTubeUrl('javascript:alert(1)'), false);
});

// 造一段"自动字幕"：句子之间停顿 1 秒，词与词之间约 0.3 秒，没有任何标点
function asrCues(sentences, { wordGap = 0.32, sentGap = 1.0, perCue = 6 } = {}) {
  const words = []; let t = 2;
  for (const s of sentences) { for (const w of s.split(' ')) { words.push({ w, t: +t.toFixed(3) }); t += wordGap; } t += sentGap; }
  const cues = [];
  for (let i = 0; i < words.length; i += perCue) { const ws = words.slice(i, i + perCue); cues.push({ start: ws[0].t, end: ws.at(-1).t + 0.4, text: ws.map((x) => x.w).join(' '), words: ws }); }
  return cues;
}
test('segmentSentences：无标点的自动字幕按停顿还原句子，时间与说话时间吻合', () => {
  const truth = ["en ville un homme menace toujours de se jeter du haut d'un immeuble", 'les pompiers sont sur place', 'il va sauter', 'je te parie un euro qui saute', 'et moi je te parie deux euros qui saute pas'];
  const sents = cuesToSentences(asrCues(truth), 'fr');
  assert.equal(sents.length, truth.length, JSON.stringify(sents.map((s) => s.text)));
  sents.forEach((s, i) => assert.equal(s.text.toLowerCase().replace(/[.,?!]/g, ''), truth[i]));
  assert.match(sents[0].text, /^En ville/); assert.match(sents[0].text, /\.$/, '补上句末标点');
  // 每一句的开始时间 = 这句第一个词被说出来的时间
  let t = 2; truth.forEach((s, i) => { assert.ok(Math.abs(sents[i].start - t) < 0.01, `第 ${i} 句开始 ${sents[i].start} 应为 ${t}`); t += s.split(' ').length * 0.32 + 1.0; });
  for (let i = 1; i < sents.length; i++) assert.ok(sents[i].start >= sents[i - 1].end - 1e-6, '句子时间不重叠');
  assert.ok(sents.every((s) => s.end > s.start + 0.5));
});
test('segmentSentences：人工字幕——跨 cue 的句子合并、按标点断开、缩写不断句、小数不断句', () => {
  const cues = [
    { start: 0, end: 2, text: "I think that" }, { start: 2, end: 4, text: 'we should go home. Really?' },
    { start: 4.2, end: 6, text: 'Mr. Smith paid 3.5 euros' }, { start: 6, end: 8, text: 'for it, and that is fine.' },
  ];
  const s = cuesToSentences(cues, 'en');
  assert.deepEqual(s.map((x) => x.text), ['I think that we should go home.', 'Really? Mr. Smith paid 3.5 euros for it, and that is fine.']);
  assert.ok(s[0].start === 0 && s[0].end <= s[1].start);
});
test('segmentSentences：过长的句子在逗号/连接词/停顿处再切；碎片并入邻句；[Music] 与 ♪ 被忽略', () => {
  const long = Array.from({ length: 60 }, (_, i) => (i === 29 ? 'but' : `mot${i}`)).join(' ');
  const s = cuesToSentences([{ start: 0, end: 30, text: long }], 'en');
  assert.ok(s.length >= 3 && s.every((x) => x.text.split(' ').length <= 27), s.map((x) => x.text.split(' ').length).join(','));
  assert.equal(s.map((x) => x.text).join(' ').replace(/[.]/g, '').split(' ').length, 60, '没有丢词');
  const frag = cuesToSentences([{ start: 0, end: 1, text: 'Okay.' }, { start: 1.2, end: 4, text: 'So now we look at the margin.' }], 'en');
  assert.equal(frag.length, 1, '一个词的碎片并入下一句');
  const noise = cuesToSentences([{ start: 0, end: 2, text: '[Music]' }, { start: 2, end: 4, text: '♪ hello there my friend ♪' }], 'en');
  assert.deepEqual(noise.map((x) => x.text), ['Hello there my friend.']);
});
test('cuesToWords：滚动字幕（下一个 cue 重复上一个的结尾）只保留一份', () => {
  const w = cuesToWords([{ start: 0, end: 2, text: 'where are you' }, { start: 1, end: 3, text: 'where are you going tonight' }], 'en');
  assert.deepEqual(w.map((x) => x.w), ['where', 'are', 'you', 'going', 'tonight']);
  assert.equal(segmentSentences([]).length, 0);
});
test('segmentSentences：中文按字数与标点', () => {
  const s = cuesToSentences([{ start: 0, end: 4, text: '我不知道你想要什么。已经太晚了' }, { start: 4, end: 6, text: '我们走吧' }], 'zh');
  assert.ok(s.length >= 2); assert.ok(s[0].text.startsWith('我不知道')); assert.ok(s.every((x) => /[。！？]$/.test(x.text)));
});

// ---------- 语音识别：音频切块 / 编码 / 接口 ----------
const tone = (sec, sr, amp = 0.3, hz = 300) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr) * (1 + 0.3 * Math.sin(i / 900)));
const silence = (sec, sr) => new Float32Array(Math.round(sec * sr));
const cat = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

test('Resampler：48k → 16k 长度正确，分多次喂结果与一次喂一致，正弦波能量保留', () => {
  const x = tone(1, 48000);
  const a = new Resampler(48000, 16000).process(x);
  assert.ok(Math.abs(a.length - 16000) <= 2, '长度 ' + a.length);
  const r = new Resampler(48000, 16000); const parts = [];
  for (let i = 0; i < x.length; i += 4096) parts.push(r.process(x.subarray(i, i + 4096)));
  const b = cat(...parts);
  assert.ok(Math.abs(b.length - a.length) <= 2);
  for (let i = 100; i < 500; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, '分块与整块一致');
  assert.ok(Math.abs(rms(a) - rms(x)) / rms(x) < 0.15, '能量基本保留');
  const c = new Resampler(44100, 16000).process(tone(1, 44100));
  assert.ok(Math.abs(c.length - 16000) <= 2, '44.1k 也行：' + c.length);
});

test('Chunker：在停顿处切块，开始/结束时间与说话时间吻合；纯静音不产生块；过短的杂音丢弃', () => {
  const sr = 16000, chunks = [];
  const ch = new Chunker({ onChunk: (c) => chunks.push(c) });
  // 0–1s 静音 | 1–3.4s 说话 | 3.4–6s 静音 | 6–9s 说话 | 9–10s 静音 | 0.1s 点击声 | 11–12s 静音
  const sig = cat(silence(1, sr), tone(2.4, sr), silence(2.6, sr), tone(3, sr), silence(1, sr), tone(0.1, sr), silence(1.5, sr));
  for (let i = 0; i < sig.length; i += 4096) ch.push(sig.subarray(i, i + 4096), i / sr, 1);
  ch.flush();
  assert.equal(chunks.length, 2, '两句话两块：' + chunks.map((c) => [c.start.toFixed(2), c.end.toFixed(2)]));
  assert.ok(Math.abs(chunks[0].start - 0.75) < 0.1 && Math.abs(chunks[0].end - 3.6) < 0.25, `第一块 ${chunks[0].start}-${chunks[0].end}`);
  assert.ok(Math.abs(chunks[1].start - 5.75) < 0.1 && Math.abs(chunks[1].end - 9.2) < 0.25, `第二块 ${chunks[1].start}-${chunks[1].end}`);
  assert.ok(chunks[0].speechSec > 2 && chunks[0].pcm.length / sr > 2.4);
  const none = []; const c2 = new Chunker({ onChunk: (c) => none.push(c) });
  c2.push(silence(5, sr), 0); c2.flush();
  assert.equal(none.length, 0);
});
test('Chunker：连续说话超过上限时强制切开；倍速播放时时间按视频时间算；拖动进度条（flush）丢弃前一块的尾巴', () => {
  const sr = 16000, chunks = [];
  const ch = new Chunker({ onChunk: (c) => chunks.push(c) });
  const sig = tone(30, sr);
  for (let i = 0; i < sig.length; i += 4096) ch.push(sig.subarray(i, i + 4096), i / sr, 1);
  ch.flush();
  assert.ok(chunks.length >= 3 && chunks.every((c) => c.pcm.length / sr <= 12.05), chunks.map((c) => c.pcm.length / sr).join(','));
  assert.ok(chunks.slice(1).every((c, i) => Math.abs(c.start - chunks[i].end) < 0.1), '块首尾相接');
  const fast = []; const c2 = new Chunker({ onChunk: (c) => fast.push(c) });
  const s2 = cat(silence(0.5, sr), tone(3, sr), silence(1, sr));
  for (let i = 0; i < s2.length; i += 4096) c2.push(s2.subarray(i, i + 4096), 10 + (i / sr) * 2, 2); // 2 倍速：1 秒音频 = 2 秒视频
  c2.flush();
  assert.equal(fast.length, 1);
  assert.ok(Math.abs(fast[0].start - (10 + 2 * 0.25)) < 0.3 && Math.abs((fast[0].end - fast[0].start) - 2 * (fast[0].pcm.length / sr)) < 0.01, `倍速：${fast[0].start} ${fast[0].end}`);
});
test('encodeWav / base64：WAV 头正确，往返一致', () => {
  const w = encodeWav(tone(0.5, 16000), 16000), dv = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF'); assert.equal(String.fromCharCode(...w.slice(8, 12)), 'WAVE');
  assert.equal(dv.getUint32(24, true), 16000); assert.equal(dv.getUint16(22, true), 1); assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 8000 * 2); assert.equal(w.length, 44 + 16000);
  assert.deepEqual([...fromBase64(toBase64(w))], [...w]);
});

test('asrSelection：只在能做语音识别的服务商里选；指定优先；自定义必须填模型', () => {
  const k = (o) => ({ keys: o, use: '' });
  assert.equal(asrSelection(k({ anthropic: { key: 'a' } })), null);
  assert.deepEqual(asrSelection(k({ anthropic: { key: 'a' }, groq: { key: 'g' } })), { id: 'groq', key: 'g', model: 'whisper-large-v3-turbo', base: 'https://api.groq.com/openai/v1' });
  assert.equal(asrSelection(k({ openai: { key: 'o' }, groq: { key: 'g' } }), { use: 'groq' }).id, 'groq');
  assert.equal(asrSelection(k({ openai: { key: 'o' } }), { use: 'openai', model: 'gpt-x' }).model, 'gpt-x');
  assert.equal(asrSelection(k({ custom: { key: 'c', base: 'http://localhost:8000/v1' } })), null, '自定义地址没填模型');
  assert.equal(asrSelection(k({ custom: { key: 'c', base: 'http://localhost:8000/v1', asrModel: 'small' } })).model, 'small');
});
test('cleanSegments：去掉幻听套话、模型自己认为没人说话的、重复循环的；没有 segments 时用整段文字', () => {
  const j = { segments: [
    { start: 0, end: 2, text: ' Je ne sais pas. ', no_speech_prob: 0.02, avg_logprob: -0.3, compression_ratio: 1.2 },
    { start: 2, end: 3, text: 'Sous-titrage ST\' 501', no_speech_prob: 0.01 },
    { start: 3, end: 4, text: 'Thanks for watching!' },
    { start: 4, end: 5, text: 'bruit', no_speech_prob: 0.9, avg_logprob: -1.5 },
    { start: 5, end: 6, text: 'la la la la la la la', compression_ratio: 3.1 },
  ] };
  assert.deepEqual(cleanSegments(j, 6), [{ start: 0, end: 2, text: 'Je ne sais pas.' }]);
  assert.deepEqual(cleanSegments({ text: 'Bonjour tout le monde' }, 3), [{ start: 0, end: 3, text: 'Bonjour tout le monde' }]);
  assert.deepEqual(cleanSegments({}, 3), []);
});
test('transcribe：multipart 请求带模型/语言/格式，错误码映射', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ language: 'french', segments: [{ start: 0.1, end: 1.9, text: 'Bonjour.' }] }) }; };
  const sel = { id: 'groq', key: 'gk', model: 'whisper-large-v3-turbo', base: 'https://api.groq.com/openai/v1' };
  const r = await transcribe({ sel, wav: encodeWav(tone(2, 16000)), language: 'fr', durSec: 2, fetchFn: f });
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(seen.init.headers.authorization, 'Bearer gk');
  assert.equal(seen.init.body.get('model'), 'whisper-large-v3-turbo'); assert.equal(seen.init.body.get('language'), 'fr'); assert.equal(seen.init.body.get('response_format'), 'verbose_json');
  assert.equal(seen.init.body.get('file').size, 44 + 64000);
  assert.deepEqual(r.segments, [{ start: 0.1, end: 1.9, text: 'Bonjour.' }]); assert.equal(r.language, 'fr');
  const bad = (status) => transcribe({ sel, wav: new Uint8Array(10), durSec: 1, fetchFn: async () => ({ ok: false, status, text: async () => 'x', json: async () => ({}) }) });
  await assert.rejects(bad(401), { code: 'auth' }); await assert.rejects(bad(429), { code: 'rate_limit' }); await assert.rejects(bad(500), { code: 'upstream' });
  await assert.rejects(transcribe({ sel: null, wav: new Uint8Array(1), durSec: 1 }), { code: 'no_asr' });
  await assert.rejects(transcribe({ sel, wav: new Uint8Array(1), durSec: 1, fetchFn: async () => { throw new TypeError('x'); } }), { code: 'network' });
});

// ---------- 构建产物 ----------
test('构建产物是最新的（dist / manifest.json 与源码一致；改了源码请运行 npm run build:ext）', async () => {
  const out = await bundle({ write: false });
  for (const [f, text] of Object.entries(out)) {
    assert.ok(existsSync(resolve(EXT, f)), `${f} 不存在`);
    assert.equal(readFileSync(resolve(EXT, f), 'utf8'), text, `${f} 已过期，请运行 npm run build:ext`);
  }
  const zipPath = resolve(here, '../public/downloads/lectureloop-subtitles.zip');
  assert.ok(existsSync(zipPath), '缺少下载用的 zip');
  assert.ok(readFileSync(zipPath).equals(zipFiles(packageFiles())), 'zip 已过期，请运行 npm run build:ext');
});
test('manifest：MV3、权限最小、快捷键、主机权限覆盖各服务商', () => {
  const m = manifest();
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.permissions, ['storage', 'activeTab', 'scripting', 'sidePanel', 'unlimitedStorage']);
  assert.equal(m.side_panel.default_path, 'sidepanel/sidepanel.html');
  assert.equal(m.commands.panel.suggested_key.default, 'Alt+S');
  assert.ok(m.host_permissions.includes('https://api.anthropic.com/*') && m.host_permissions.includes('https://translate.googleapis.com/*'));
  assert.equal(m.commands.toggle.suggested_key.default, 'Alt+T');
  assert.equal(m.content_scripts[0].all_frames, true);
  for (const f of [m.background.service_worker, m.action.default_popup, m.options_ui.page, m.side_panel.default_path, ...m.content_scripts[0].js, ...Object.values(m.icons)]) assert.ok(existsSync(resolve(EXT, f)), `manifest 引用的 ${f} 不存在`);
});
