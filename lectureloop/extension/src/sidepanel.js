// 字幕侧边栏（Chrome 侧边栏页面）：列出当前视频识别到的全部字幕（原文 + 译文），点句子跳转播放；
// 单词与句子可收藏，并按颜色标记；译文来自本地保存的转录与翻译记忆，同一个视频再看一遍不会重复翻译。
import { h, clear } from './dom.js';
import * as store from './core/store.js';
import { tokenize, wordKey, wordStats, COLORS, WORD_COLORS } from './core/words.js';
import { detectLang, LANGS } from './core/langs.js';
import { loadSettings, watchSettings } from './core/settings.js';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');

let tab = null;          // 正在跟随的标签页
let video = null;        // 当前视频的转录：{ key, title, url, lang, lines }
let nowId = '';          // 正在播放的句子 id
let settings = null;
let saved = new Map();   // 收藏：id → item
let loopId = '';         // 正在循环的句子
let card = null;         // 单词卡：{ word, ctx, lineId, start, lang, tr, loading }
let palFor = '';         // 展开了颜色面板的句子 id
let toastTimer = 0;
const prefs = (() => { try { return { tab: 'lines', follow: true, showOrig: true, showTr: true, hideStop: true, wordFilter: 'all', colorFilter: 'all', kindFilter: 'all', ...JSON.parse(localStorage.getItem('lsp') || '{}') }; } catch { return { tab: 'lines', follow: true, showOrig: true, showTr: true, hideStop: true, wordFilter: 'all', colorFilter: 'all', kindFilter: 'all' }; } })();
const savePrefs = () => { try { localStorage.setItem('lsp', JSON.stringify(prefs)); } catch { /* 忽略 */ } };
const setPref = (p) => { Object.assign(prefs, p); savePrefs(); render(); };

const fmt = (t) => { t = Math.max(0, Math.floor(t)); const h2 = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h2 ? h2 + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
// 中文靠文字本身判断最可靠；其余用记录下来的语言（字幕轨道的 srclang），再用逐句判断
const lineLang = (l) => { const d = detectLang(l.text); return d === 'zh' ? 'zh' : l.lang || video?.lang || d || 'en'; };
const targets = () => (settings?.targets || ['zh']);

// ---------- 数据 ----------
async function activeTab() {
  if (q.get('tabId')) return { id: +q.get('tabId') }; // 测试：在普通标签页里打开并指定目标标签页
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

/** 这个标签页当前的视频：来自内容脚本上报的状态 */
async function statusOf() {
  const all = await chrome.storage.session.get(null);
  const list = Object.entries(all).filter(([k, v]) => k.startsWith(`st:${tab?.id}:`) && v.on).map(([, v]) => v);
  return list.find((s) => s.video?.key) || list[0] || null;
}

async function reload({ keepNow = false } = {}) {
  const st = tab ? await statusOf() : null;
  const key = st?.video?.key;
  if (!keepNow) nowId = st?.video?.lineId || nowId;
  if (!key) { video = null; render(); return; }
  video = (await store.getVideo(key)) || { key, title: st.video.title, url: '', lang: st.source?.lang || null, lines: [] };
  if (st.video.title) video.title = st.video.title;
  render();
}

async function loadSaved() { saved = new Map((await store.savedAll()).map((s) => [s.id, s])); }
const savedWords = () => { const m = new Map(); for (const s of saved.values()) if (s.kind === 'word') m.set(wordKey(s.text), s); return m; };

const sendToTab = (msg) => (tab ? chrome.tabs.sendMessage(tab.id, msg).catch(() => null) : Promise.resolve(null));

function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast' }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

// ---------- 动作 ----------
const seek = (t, play = true) => sendToTab({ type: 'seek', t, play });
async function toggleLoop(l) {
  if (loopId === l.id) { loopId = ''; sendToTab({ type: 'loopClear' }); } else { loopId = l.id; await sendToTab({ type: 'loop', start: l.start, end: l.end }); }
  render();
}

async function saveSentence(l, color) {
  const id = `s:${video.key}:${l.id}`;
  if (!color) { await store.savedDelete(id); saved.delete(id); } else {
    const item = { id, kind: 'sentence', text: l.text, tr: l.tr?.[targets()[0]] || Object.values(l.tr || {})[0] || '', color, videoKey: video.key, url: video.url, title: video.title, start: l.start, lang: lineLang(l), ts: Date.now() };
    await store.savedPut(item); saved.set(id, item);
  }
  palFor = '';
  render();
}

async function saveWord(color) {
  if (!card) return;
  const id = `w:${wordKey(card.word)}`;
  if (!color) { await store.savedDelete(id); saved.delete(id); } else {
    const item = { id, kind: 'word', text: card.word, tr: card.tr || '', ctx: card.ctx, color, videoKey: video?.key || '', url: video?.url || '', title: video?.title || '', start: card.start || 0, lang: card.lang, ts: Date.now() };
    await store.savedPut(item); saved.set(id, item);
  }
  paintWord(wordKey(card.word));
  render();
}

/** 点一个词：打开单词卡并去查它的译文（带上这句话作为上下文） */
async function openCard(word, line) {
  const lang = lineLang(line);
  const to = targets().find((t) => t !== lang) || 'zh';
  const old = saved.get(`w:${wordKey(word)}`);
  card = { word, ctx: line.text, lineId: line.id, start: line.start, lang, tr: old?.tr || '', loading: !old?.tr };
  render();
  if (card.tr) return;
  const myWord = word;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'translate', source: lang, targets: [to], items: [{ i: 0, t: word }], context: [line.text], engine: settings.engine === 'chrome' ? 'auto' : settings.engine }); // “只用 Chrome 内置翻译”只能在视频页里运行，这里改用自动
    const t = r?.ok ? r.result.results?.[to]?.[0]?.t : '';
    if (card?.word === myWord) { card.tr = t || ''; card.loading = false; if (!t) card.err = r?.error?.message || '没有查到译文'; render(); }
  } catch (e) { if (card?.word === myWord) { card.loading = false; card.err = e.message; render(); } }
}

/** 只更新这个词在列表里的颜色（不重建整张列表） */
function paintWord(key) {
  const s = savedWords().get(key);
  for (const el of document.querySelectorAll(`.w[data-w="${CSS.escape(key)}"]`)) {
    el.classList.remove('c-red', 'c-yellow', 'c-green', 'c-blue');
    if (s) el.classList.add('c-' + s.color);
  }
}

// ---------- 渲染 ----------
const dots = (cur, colors, onPick) => colors.map((c) => h('button', { class: `dot ${c}` + (cur === c ? ' on' : ''), title: COLORS[c].label, 'aria-label': COLORS[c].label, onClick: () => onPick(c) }));

function lineRow(l, sw) {
  const sid = `s:${video.key}:${l.id}`;
  const sent = saved.get(sid);
  const lang = lineLang(l);
  const words = tokenize(l.text, lang).map((k) => {
    if (!k.word) return k.t;
    const key = wordKey(k.t);
    const s = sw.get(key);
    return h('span', { class: 'w' + (s ? ' c-' + s.color : ''), 'data-w': key, onClick: (e) => { e.stopPropagation(); openCard(k.t, l); } }, k.t);
  });
  const trs = prefs.showTr ? targets().filter((t) => t !== lang).map((t, n) => (l.tr?.[t] ? h('div', { class: 'tr' + (n ? ' t2' : '') }, l.tr[t]) : n === 0 ? h('div', { class: 'tr pending' }, '…') : null)) : [];
  return h('div', { class: 'ln' + (l.id === nowId ? ' cur' : '') + (sent ? ' sc-' + sent.color : '') + (l.id === loopId ? ' looping' : ''), 'data-id': l.id },
    h('div', { class: 'acts' },
      h('button', { title: '从这里播放', 'aria-label': '从这里播放', onClick: () => seek(l.start) }, '▶'),
      h('button', { class: l.id === loopId ? 'on' : '', title: '循环这一句', 'aria-label': '循环这一句', onClick: () => toggleLoop(l) }, '🔁'),
      h('button', { class: sent ? 'on' : '', title: sent ? '改颜色 / 取消收藏' : '收藏这句', 'aria-label': '收藏这句', onClick: () => { palFor = palFor === l.id ? '' : l.id; render(); } }, sent ? '★' : '☆')),
    h('div', { class: 'body', title: '点这一句跳到这里播放', onClick: () => seek(l.start) },
      h('span', { class: 't' }, fmt(l.start)),
      prefs.showOrig ? h('div', { class: 'orig' }, words) : null,
      trs,
      palFor === l.id ? h('div', { class: 'pal' }, '收藏为：', dots(sent?.color, Object.keys(COLORS), (c) => saveSentence(l, c)), sent ? h('button', { class: 'btn', onClick: () => saveSentence(l, null) }, '取消收藏') : null) : null));
}

function linesTab() {
  const lines = video?.lines || [];
  const to = targets();
  const missing = lines.filter((l) => to.filter((t) => t !== lineLang(l)).some((t) => !l.tr?.[t])).length;
  const sw = savedWords();
  const list = h('div', { class: 'list', id: 'list' }, lines.length ? lines.map((l) => lineRow(l, sw)) : h('div', { class: 'empty' }, video ? '还没有记录到字幕。开始播放，字幕会一句一句出现在这里。' : ''));
  return [
    h('div', { class: 'bar' },
      h('label', {}, h('input', { type: 'checkbox', id: 'f-orig', checked: prefs.showOrig, onChange: (e) => setPref({ showOrig: e.target.checked }) }), '原文'),
      h('label', {}, h('input', { type: 'checkbox', id: 'f-tr', checked: prefs.showTr, onChange: (e) => setPref({ showTr: e.target.checked }) }), '译文'),
      h('label', {}, h('input', { type: 'checkbox', id: 'f-follow', checked: prefs.follow, onChange: (e) => setPref({ follow: e.target.checked }) }), '跟随播放'),
      missing ? h('button', { class: 'btn', id: 'translate-all', title: '把还没有译文的句子全部翻译（用你选的翻译引擎）', onClick: async () => { const r = await sendToTab({ type: 'translateAll' }); toast(r ? `已开始翻译 ${r.n} 句` : '请先在视频页面开启字幕翻译'); } }, `翻译全部（${missing}）`) : null,
      h('span', {}, `${lines.length} 句`)),
    list,
  ];
}

function wordsTab() {
  const sw = savedWords();
  const lang = video?.lang || 'en';
  let stats = video ? wordStats(video.lines, lang, { hideStop: prefs.hideStop }) : [];
  if (prefs.wordFilter === 'saved') stats = stats.filter((s) => sw.has(s.word));
  else if (prefs.wordFilter === 'new') stats = stats.filter((s) => !sw.has(s.word));
  return [
    h('div', { class: 'bar' },
      ...[['all', '全部'], ['new', '未收藏'], ['saved', '已收藏']].map(([k, t]) => h('button', { class: 'chip' + (prefs.wordFilter === k ? ' on' : ''), onClick: () => setPref({ wordFilter: k }) }, t)),
      h('label', {}, h('input', { type: 'checkbox', id: 'f-stop', checked: prefs.hideStop, onChange: (e) => setPref({ hideStop: e.target.checked }) }), '隐藏常见词'),
      h('span', {}, `${stats.length} 个`)),
    h('div', { class: 'list' }, stats.length ? stats.slice(0, 600).map((s) => {
      const it = sw.get(s.word);
      return h('div', { class: 'row clickable', 'data-w': s.word, onClick: () => { const line = video.lines[s.firstLine]; if (line) openCard(s.word, line); } },
        h('span', { class: 'dotm' + (it ? ' ' + it.color : '') }), h('div', { class: 'main' }, h('div', { class: 'k' }, s.word), it?.tr ? h('div', { class: 'm' }, it.tr) : null), h('span', { class: 'cnt' }, '×' + s.count));
    }) : h('div', { class: 'empty' }, video ? '没有符合条件的单词。' : '')),
  ];
}

function savedTab() {
  let items = [...saved.values()].sort((a, b) => b.ts - a.ts);
  if (prefs.kindFilter !== 'all') items = items.filter((s) => s.kind === prefs.kindFilter);
  if (prefs.colorFilter !== 'all') items = items.filter((s) => s.color === prefs.colorFilter);
  return [
    h('div', { class: 'bar' },
      ...[['all', '全部'], ['word', '单词'], ['sentence', '句子']].map(([k, t]) => h('button', { class: 'chip' + (prefs.kindFilter === k ? ' on' : ''), onClick: () => setPref({ kindFilter: k }) }, t)),
      h('span', {}, '｜'),
      h('button', { class: 'chip' + (prefs.colorFilter === 'all' ? ' on' : ''), onClick: () => setPref({ colorFilter: 'all' }) }, '全部颜色'),
      ...Object.entries(COLORS).map(([c, v]) => h('button', { class: 'chip' + (prefs.colorFilter === c ? ' on' : ''), style: `border-color:${v.hex}`, onClick: () => setPref({ colorFilter: c }) }, v.label)),
      h('button', { class: 'btn', id: 'export', title: '导出为 TSV，可导入 Anki', disabled: !saved.size, onClick: exportTsv }, '导出 TSV')),
    h('div', { class: 'list' }, items.length ? items.map((s) => h('div', { class: 'row', 'data-id': s.id },
      h('span', { class: 'dotm ' + s.color, title: COLORS[s.color]?.label }),
      h('div', { class: 'main' }, h('div', { class: 'k' }, s.kind === 'sentence' ? '“' + s.text + '”' : s.text), s.tr ? h('div', { class: 'm' }, s.tr) : null, h('div', { class: 'm' }, `${s.kind === 'word' ? '单词' : '句子'} · ${s.title || s.videoKey || ''} · ${fmt(s.start || 0)}`)),
      h('button', { class: 'x', title: '跳到这里', 'aria-label': '跳到这里', onClick: () => jump(s) }, '▶'),
      h('button', { class: 'x', title: '删除', 'aria-label': '删除', onClick: async () => { await store.savedDelete(s.id); saved.delete(s.id); paintWord(wordKey(s.text)); render(); } }, '🗑'))) : h('div', { class: 'empty' }, '还没有收藏。在“字幕”里点 ☆ 收藏句子，点单词收藏单词。')),
  ];
}

function jump(s) {
  if (video && s.videoKey === video.key) { seek(s.start); return; }
  if (!s.url) return;
  const t = Math.floor(s.start || 0);
  const url = /^yt:/.test(s.videoKey) ? `${s.url}&t=${t}s` : s.url;
  chrome.tabs.create({ url });
}

function exportTsv() {
  const esc = (x) => String(x ?? '').replace(/[\t\r\n]+/g, ' ');
  const rows = [...saved.values()].sort((a, b) => a.ts - b.ts).map((s) => [s.kind === 'word' ? '单词' : '句子', s.text, s.tr, s.kind === 'word' ? s.ctx : '', COLORS[s.color]?.label || s.color, s.title, s.url, fmt(s.start || 0)].map(esc).join('\t'));
  const blob = new Blob(['类型\t原文\t译文\t例句\t颜色\t视频\t链接\t时间\n' + rows.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'lectureloop-saved.tsv' });
  document.body.append(a); a.click(); a.remove();
}

function cardView() {
  if (!card) return null;
  const it = saved.get(`w:${wordKey(card.word)}`);
  const ctx = (() => { const i = card.ctx.toLowerCase().indexOf(card.word.toLowerCase()); return i < 0 ? [card.ctx] : [card.ctx.slice(0, i), h('b', {}, card.ctx.slice(i, i + card.word.length)), card.ctx.slice(i + card.word.length)]; })();
  return h('div', { class: 'card', id: 'card' },
    h('button', { class: 'close', 'aria-label': '关闭', onClick: () => { card = null; render(); } }, '✕'),
    h('div', { class: 'w1' }, card.word),
    h('div', { class: 'tr1' }, card.loading ? '翻译中…' : card.tr || card.err || ''),
    h('div', { class: 'ctx' }, ctx),
    h('div', { class: 'btns' },
      ...WORD_COLORS.map((c) => h('button', { class: `cbtn ${c}` + (it?.color === c ? ' on' : ''), id: 'wc-' + c, onClick: () => saveWord(c) }, COLORS[c].label)),
      it ? h('button', { class: 'cbtn', onClick: () => saveWord(null) }, '取消收藏') : null));
}

function render() {
  const keepScroll = document.getElementById('list')?.scrollTop;
  const body = prefs.tab === 'words' ? wordsTab() : prefs.tab === 'saved' ? savedTab() : linesTab();
  const root = h('div', { class: 'app' },
    h('div', { class: 'head' },
      h('div', { class: 'tabs', role: 'tablist' }, ...[['lines', '字幕'], ['words', '单词'], ['saved', `收藏${saved.size ? ' ' + saved.size : ''}`]].map(([k, t]) => h('button', { class: 'tab' + (prefs.tab === k ? ' on' : ''), role: 'tab', 'data-tab': k, onClick: () => setPref({ tab: k }) }, t))),
      h('button', { class: 'ico', title: '设置（翻译引擎与密钥）', 'aria-label': '设置', onClick: () => chrome.runtime.openOptionsPage() }, '⚙')),
    video ? h('div', { class: 'sub', title: video.title }, video.title || video.key, video.src === 'yt-transcript' ? h('span', { class: 'srcb', title: '字幕来自 YouTube 自带的转写，已整理成与播放进度对齐的句子' }, ` · YouTube 转写${video.srcInfo?.lang ? '（' + (LANGS[video.srcInfo.lang] || video.srcInfo.lang) + (video.srcInfo.kind === 'asr' ? ' · 自动生成' : '') + '）' : ''}`) : null, video.src === 'yt-transcript' ? h('button', { class: 'btn', id: 'retx', style: 'margin-left:8px', title: '重新取一遍 YouTube 转写并整理', onClick: async () => { const r = await sendToTab({ type: 'reloadTranscript' }); toast(r ? '正在重新整理…' : '请先在视频页面开启字幕翻译'); } }, '⟳ 重新整理') : null) : h('div', { class: 'sub' }, '没有正在记录的视频'),
    video || prefs.tab === 'saved' ? body : h('div', { class: 'list' }, h('div', { class: 'empty' }, '还没有字幕。打开有字幕的视频，点插件图标开启“字幕翻译”，这里就会列出识别到的全部字幕。')),
    cardView());
  clear(app).append(root);
  const list = document.getElementById('list');
  if (list && keepScroll) list.scrollTop = keepScroll;
  if (prefs.tab === 'lines') markCurrent(false);
}

/** 只切换"当前句"高亮，不重建整张列表（播放时每句都会触发） */
function markCurrent(scroll) {
  const list = document.getElementById('list');
  if (!list) return;
  list.querySelector('.ln.cur')?.classList.remove('cur');
  const el = nowId ? list.querySelector(`.ln[data-id="${CSS.escape(nowId)}"]`) : null;
  el?.classList.add('cur');
  if (el && scroll && prefs.follow) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- 启动 ----------
let reloadTimer = 0;
const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => reload({ keepNow: true }), 250); };

async function init() {
  settings = await loadSettings();
  watchSettings((s) => { settings = s; render(); });
  await loadSaved();
  tab = await activeTab();
  await reload();
  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'tx-updated' && m.key === video?.key) reloadSoon(); });
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'session') return;
    const st = tab ? await statusOf() : null;
    if (st?.video?.key !== video?.key) { await reload(); return; }
    if (st?.video && st.video.lineId !== nowId) { nowId = st.video.lineId; markCurrent(true); }
    if (st?.video && st.video.n !== video.lines.length) reloadSoon();
  });
  if (!q.get('tabId')) {
    chrome.tabs.onActivated.addListener(async () => { tab = await activeTab(); loopId = ''; card = null; await reload(); });
    chrome.tabs.onUpdated.addListener((id, info) => { if (tab && id === tab.id && (info.status === 'complete' || info.url)) reloadSoon(); });
  }
}
init().catch((e) => { app.textContent = '加载失败：' + e.message; });
