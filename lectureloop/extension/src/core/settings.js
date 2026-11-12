// 设置：存在 chrome.storage.sync（失败时退回 local）。密钥单独放 storage.local 并限制为"受信任环境"（见 background.js），内容脚本读不到。
export const DEFAULTS = {
  source: 'auto',        // 原文语言：auto | zh | en | fr
  targets: ['zh'],       // 译文语言：1–2 个
  engine: 'auto',        // auto（有密钥用 AI，否则 Google 免费，再不行用 Chrome 内置） | llm | gtx | chrome
  showOrig: false,       // 悬浮层里同时显示原文（"隐藏网站字幕"开启时总是显示）
  hideSite: false,       // 隐藏网站自带字幕，只显示悬浮层
  fontScale: 1,
  bg: 0.55,
  pos: null,             // { cx, by }：字幕块中心横向位置与底边纵向位置，占视频宽/高的比例；null = 默认
  sites: {},             // { 'www.netflix.com': true }：这个网站打开页面就自动开启
  pickers: {},           // { 'host': ['css selector', …] }：手动选取的字幕位置
  endpoints: {},         // 测试用：{ gtx: 'http://127.0.0.1:8788/gtx' }
};
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 校验并补全：保证任何来源（旧版本、手动改过的存储）读出来都是合法设置 */
export function normalize(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  s.source = ['auto', 'zh', 'en', 'fr'].includes(s.source) ? s.source : 'auto';
  s.targets = [...new Set((Array.isArray(s.targets) ? s.targets : [s.targets]).filter((t) => ['zh', 'en', 'fr'].includes(t)))].slice(0, 2);
  if (!s.targets.length) s.targets = ['zh'];
  s.engine = ['auto', 'llm', 'gtx', 'chrome'].includes(s.engine) ? s.engine : 'auto';
  s.showOrig = !!s.showOrig; s.hideSite = !!s.hideSite;
  s.fontScale = clamp(+s.fontScale || 1, 0.5, 2.5);
  s.bg = clamp(Number.isFinite(+s.bg) ? +s.bg : 0.55, 0, 1);
  s.pos = s.pos && Number.isFinite(s.pos.cx) && Number.isFinite(s.pos.by) ? { cx: clamp(s.pos.cx, 0, 1), by: clamp(s.pos.by, 0.05, 1) } : null;
  s.sites = s.sites && typeof s.sites === 'object' ? s.sites : {};
  s.pickers = s.pickers && typeof s.pickers === 'object' ? s.pickers : {};
  s.endpoints = s.endpoints && typeof s.endpoints === 'object' ? s.endpoints : {};
  return s;
}

const area = (c) => c.storage.sync || c.storage.local;
export async function loadSettings(c = globalThis.chrome) {
  try { return normalize(await area(c).get(null)); } catch { return normalize(await c.storage.local.get(null)); }
}
export async function saveSettings(patch, c = globalThis.chrome) {
  try { await area(c).set(patch); } catch { await c.storage.local.set(patch); }
}
/** 监听设置变化；cb 收到完整的新设置 */
export function watchSettings(cb, c = globalThis.chrome) {
  const f = (changes, name) => { if (name === 'sync' || name === 'local') loadSettings(c).then(cb); };
  c.storage.onChanged.addListener(f);
  return () => c.storage.onChanged.removeListener(f);
}
/** 页面所在网站：iframe 里取最顶层页面的主机名（播放器常嵌在 iframe 里） */
export function siteOf(loc = globalThis.location) {
  try {
    const top = loc.ancestorOrigins?.length ? loc.ancestorOrigins[loc.ancestorOrigins.length - 1] : null;
    return new URL(top && top !== 'null' ? top : loc.href).hostname;
  } catch { return loc.hostname || ''; }
}
