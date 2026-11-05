// 悬浮字幕：
//  1) 页内悬浮块：可拖动、可缩放、可调背景透明度与字号，切换页面也一直显示（位置/大小/透明度会记住）
//  2) 弹出到桌面：使用 Chrome / Edge 的 Document Picture-in-Picture，字幕窗口会浮在所有软件之上。
//     浏览器窗口无法做成真正透明（系统限制），所以桌面窗口只能调大小、字号和深浅主题。
import { html, render, useState, useEffect, useRef } from '../h.js';
import { useStore, actions, setState, getState } from '../store.js';
import { useLive, live } from '../lib/live.js';
import { LANG_SHORT } from './ui.js';

export const FLOAT_DEFAULTS = { on: false, x: null, y: null, w: 560, h: 190, opacity: 0.6, font: 26, orig: true, tr: ['zh'], theme: 'dark', lock: false };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const pipSupported = () => 'documentPictureInPicture' in self;

/** 字幕内容：最近几句（越早越淡）+ 正在说的临时字幕 + 译文 */
export function CaptionBody({ f }) {
  const lines = useLive((s) => s.lines);
  const interim = useLive((s) => s.interim);
  const phase = useLive((s) => s.phase);
  const srcLang = useLive((s) => s.lang);
  const box = useRef();
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, interim]);
  const tr = (f.tr || []).filter((t) => t !== srcLang);
  const shown = lines.slice(-3);
  return html`<div class="fc-body" ref=${box} style=${`font-size:${f.font}px`}>
    ${shown.map((l, k) => html`<div class=${'fc-ln' + (k < shown.length - 1 ? ' old' : '')} key=${l.id}>
      ${f.orig ? html`<div class="fc-o">${l.text}</div>` : ''}
      ${tr.map((t, n) => (l.tr?.[t] ? html`<div class=${'fc-t' + (n ? ' t2' : '')}>${l.tr[t]}</div>` : ''))}
    </div>`)}
    ${interim && f.orig ? html`<div class="fc-ln interim"><div class="fc-o">${interim}</div></div>` : ''}
    ${!lines.length && !interim ? html`<div class="fc-empty">${phase === 'paused' ? '已暂停' : '正在聆听…'}</div>` : ''}
  </div>`;
}

/** 控制条：字号、语言、（页内）透明度、（桌面）主题、没听懂 */
function Controls({ f, set, pip }) {
  const srcLang = useLive((s) => s.lang);
  const langs = ['zh', 'fr', 'en'].filter((l) => l !== srcLang);
  const toggle = (l) => set({ tr: f.tr.includes(l) ? f.tr.filter((x) => x !== l) : [...f.tr, l].slice(-2) });
  return html`<div class="fc-ctl">
    <button class="fc-b" title="缩小字号" aria-label="缩小字号" onClick=${() => set({ font: clamp(f.font - 2, 12, 64) })}>A−</button>
    <button class="fc-b" title="放大字号" aria-label="放大字号" onClick=${() => set({ font: clamp(f.font + 2, 12, 64) })}>A＋</button>
    <button class=${'fc-b' + (f.orig ? ' on' : '')} title="显示原文" onClick=${() => set({ orig: !f.orig })}>原</button>
    ${langs.map((l) => html`<button class=${'fc-b' + (f.tr.includes(l) ? ' on' : '')} title=${'显示译文：' + LANG_SHORT[l]} onClick=${() => toggle(l)}>${LANG_SHORT[l]}</button>`)}
    ${pip ? html`<button class="fc-b" title="切换深色/浅色（系统不支持透明桌面窗口）" onClick=${() => set({ theme: f.theme === 'dark' ? 'light' : 'dark' })}>${f.theme === 'dark' ? '☾' : '☀'}</button>`
      : html`<label class="fc-b" title="背景透明度（越低越透明）">◐ <input type="range" min="0" max="100" value=${Math.round(f.opacity * 100)} onInput=${(e) => set({ opacity: +e.target.value / 100 })} aria-label="背景透明度" /></label>`}
    <button class="fc-b fc-stuck" title="没听懂：标记最近约 15 秒" onClick=${() => live.mark()}>🚩</button>
  </div>`;
}

let pipWin = null;
let pipRoot = null;

export async function openPip() {
  if (!pipSupported()) return false;
  const f = { ...FLOAT_DEFAULTS, ...(getState().settings.float || {}) };
  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: Math.round(f.w), height: Math.round(f.h) + 40 });
  } catch (e) {
    return e.message || false;
  }
  // 复制样式表（同源）
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    const c = pipWin.document.createElement('link');
    c.rel = 'stylesheet'; c.href = l.href;
    pipWin.document.head.appendChild(c);
  }
  pipWin.document.title = '悬浮字幕 · LectureLoop';
  pipRoot = pipWin.document.createElement('div');
  pipRoot.id = 'pip-root';
  pipWin.document.body.appendChild(pipRoot);
  pipWin.document.body.className = 'pip-body';
  render(html`<${PipApp} />`, pipRoot);
  setState((s) => ({ ui: { ...s.ui, pip: true } }));
  pipWin.addEventListener('pagehide', closePip);
  return true;
}
export function closePip() {
  const w = pipWin;
  if (pipRoot) render(null, pipRoot);
  pipWin = null; pipRoot = null;
  setState((s) => ({ ui: { ...s.ui, pip: false } }));
  try { w?.close(); } catch { /* 已关闭 */ }
}

function useFloat() {
  const settings = useStore((s) => s.settings);
  const f = { ...FLOAT_DEFAULTS, ...(settings.float || {}) };
  const set = (patch) => actions.setSetting('float', { ...f, ...patch });
  return [f, set];
}

/** 桌面（画中画）窗口里的内容 */
function PipApp() {
  const [f, set] = useFloat();
  return html`<div class=${'fc fc-pip th-' + f.theme}><${CaptionBody} f=${f} /><${Controls} f=${f} set=${set} pip=${true} /></div>`;
}

/** 页内悬浮块：挂在 App 根部，录音期间且开启悬浮字幕时显示 */
export function FloatingCaptions() {
  const phase = useLive((s) => s.phase);
  const pip = useStore((s) => !!s.ui.pip);
  const [f, set] = useFloat();
  const el = useRef();
  const drag = useRef(null);
  const [pipMsg, setPipMsg] = useState('');

  // 初始位置：底部居中
  const pos = {
    x: f.x ?? Math.max(8, (innerWidth - f.w) / 2),
    y: f.y ?? Math.max(8, innerHeight - f.h - 100),
  };
  // 记住用户拖拽缩放后的大小
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let t;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const w = Math.round(node.offsetWidth), h = Math.round(node.offsetHeight);
        if (Math.abs(w - f.w) > 3 || Math.abs(h - f.h) > 3) set({ w, h });
      }, 300);
    });
    ro.observe(node);
    return () => { ro.disconnect(); clearTimeout(t); };
  });
  // 录音结束时关闭桌面窗口
  useEffect(() => { if (phase === 'idle' && pip) closePip(); }, [phase]);

  if (!f.on || phase === 'idle' || pip) return null;

  const down = (e) => {
    if (e.target.closest('button, input, label, select')) return; // 只在空白处拖动；否则 setPointerCapture 会吞掉按钮的 click
    el.current.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const move = (e) => {
    if (!drag.current) return;
    const x = clamp(e.clientX - drag.current.dx, -f.w + 80, innerWidth - 80);
    const y = clamp(e.clientY - drag.current.dy, 0, innerHeight - 40);
    el.current.style.left = x + 'px'; el.current.style.top = y + 'px';
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    set({ x: parseInt(el.current.style.left, 10), y: parseInt(el.current.style.top, 10) });
  };

  const bg = f.theme === 'dark' ? '12,14,20' : '255,255,255';
  return html`<div class=${'fc fc-float th-' + f.theme + (f.lock ? ' lock' : '')} ref=${el}
      style=${`left:${pos.x}px;top:${pos.y}px;width:${f.w}px;height:${f.h}px;--fc-bg:rgba(${bg},${f.opacity})`}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} role="region" aria-label="悬浮字幕">
    <div class="fc-bar">
      <span class="fc-grip" title="拖动这里移动">⠿ 悬浮字幕</span>
      ${pipSupported() ? html`<button class="fc-b" title="弹出到桌面：浮在所有软件之上（Chrome / Edge）" onClick=${async () => { const r = await openPip(); if (r !== true) setPipMsg(typeof r === 'string' ? r : '无法打开桌面窗口'); }}>🖥 弹出到桌面</button>` : html`<span class="fc-b" title="需要桌面版 Chrome / Edge 116 或更新版本">🖥 不可用</span>`}
      <button class=${'fc-b' + (f.lock ? ' on' : '')} title="锁定：鼠标穿透，不挡住下面的页面（再点右上角 🔓 解除）" onClick=${() => set({ lock: !f.lock })}>${f.lock ? '🔒' : '🔓'}</button>
      <button class="fc-b fc-x" title="关闭悬浮字幕" aria-label="关闭悬浮字幕" onClick=${() => set({ on: false })}>✕</button>
    </div>
    <${CaptionBody} f=${f} />
    ${pipMsg ? html`<div class="fc-msg">${pipMsg}</div>` : ''}
    <${Controls} f=${f} set=${set} pip=${false} />
    ${f.lock ? html`<button class="fc-unlock" title="解除锁定" aria-label="解除锁定" onClick=${() => set({ lock: false })}>🔓</button>` : ''}
  </div>`;
}
