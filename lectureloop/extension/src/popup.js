import { h, clear } from './dom.js';
import { LANGS, SOURCE_OPTIONS } from './core/langs.js';
import { loadSettings, saveSettings, watchSettings } from './core/settings.js';
import { loadKeys } from './core/keys.js';
import { PROVIDERS } from '../../app/public/js/lib/providers.js';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');
let tab = null, settings = null, keys = null, statuses = [];
let pageSite = '';        // 内容脚本报告的网站（拿不到标签页地址时用它）
let blocked = false;       // 内容脚本连不上、也注入不进去：浏览器内部页面 / 应用商店页面

async function init() {
  // 注意：没有 tabs / activeTab / 主机权限时，Chrome 不会给出 tab.url（只有 id）——不能靠地址判断页面是否可用
  if (q.get('tabId')) { tab = await chrome.tabs.get(+q.get('tabId')).catch(() => ({ id: +q.get('tabId') })); if (q.get('url')) tab = { ...tab, url: q.get('url') }; } // 测试：在普通标签页里打开弹窗并指定目标标签页
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await ensureScript();
  if (r) pageSite = r.site || '';
  settings = await loadSettings();
  keys = await loadKeys();
  await readStatus();
  watchSettings((s) => { settings = s; render(); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' || (area === 'local' && ch.keys)) { Promise.all([readStatus(), loadKeys().then((k) => { keys = k; })]).then(render); } });
  render();
}

async function readStatus() {
  const all = await chrome.storage.session.get(null);
  statuses = Object.entries(all).filter(([k]) => k.startsWith(`st:${tab?.id}:`)).map(([, v]) => v);
}
const siteOfTab = () => { try { return new URL(tab.url).hostname; } catch { return pageSite; } };
// 地址已知且不是网页（chrome:// 等）才算不支持；地址未知时以"内容脚本能不能连上"为准
const supported = () => (tab?.url ? /^https?:/i.test(tab.url) : !blocked);

const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'ping' }).catch(() => null);
/** 内容脚本在吗？不在（插件是在这个页面打开之后才装/更新的）就用 activeTab 权限补注入一次；注入不了说明是浏览器不允许的页面 */
async function ensureScript() {
  let r = await ping();
  if (r) return r;
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['dist/content.js'] }); } catch { blocked = true; return null; }
  await new Promise((res) => setTimeout(res, 150));
  r = await ping();
  if (!r) blocked = true;
  return r;
}
const isOn = () => statuses.some((s) => s.on);

async function setEnabled(on) {
  if (on && !(await ensureScript())) { render(); return; }
  await chrome.tabs.sendMessage(tab.id, { type: 'setEnabled', on }).catch(() => {});
  if (!on) statuses = [];
  setTimeout(async () => { await readStatus(); render(); }, 400);
}
const set = (patch) => { settings = { ...settings, ...patch }; saveSettings(patch); render(); };
// 滑块拖动时每秒会触发几十次 input：chrome.storage.sync 每分钟最多写 120 次，超了会失败并读回旧值，所以合并后延迟写入
let pending = {}, timer = 0;
const setLater = (patch) => {
  settings = { ...settings, ...patch };
  pending = { ...pending, ...patch };
  clearTimeout(timer);
  timer = setTimeout(() => { const p = pending; pending = {}; saveSettings(p); }, 250);
};

function statusBox() {
  const best = statuses.filter((s) => s.on).sort((a, b) => (b.source ? 1 : 0) - (a.source ? 1 : 0))[0];
  if (!supported()) return h('div', { class: 'status warn' }, '这个页面不支持：浏览器内部页面（chrome://…）和应用商店页面不允许扩展读取。请切到有视频的网页再点开。');
  if (!best) return h('div', { class: 'status muted' }, '未开启。打开上面的开关，或按 Alt+T。');
  const lines = [];
  let tone = 'ok';
  if (best.source) lines.push(h('div', {}, '✔ 字幕来源：', best.source.label, best.source.lang ? `（${best.source.lang}）` : ''));
  else { tone = 'warn'; lines.push(h('div', {}, '… 还没找到字幕。请先在播放器里打开字幕；没有反应就点“选取字幕位置”。')); }
  const eng = best.provider === 'gtx' ? 'Google 免费翻译' : best.provider?.startsWith('ai:') ? `AI（${PROVIDERS[best.provider.slice(3)]?.name || best.provider}）` : best.provider === 'chrome' ? 'Chrome 内置翻译' : '';
  if (best.translated || eng) lines.push(h('div', { class: 'tiny muted' }, `已翻译 ${best.translated} 句${eng ? ' · 引擎：' + eng : ''}`));
  if (best.note) { tone = 'warn'; lines.push(h('div', { class: 'tiny' }, best.note)); }
  if (best.error) { tone = 'err'; lines.push(h('div', { class: 'tiny' }, '⚠ ', best.error)); }
  return h('div', { class: 'status ' + tone }, lines);
}

function sel(id, options, value, onChange, labelText) {
  const s = h('select', { id, onChange: (e) => onChange(e.target.value) }, Object.entries(options).map(([k, v]) => h('option', { value: k, selected: k === value }, v)));
  return h('div', { class: 'grow' }, h('label', { class: 'f', for: id }, labelText), s);
}

function render() {
  if (document.activeElement?.type === 'range') return; // 拖动滑块时不要重建界面，否则滑块会失去焦点
  const site = siteOfTab();
  const hasKey = !!keys?.use;
  const t1 = settings.targets[0], t2 = settings.targets[1] || '';
  const targetOpts = LANGS;
  const root = h('div', {},
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('h1', {}, 'LectureLoop 字幕翻译'), h('div', { class: 'tiny muted' }, site || '当前页面')),
      h('label', { class: 'switch', title: '开 / 关（Alt+T）' }, h('input', { type: 'checkbox', id: 'on', 'aria-label': '在这个标签页翻译字幕', checked: isOn(), disabled: !supported(), onChange: (e) => setEnabled(e.target.checked) }), h('i'))),
    h('div', { class: 'checks', style: 'margin-top:6px' },
      h('label', {}, h('input', { type: 'checkbox', id: 'always', disabled: !site, checked: !!settings.sites[site], onChange: (e) => set({ sites: { ...settings.sites, [site]: e.target.checked } }) }), '以后打开 ', site || '这个网站', ' 自动开启')),
    h('div', { class: 'sec' }, statusBox()),
    h('div', { class: 'sec' },
      h('div', { class: 'row' },
        sel('src', SOURCE_OPTIONS, settings.source, (v) => set({ source: v }), '字幕语言'),
        h('div', { style: 'padding-top:18px' }, '→'),
        sel('t1', targetOpts, t1, (v) => set({ targets: [v, ...(t2 && t2 !== v ? [t2] : [])] }), '翻译成')),
      h('div', { class: 'row', style: 'margin-top:6px' },
        sel('t2', { '': '（无）', ...targetOpts }, t2, (v) => set({ targets: v ? [t1, v].filter((x, i, a) => a.indexOf(x) === i) : [t1] }), '再加一种译文（可选）'))),
    h('div', { class: 'sec checks' },
      h('label', {}, h('input', { type: 'checkbox', id: 'orig', checked: settings.showOrig || settings.hideSite, disabled: settings.hideSite, onChange: (e) => set({ showOrig: e.target.checked }) }), '同时显示原文'),
      h('label', {}, h('input', { type: 'checkbox', id: 'hide', checked: settings.hideSite, onChange: (e) => set({ hideSite: e.target.checked }) }), '隐藏网站自带字幕（只看悬浮字幕）')),
    h('div', { class: 'sec' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'fs' }, '字号'), h('input', { type: 'range', id: 'fs', min: 0.5, max: 2.5, step: 0.1, value: settings.fontScale, onInput: (e) => setLater({ fontScale: +e.target.value }) })),
        h('div', { class: 'grow' }, h('label', { class: 'f', for: 'bg' }, '背景深浅'), h('input', { type: 'range', id: 'bg', min: 0, max: 1, step: 0.05, value: settings.bg, onInput: (e) => setLater({ bg: +e.target.value }) }))),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn grow', id: 'pick', disabled: !supported(), title: '网站没有被自动识别时：点一下正在显示的字幕文字', onClick: async () => { if (!(await ensureScript())) return render(); await chrome.tabs.sendMessage(tab.id, { type: 'setEnabled', on: true }).catch(() => {}); chrome.tabs.sendMessage(tab.id, { type: 'pick' }).catch(() => {}); if (!q.get('tabId')) window.close(); } }, '选取字幕位置'),
        h('button', { class: 'btn grow', id: 'reset', title: '恢复默认位置，并清除这个网站上手动选取的字幕位置', onClick: () => set({ pos: null, pickers: Object.fromEntries(Object.entries(settings.pickers).filter(([k]) => k !== site)) }) }, '重置位置'))),
    h('div', { class: 'sec' },
      sel('eng', { auto: '自动（有 AI 密钥用 AI，否则用 Google 免费）', llm: '只用 AI 密钥', gtx: '只用 Google 免费翻译', chrome: '只用 Chrome 内置翻译' }, settings.engine, (v) => set({ engine: v }), '翻译引擎'),
      h('div', { class: 'tiny muted', style: 'margin-top:6px' }, hasKey ? `AI 密钥：${PROVIDERS[keys.use]?.name || keys.use}` : '还没有 AI 密钥——现在用的是免费的 Google 翻译（质量够看，但不如 AI 贴合语气）。', ' ',
        h('a', { href: '#', id: 'opts', onClick: (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); } }, '设置密钥'))));
  clear(app).append(root);
}

init().catch((e) => { app.textContent = '加载失败：' + e.message; });
