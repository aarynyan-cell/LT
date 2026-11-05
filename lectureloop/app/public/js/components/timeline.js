// 时间轴：Part 分段 · 语速/信息密度条 · 卡点 · 片段 · 循环区 · 锚点 · 播放头。
// 点击跳转；在空白处拖拽框选（吸附到句边界）→ 弹出操作条。
import { html, useState, useEffect, useRef, useMemo } from '../h.js';
import { cueAt, densityBuckets } from '../lib/text.js';
import { clipTimes } from '../store.js';
import { fmtTime } from '../lib/util.js';

export function Timeline({ player, cues, parts, duration, clips, tags, anchors = [], onSelect, showDensity = true }) {
  const box = useRef(), ph = useRef();
  const drag = useRef(null);
  const [sel, setSel] = useState(null);   // { startCue, endCue, a, b }
  const [loop, setLoop] = useState(player.loop);

  const bucket = Math.max(15, Math.ceil(duration / 220));
  const dens = useMemo(() => densityBuckets(cues, duration, bucket), [cues, duration, bucket]);
  const pct = (t) => `${(t / duration) * 100}%`;

  useEffect(() => player.on('time', (t) => { if (ph.current) ph.current.style.left = pct(t); }), [player, duration]);
  useEffect(() => player.on('state', (s) => setLoop(s.loop)), [player]);
  useEffect(() => { if (ph.current) ph.current.style.left = pct(player.time); }, [duration]);

  const tAt = (e) => {
    const r = box.current.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
  };
  const snap = (a, b) => {
    const i = cueAt(cues, Math.min(a, b)), j = cueAt(cues, Math.max(a, b));
    return { startCue: i, endCue: j, a: cues[i].start, b: cues[j].end, x: ((cues[i].start + cues[j].end) / 2 / duration) * 100 };
  };

  const down = (e) => {
    if (e.button !== 0) return;
    box.current.setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, t0: tAt(e), moved: false };
    setSel(null); onSelect?.(null);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) > 5) d.moved = true;
    if (d.moved) setSel(snap(d.t0, tAt(e)));
  };
  const up = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { player.seek(d.t0); return; }
    const s = snap(d.t0, tAt(e));
    setSel(s); onSelect?.(s);
  };

  const tagColor = (c) => tags.find((t) => t.id === c.tags?.[0])?.color || 'var(--accent)';

  return html`<div style="position:relative">
    <div class="tl" ref=${box} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} role="slider" aria-label="时间轴" aria-valuemin="0" aria-valuemax=${Math.round(duration)} tabindex="0"
      onKeyDown=${(e) => { if (e.key === 'ArrowLeft' && e.shiftKey) player.seek(player.time - 10); if (e.key === 'ArrowRight' && e.shiftKey) player.seek(player.time + 10); }}>
      ${parts.map((p) => { const a = cues[p.startCue], b = cues[p.endCue]; return a && b ? html`<div class="seg-part" key=${p.id} title=${p.title} style=${`left:${pct(a.start)};width:${((b.end - a.start) / duration) * 100}%`}>${p.title.replace(/ ·.*/, '')}</div>` : ''; })}
      ${showDensity ? html`<div class="dens">${dens.map((v) => html`<i style=${`height:${Math.max(4, v * 100)}%`}></i>`)}</div>` : html`<div class="dens" title="估算时间轴：语速密度不可用（绑定录音并校准后显示）"></div>`}
      ${clips.map((c) => { const { start, end } = clipTimes(c, cues); const st = c.kind === 'stuck';
        return html`<div key=${c.id} class=${'mk ' + (st ? 'stuck' : '')} style=${`left:${pct(start)};width:max(3px,${((end - start) / duration) * 100}%);${st ? '' : 'display:none'}`}></div>
          <div class=${'mk-b ' + (st ? 'stuck' : 'c')} title=${`${st ? '卡点' : '片段'} ${fmtTime(start)}–${fmtTime(end)}`} style=${`left:${pct(start)};width:max(3px,${((end - start) / duration) * 100}%);${st ? '' : `background:${tagColor(c)}`}`}></div>`; })}
      ${anchors.map((a) => cues[a.i] ? html`<span class="anchor" style=${`left:${pct(cues[a.i].start)}`} title=${`锚点 ${fmtTime(cues[a.i].start)}`}>⚓</span>` : '')}
      ${loop ? html`<div class="loopbox" style=${`left:${pct(loop.a)};width:${((loop.b - loop.a) / duration) * 100}%`}></div>` : ''}
      ${sel ? html`<div class="sel" style=${`left:${pct(sel.a)};width:${((sel.b - sel.a) / duration) * 100}%`}></div>` : ''}
      <div class="ph" ref=${ph}></div>
    </div>
    ${sel && html`<div class="selbar" style=${`left:${Math.min(88, Math.max(12, sel.x))}%;top:-6px`}>
      <button class="btn sm stuck" onClick=${() => { onSelect?.({ ...sel, act: 'stuck' }); setSel(null); }}>🚩 标为卡点</button>
      <button class="btn sm" onClick=${() => { onSelect?.({ ...sel, act: 'clip' }); setSel(null); }}>🏷 存为片段</button>
      <button class="btn sm" onClick=${() => { player.playSpan(sel.a, sel.b); setSel(null); }}>🔁 循环</button>
      <button class="btn sm ghost" aria-label="取消" onClick=${() => { setSel(null); onSelect?.(null); }}>✕</button>
    </div>`}
  </div>`;
}
