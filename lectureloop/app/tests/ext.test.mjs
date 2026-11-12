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
  assert.deepEqual(m.permissions, ['storage', 'activeTab', 'scripting']);
  assert.ok(m.host_permissions.includes('https://api.anthropic.com/*') && m.host_permissions.includes('https://translate.googleapis.com/*'));
  assert.equal(m.commands.toggle.suggested_key.default, 'Alt+T');
  assert.equal(m.content_scripts[0].all_frames, true);
  for (const f of [m.background.service_worker, m.action.default_popup, m.options_ui.page, ...m.content_scripts[0].js, ...Object.values(m.icons)]) assert.ok(existsSync(resolve(EXT, f)), `manifest 引用的 ${f} 不存在`);
});
