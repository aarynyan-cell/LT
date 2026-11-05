// 通用 UI 组件与小工具
import { html, useEffect, useRef } from '../h.js';
import { useStore, dismissToast } from '../store.js';

export const REASONS = { speed: '语速太快', accent: '口音', term: '术语不熟', math: '公式口述', grammar: '句式复杂', noise: '音质/噪音', other: '其他' };
export const LANGS = { en: 'English', fr: 'Français', zh: '中文' };
export const LANG_SHORT = { en: 'EN', fr: 'FR', zh: '中' };

export function Modal({ title, onClose, children, foot, wide }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title} style=${wide ? 'width:min(860px,100%)' : ''}>
      <h2>${title}</h2>
      ${children}
      ${foot && html`<div class="foot">${foot}</div>`}
    </div>
  </div>`;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" aria-live="polite">
    ${toasts.map((t) => html`<div class=${'toast ' + (t.kind === 'warn' ? 'warn' : '')} key=${t.id}>
      <span>${t.msg}</span>
      ${t.undo && html`<button onClick=${() => { t.undo(); dismissToast(t.id); }}>撤销</button>`}
    </div>`)}
  </div>`;
}

export const Seg = ({ value, options, onChange }) => html`<div class="seg" role="group">
  ${options.map(([v, label]) => html`<button key=${v} class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}
</div>`;

export const Tabs = ({ value, options, onChange }) => html`<div class="tabs" role="tablist">
  ${options.map(([v, label]) => html`<button key=${v} role="tab" aria-selected=${v === value} class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}
</div>`;

export const Empty = ({ icon = '📭', title, children }) => html`<div class="empty"><div class="big">${icon}</div><div><b>${title}</b></div><div class="small">${children}</div></div>`;

export const TagChip = ({ tag, on, onClick }) => html`<span class=${'chip ' + (on ? 'on' : '')} onClick=${onClick} style=${on ? '' : ''}><span class="dot" style=${'background:' + tag.color}></span>${tag.name}</span>`;

/** 全局快捷键（输入框聚焦时不触发）。handler 总是使用最新闭包。 */
export function useHotkeys(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const f = (e) => {
      const t = e.target;
      if (/INPUT|TEXTAREA|SELECT/.test(t?.tagName) || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      ref.current(e);
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
}

/** 文字高亮（节点拼装，不使用 innerHTML） */
export function Hl({ parts }) {
  return html`${parts.map((p) => (p.hit ? html`<mark class="hit">${p.t}</mark>` : p.t))}`;
}

export function Shortcuts({ onClose }) {
  const rows = [
    ['Studio', [['Space', '播放 / 暂停'], ['← →', '上一句 / 下一句'], ['R', '重播当前句'], ['L', '循环当前句'], ['[ ]', '降速 / 升速'], ['M', '标为卡点'], ['A / B', '设置循环起点 / 终点（Esc 清除）'], ['H', '盲听（隐藏文字）']]],
    ['上课 Live', [['Space / M', '没听懂'], ['H', '按住显示淡出的原文']]],
    ['卡点训练', [['Space', '再听一遍'], ['S', '降一档速度'], ['Enter', '揭示 / 提交听写'], ['1 2 3', '自评：没懂 / 勉强 / 听懂']]],
    ['全局', [['?', '显示本面板']]],
  ];
  return html`<${Modal} title="快捷键" onClose=${onClose} foot=${html`<button class="btn primary" onClick=${onClose}>知道了</button>`}>
    ${rows.map(([h, items]) => html`<div class="nsec"><h3>${h}</h3>${items.map(([k, d]) => html`<div class="row small" style="padding:3px 0"><span class="kbd">${k}</span><span>${d}</span></div>`)}</div>`)}
  <//>`;
}
