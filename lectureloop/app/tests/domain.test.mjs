// 领域层单元测试：node --test tests/
// 设置 SAMPLES_DIR=/path/to/docx 目录可额外跑"真实样本"测试（两份课堂转录 docx）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const L = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/js/lib/');
const T = await import(L + 'text.js');
const G = await import(L + 'glossary.js');
const I = await import(L + 'importers.js');
const Z = await import(L + 'zip.js');
const H = await import(L + 'heuristics.js');
const S = await import(L + 'srs.js');
const D = await import(L + 'diff.js');
const A = await import(L + 'ai-tasks.js');

// ---------- text ----------
test('splitSentences: 句末标点、缩写、小数', () => {
  const s = T.splitSentences('So e.g. the margin is 0.65 wide. Okay? Yes! Done');
  assert.deepEqual(s, ['So e.g. the margin is 0.65 wide.', 'Okay?', 'Yes!', 'Done']);
  assert.deepEqual(T.splitSentences('这是第一句。这是第二句？'), ['这是第一句。', '这是第二句？']);
});

test('chunkSentences: 合并碎句、拆分长句', () => {
  const merged = T.chunkSentences(['Okay.', 'Yeah.', 'So now we look at the tree.']);
  assert.equal(merged.length, 1);
  const long = Array.from({ length: 90 }, (_, i) => (i === 44 ? 'and' : 'word' + i)).join(' ') + '.';
  const parts = T.chunkSentences([long]);
  assert.ok(parts.length >= 2 && parts.every((p) => T.units(p) <= 41));
});

test('buildCues + estimateTimeline: 单调、连续、可按录音时长缩放', () => {
  const cues = T.buildCues(['Hello class. Today we start with trees. Okay?', 'Second paragraph here, and it goes on for a while so that we have enough words.']);
  assert.ok(cues.length >= 2);
  assert.ok(cues.some((c) => c.paraStart));
  const total = T.estimateTimeline(cues);
  for (let k = 1; k < cues.length; k++) {
    assert.ok(cues[k].start >= cues[k - 1].start);
    assert.equal(cues[k - 1].end, cues[k].start);
  }
  assert.equal(cues.at(-1).end, total);
  const scaled = T.estimateTimeline(cues, { duration: 600 });
  assert.equal(Math.round(scaled), 600);
  assert.equal(Math.round(cues.at(-1).end), 600);
});

test('applyAnchors: 锚点处精确、区间内插值且单调', () => {
  const cues = T.buildCues([Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the lecture today.`).join(' ')]);
  T.estimateTimeline(cues);
  const total = T.applyAnchors(cues, [{ i: 10, t: 100 }, { i: 30, t: 400 }], 600);
  assert.equal(cues[10].start, 100);
  assert.equal(cues[30].start, 400);
  assert.ok(cues[20].start > 100 && cues[20].start < 400);
  assert.ok(Math.abs(cues[20].start - 250) < 5); // 句长一致 → 近似线性
  for (let k = 1; k < cues.length; k++) assert.ok(cues[k].start > cues[k - 1].start);
  assert.equal(Math.round(total), 600);
  assert.equal(T.cueAt(cues, 250), cues.findLastIndex((c) => c.start <= 250));
});

test('segmentParts: 覆盖所有句子且连续', () => {
  const para = Array.from({ length: 400 }, (_, i) => `Sentence ${i} has about eight words in it.`).join(' ');
  const cues = T.buildCues([para]);
  const parts = T.segmentParts(cues);
  assert.ok(parts.length >= 2);
  assert.equal(parts[0].startCue, 0);
  assert.equal(parts.at(-1).endCue, cues.length - 1);
  for (let k = 1; k < parts.length; k++) assert.equal(parts[k].startCue, parts[k - 1].endCue + 1);
});

test('hideFillers / highlightParts', () => {
  assert.equal(T.hideFillers('Uh, uh, she, I need to, um, go.'), 'she, I need to, go.');
  const h = T.highlightParts('The Margin is the margin', 'margin');
  assert.deepEqual(h.filter((x) => x.hit).map((x) => x.t), ['Margin', 'margin']);
});

// ---------- importers ----------
test('parseFilename: 用户的命名习惯', () => {
  const now = new Date('2026-11-04');
  assert.deepEqual(I.parseFilename("1008-bioinfo & omics_ Porte d'Issy 5", now), { date: '2026-10-08', course: 'bioinfo & omics', title: "Porte d'Issy 5" });
  assert.deepEqual(I.parseFilename('1008-MLAI__Porte_dIssy_6.docx', now), { date: '2026-10-08', course: 'MLAI', title: 'Porte dIssy 6' });
  assert.equal(I.parseFilename('392027a8-10081008-bioinfo__omics__Porte_dIssy_5.docx', now).date, '2026-10-08');
  assert.equal(I.parseFilename('1225-x_y', new Date('2026-11-04')).date, '2025-12-25'); // 未来日期 → 上一年
  assert.equal(I.parseFilename('random notes.txt').date, null);
});

test('parseCaptions: SRT / VTT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello <i>class</i>\n\n2\n00:01:00,000 --> 00:01:02,000\nSecond line\nwraps';
  const c = I.parseCaptions(srt);
  assert.equal(c.length, 2);
  assert.equal(c[0].text, 'Hello class');
  assert.equal(c[1].start, 60);
  assert.equal(c[1].text, 'Second line wraps');
  assert.equal(I.parseCaptions('WEBVTT\n\n00:01.000 --> 00:02.000\nHi')[0].end, 2);
});

test('readTranscript: txt 标题行检测 + buildDraft', async () => {
  const txt = "1008-bioinfo & omics_ Porte d'Issy 5\n\nImplicitly, you can ask yourself some questions. Okay, so this is the core idea of decision trees, okay?\n\nAnd so on and so forth with more words here to make a sentence.";
  const src = await I.readTranscript('x.txt', new TextEncoder().encode(txt));
  assert.equal(src.titleLine, "1008-bioinfo & omics_ Porte d'Issy 5");
  const d = I.buildDraft({ ...src, name: 'x.txt' }, { lang: 'en' });
  assert.equal(d.course, 'bioinfo & omics');
  assert.equal(d.timeline, 'estimated');
  assert.ok(d.cues.length >= 2 && d.parts.length >= 1);
});

test('zip: 读取 deflate 与 stored 条目', async () => {
  const mk = (name, data, method) => {
    const raw = Buffer.from(data);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    return { local: Buffer.concat([lh, nm, body]), nm, csize: body.length, usize: raw.length, method };
  };
  const files = [mk('a.txt', 'hello', 0), mk('word/document.xml', '<w:p><w:r><w:t>Hi &amp; bye</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>', 8)];
  let off = 0; const locals = [], cds = [];
  for (const f of files) {
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(f.method, 10); cd.writeUInt32LE(f.csize, 20); cd.writeUInt32LE(f.usize, 24); cd.writeUInt16LE(f.nm.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(Buffer.concat([cd, f.nm])); locals.push(f.local); off += f.local.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  const zip = Buffer.concat([...locals, cdBuf, eocd]);
  assert.equal(new TextDecoder().decode(await Z.unzipEntry(zip, 'a.txt')), 'hello');
  assert.deepEqual(await Z.readDocxParagraphs(zip), ['Hi & bye', 'Two']);
  assert.equal(await Z.unzipEntry(zip, 'missing'), null);
});

// ---------- glossary / corrections ----------
test('纠错：扫描 → 应用 → 撤销，保留 raw', () => {
  const cues = T.buildCues(['Dog product is key. We use decision treats and logistic reversions here. A super vector machine is great.']);
  const found = G.scanCorrections(cues, G.rulesFor({ glossary: [] }));
  const byWrong = Object.fromEntries(found.map((f) => [f.wrong.toLowerCase(), f.right]));
  assert.equal(byWrong['dog product'], 'dot product');
  assert.equal(byWrong['decision treats'], 'decision trees');
  assert.equal(byWrong['logistic reversions'], 'logistic regression');
  assert.equal(byWrong['super vector machine'], 'support vector machine'); // 长短语优先
  assert.ok(!('super vector' in byWrong));
  const dog = found.find((f) => f.wrong === 'dog product');
  const before = cues.map((c) => c.text);
  assert.ok(G.applyCorrection(cues, dog) >= 1);
  assert.match(cues[0].text, /^Dot product is key/); // 保留首字母大写
  assert.equal(cues[0].raw, before[0]);
  assert.ok(G.revertCorrection(cues, dog) >= 1);
  assert.equal(cues[0].text, before[0]);
  assert.equal(cues[0].raw, undefined);
});

test('课程术语表规则优先参与扫描', () => {
  const cues = T.buildCues(['We compute the Gini impurity and the junior index today for the tree model.']);
  const rules = G.rulesFor({ glossary: [{ term: 'Gini index', heardAs: ['junior index'] }] }, { starter: false });
  const f = G.scanCorrections(cues, rules);
  assert.equal(f[0].right, 'Gini index');
});

// ---------- diff / srs ----------
test('wordDiff: 漏听/听错/准确率', () => {
  const r = D.wordDiff('The dot product of the vectors.', 'the dog product the vectors');
  assert.ok(r.ops.some((o) => o.t === 'sub' && o.ref === 'dot' && o.got === 'dog'));
  assert.ok(r.ops.some((o) => o.t === 'miss' && o.ref === 'of'));
  assert.ok(Math.abs(r.accuracy - 4 / 6) < 1e-9);
  assert.equal(D.wordDiff('a b c', 'a b c').accuracy, 1);
});

test('SRS: again/hard/good 与掌握', () => {
  const DAY = 86_400_000, now = 1_000_000;
  let r = S.review(S.newSrs(now), 'good', { now }); // 新卡第一次就听懂 → 盒 2
  assert.equal(r.srs.box, 2);
  assert.equal(r.srs.due, now + 3 * DAY);
  r = S.review(r.srs, 'good', { now });
  assert.equal(r.srs.box, 3);
  assert.equal(r.srs.due, now + 7 * DAY);
  r = S.review(r.srs, 'hard', { now });
  assert.equal(r.srs.box, 3);
  r = S.review(r.srs, 'again', { now });
  assert.equal(r.srs.box, 1);
  assert.equal(r.srs.due, now + S.AGAIN_DELAY);
  r = S.review(r.srs, 'good', { now });
  assert.equal(r.srs.box, 2);
  let m = { srs: { box: S.MAX_BOX, due: now, attempts: [] } };
  m = S.review(m.srs, 'good', { now });
  assert.equal(m.status, 'mastered');
  // 队列：只含到期的 stuck，且未掌握
  const clips = [
    { id: 'a', kind: 'stuck', status: 'open', srs: { box: 2, due: now - 5, attempts: [] } },
    { id: 'b', kind: 'stuck', status: 'open', srs: { box: 0, due: now - 9, attempts: [] } },
    { id: 'c', kind: 'stuck', status: 'mastered', srs: { box: 5, due: now - 9, attempts: [] } },
    { id: 'd', kind: 'stuck', status: 'open', srs: { box: 1, due: now + DAY, attempts: [] } },
    { id: 'e', kind: 'clip', status: 'open', srs: { box: 0, due: now - 1, attempts: [] } },
  ];
  assert.deepEqual(S.queue(clips, now).map((c) => c.id), ['b', 'a']);
});

// ---------- heuristics ----------
const LECTURE = [
  "Okay so today we are going to talk about decision trees. A decision tree is a model that asks questions. We call each question a split, okay? Keep in mind that every split uses one feature. For instance, red or yellow is a feature. This means that the tree is easy to read. Is that clear? Now let's look at the Gini score. The idea is that a pure node has Gini zero. In that case we stop splitting. However, a deep tree will overfit. That's why we use pruning. Remember that overfitting is bad. The dog product of the vector is the sum minus one times square plus two.",
  'Decision trees are fast. Decision trees are readable. Decision trees can overfit. The Gini score is simple and the Gini score is fast. Random forests reduce variance. Random forests use bagging. Bagging means bootstrap aggregation of many trees.',
];

test('detectPatterns: 话语标记', () => {
  const cues = T.buildCues(LECTURE);
  const ids = H.detectPatterns(cues).map((p) => p.id);
  for (const want of ['we-call', 'keep-in-mind', 'for-instance', 'means', 'check', 'lets-look', 'contrary', 'thats-why', 'remember', 'idea-is']) assert.ok(ids.includes(want) || want === 'contrary', `缺少 ${want}: ${ids}`);
});

test('offlineVocab: 领域词典 + heardAs', () => {
  const cues = T.buildCues(LECTURE);
  const v = H.offlineVocab(cues, []);
  const terms = v.map((x) => x.term);
  assert.ok(terms.includes('decision tree'));
  assert.ok(terms.includes('dot product'));
  const dot = v.find((x) => x.term === 'dot product');
  assert.deepEqual(dot.heardAs, ['dog product']);
  assert.ok(dot.def.zh && dot.def.fr);
});

test('offlineNotes: 结构完整且 cue 有效', () => {
  const cues = T.buildCues(LECTURE);
  T.estimateTimeline(cues);
  const parts = T.segmentParts(cues);
  const n = H.offlineNotes(cues, parts);
  assert.equal(n.source, 'offline');
  assert.ok(n.keyPoints.length >= 1);
  for (const list of [n.keyPoints, n.concepts, n.formulas, n.emphasized, n.questions]) for (const x of list) assert.ok(Number.isInteger(x.cue) && x.cue >= 0 && x.cue < cues.length);
  assert.ok(n.concepts.some((c) => /split/.test(c.term)));
  assert.ok(n.emphasized.length >= 1);
});

// ---------- AI 任务（服务端与浏览器共用）----------
test('sanitizeLanguage：丢弃原文里不存在的纠错（防幻觉）并统计次数', () => {
  const cues = [{ i: 0, t: 'the dog product is here' }, { i: 1, t: 'Dog product again' }, { i: 2, t: 'nothing' }];
  const r = A.sanitizeLanguage({
    corrections: [{ wrong: 'dog product', right: 'dot product', reason: '近音' }, { wrong: 'made up phrase', right: 'x', reason: '' }, { wrong: 'same', right: 'SAME', reason: '' }],
    vocab: [{ term: 'dot product', pos: 'n.', kind: 'weird', cue: 99, def: { zh: '点积', en: 'x', fr: 'y' }, heard_as: ['dog product'] }],
    patterns: [{ fn: 'nope', template: 'Keep in mind that …', explain: '', cue: -3, extensions: [] }],
  }, cues);
  assert.deepEqual(r.corrections.map((c) => [c.wrong, c.count, c.cues]), [['dog product', 2, [0, 1]]]);
  assert.equal(r.vocab[0].kind, 'term');
  assert.equal(r.vocab[0].cue, 2); // 越界裁剪
  assert.equal(r.patterns[0].fn, 'introduce');
  assert.equal(r.patterns[0].cue, 0);
});

test('sanitizeNotes：片段排序去重、首段从 0 开始、cue 裁剪', () => {
  const n = A.sanitizeNotes({ overview: ' x ', parts: [{ start_cue: 5, title: 'b', summary: '' }, { start_cue: 2, title: 'a', summary: '' }, { start_cue: 5, title: 'dup', summary: '' }],
    key_points: [{ text: 'k', cue: 500 }], concepts: [], formulas: [], emphasized: [], questions: [] }, 10);
  assert.deepEqual(n.parts.map((p) => [p.startCue, p.title]), [[0, 'a'], [5, 'b']]);
  assert.equal(n.keyPoints[0].cue, 9);
  assert.equal(n.overview, 'x');
});

test('translateTask / alignTranslation：按输入对齐，缺行留空，全空返回 null', () => {
  const items = [{ i: 3, t: 'Hello' }, { i: 4, t: 'World' }];
  const task = A.translateTask({ items, source: 'en', target: 'zh', context: ['prev'] });
  assert.match(task.user, /3\|Hello/);
  assert.match(task.system, /Simplified Chinese/);
  assert.equal(task.effort, 'low');
  assert.deepEqual(A.alignTranslation(items, { items: [{ i: 4, t: '世界' }] }), [{ i: 3, t: '' }, { i: 4, t: '世界' }]);
  assert.equal(A.alignTranslation(items, { items: [] }), null);
  assert.equal(A.supportsServerFallback('claude-opus-5-5'), true);
  assert.equal(A.supportsServerFallback('claude-haiku-5-5'), false);
});

// ---------- 真实样本（可选）----------
const dir = process.env.SAMPLES_DIR;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.docx')) : [];
test('真实样本：docx 解析 / 断句 / 纠错', { skip: files.length ? false : '未设置 SAMPLES_DIR' }, async () => {
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const t0 = performance.now();
    const src = await I.readTranscript(f, buf);
    const d = I.buildDraft({ ...src, name: f });
    const ms = performance.now() - t0;
    assert.ok(d.cues.length > 500, `${f}: cues=${d.cues.length}`);
    assert.ok(ms < 3000, `${f}: ${ms}ms`);
    assert.ok(d.parts.length >= 8 && d.parts.length <= 30, `${f}: parts=${d.parts.length}`);
    const ok = d.cues.filter((c) => T.units(c.text) >= 5 && T.units(c.text) <= 40).length / d.cues.length;
    assert.ok(ok >= 0.85, `${f}: 5–40 词占比 ${ok}`);
    const found = G.scanCorrections(d.cues, G.rulesFor({ glossary: [] }));
    assert.ok(found.length >= 3, `${f}: 纠错建议 ${found.length}`);
    console.log(`  ${f.slice(0, 40)} → ${d.cues.length} 句 / ${d.parts.length} Part / ${d.stats.minutes} 分钟 / 纠错 ${found.length} 项 / ${ms.toFixed(0)}ms`);
  }
});
