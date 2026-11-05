// 通用小工具（纯函数，浏览器与 Node 均可用）
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${pad(m)}` : `${m} 分钟`;
}
export const fmtDate = (d) => {
  const x = new Date(d);
  return `${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const download = (name, text, mime = 'text/plain') => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
