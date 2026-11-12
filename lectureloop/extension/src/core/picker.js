// "选取字幕位置"：在页面上点一下正在显示的字幕文字，生成能代表这一类字幕的 CSS 选择器。
// 用于没有现成适配、也没有标准字幕轨道的网站。选择器只用有意义的类名/id（避开 css-1a2b3c 这种构建时生成的哈希类）。

const stableClass = (c) => /^[a-zA-Z][a-zA-Z-]{2,}$/.test(c) && !/^(css|jss|sc|styled|emotion)-/i.test(c);
const stableId = (id) => /^[a-zA-Z][a-zA-Z-]{2,}$/.test(id);

/** 为元素 el 生成选择器：从 el 向外找最多 4 层，取第一个"包含 el 且匹配 1–4 个元素"的稳定选择器 */
export function selectorFor(el, doc = el.ownerDocument) {
  let n = el, depth = 0;
  while (n && n !== doc.body && n.nodeType === 1 && depth < 4) {
    const tag = n.tagName.toLowerCase();
    const cands = [];
    if (n.id && stableId(n.id)) cands.push('#' + CSS.escape(n.id));
    const cls = [...n.classList].filter(stableClass);
    for (let k = 1; k <= Math.min(cls.length, 2); k++) cands.push('.' + cls.slice(0, k).map((c) => CSS.escape(c)).join('.'));
    for (let k = 1; k <= Math.min(cls.length, 2); k++) cands.push(tag + '.' + cls.slice(0, k).map((c) => CSS.escape(c)).join('.'));
    for (const sel of cands) {
      let hits;
      try { hits = doc.querySelectorAll(sel); } catch { continue; }
      if (hits.length >= 1 && hits.length <= 4 && [...hits].includes(n)) return sel;
    }
    n = n.parentElement; depth++;
  }
  return null;
}

/** 进入选取模式。返回 { cancel }。onPick(selector, text) 在点击后调用一次；onCancel 在 Esc / 取消时调用 */
export function startPicker({ doc = document, onPick, onCancel = () => {} }) {
  const host = doc.createElement('lectureloop-picker');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>.hl{position:fixed;border:2px solid #3b5bdb;background:rgba(59,91,219,.18);pointer-events:none;border-radius:4px}
  .tip{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#1c1f26;color:#fff;font:600 14px/1.5 system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none;max-width:80vw;text-align:center}</style>
  <div class="hl" hidden></div><div class="tip"></div>`;
  const hl = root.querySelector('.hl'), tip = root.querySelector('.tip');
  tip.textContent = '先暂停视频，让字幕停在屏幕上，然后点击字幕文字（Esc 取消）';
  doc.documentElement.append(host);
  const under = (x, y) => { host.style.pointerEvents = 'none'; const el = doc.elementFromPoint(x, y); host.style.pointerEvents = ''; return el && el !== host ? el : null; };
  const move = (e) => {
    const el = under(e.clientX, e.clientY);
    if (!el) { hl.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    hl.hidden = false;
  };
  const cleanup = () => { host.remove(); doc.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); onCancel(); } };
  host.addEventListener('mousemove', move);
  host.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = under(e.clientX, e.clientY);
    const text = (el?.textContent || '').trim();
    if (!el || !text) { tip.textContent = '这里没有文字，请点击正在显示的字幕文字'; return; }
    const sel = selectorFor(el, doc);
    if (!sel) { tip.textContent = '这个位置没法生成稳定的选择器，请换点字幕里更靠外的位置再试'; return; }
    cleanup();
    onPick(sel, text.slice(0, 80));
  });
  doc.addEventListener('keydown', key, true);
  return { cancel: () => { cleanup(); } };
}
