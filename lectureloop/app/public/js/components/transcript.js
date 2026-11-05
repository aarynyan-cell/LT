// 转录区：Part 折叠 + 句子行。播放时只用 DOM 直接切换当前句高亮，不触发重渲染。
import { html, useState, useEffect, useRef, useMemo } from '../h.js';
import { fmtTime } from '../lib/util.js';
import { hideFillers, highlightParts, partOf } from '../lib/text.js';
import { phraseRegex } from '../lib/glossary.js';
import { actions } from '../store.js';
import { Hl, LANG_SHORT } from './ui.js';

function CueText({ cue, hide, query }) {
  const text = hide ? hideFillers(cue.text) : cue.text;
  if (!cue.fx?.length) return html`<${Hl} parts=${highlightParts(text, query)} />`;
  const ranges = [];
  for (const f of cue.fx) for (const m of text.matchAll(phraseRegex(f.right))) ranges.push({ s: m.index, e: m.index + m[0].length, f });
  ranges.sort((a, b) => a.s - b.s);
  const out = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.s < pos) continue;
    if (r.s > pos) out.push(html`<${Hl} parts=${highlightParts(text.slice(pos, r.s), query)} />`);
    out.push(html`<span class="fx" title=${`ASR 听成：${r.f.wrong} → ${r.f.right}`}>${text.slice(r.s, r.e)}</span>`);
    pos = r.e;
  }
  if (pos < text.length) out.push(html`<${Hl} parts=${highlightParts(text.slice(pos), query)} />`);
  return out;
}

function CueRow({ cue, stuck, trLang, showTr, hide, query, editing, calibrated, on }) {
  const tr = showTr && cue.tr?.[trLang];
  const [draft, setDraft] = useState(cue.text);
  return html`<div class=${'cue' + (stuck ? ' stuck' : '')} data-i=${cue.i}>
    <span class="t" title="从这里开始播放" onClick=${() => on.play(cue.i)}>${fmtTime(cue.start)}</span>
    <div>
      ${editing
        ? html`<input style="width:100%" autofocus value=${draft} onInput=${(e) => setDraft(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') on.saveEdit(cue.i, draft); if (e.key === 'Escape') on.cancelEdit(); }} onBlur=${() => on.saveEdit(cue.i, draft)} />`
        : html`<div class="tx" onClick=${() => on.seek(cue.i)}>${stuck ? html`<span class="flag" title="已标记为卡点">🚩</span>` : ''}<${CueText} cue=${cue} hide=${hide} query=${query} />${cue.anchor ? html` <span title="锚点">⚓</span>` : ''}${cue.edited ? html` <span class="tiny muted" title=${'原始 ASR：' + cue.raw}>✎</span>` : ''}</div>`}
      ${tr ? html`<div class="tr">${tr}</div>` : ''}
    </div>
    <div class="acts">
      <button title="从这里播放" aria-label="从这里播放" onClick=${() => on.play(cue.i)}>▶</button>
      <button title="循环这一句" aria-label="循环这一句" onClick=${() => on.loop(cue.i)}>🔁</button>
      <button title=${stuck ? '取消卡点' : '标为卡点（M）'} aria-label="标为卡点" onClick=${() => on.mark(cue.i)}>🚩</button>
      <button title="设为锚点：把当前播放位置设为这句的起点" aria-label="设为锚点" onClick=${() => on.anchor(cue.i)}>⚓</button>
      <button title="编辑这句（保留 ASR 原文）" aria-label="编辑" onClick=${() => on.edit(cue.i)}>✎</button>
    </div>
  </div>`;
}

export function Transcript({ lesson, cues, player, stuckSet, settings, focusCue, on }) {
  const box = useRef();
  const active = useRef(-1);
  const [open, setOpen] = useState(() => new Set([lesson.parts[Math.max(0, partOf(lesson.parts, focusCue ?? 0))]?.id]));
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [editing, setEditing] = useState(-1);
  const pending = useRef(false); // 因高亮需要而刚展开的 Part：渲染后再滚动
  const openRef = useRef(open); openRef.current = open;
  const followRef = useRef(follow); followRef.current = follow;
  const { trLang, showTr, hideFillers: hide, blind } = settings;

  const langs = useMemo(() => ['zh', 'fr', 'en'].filter((l) => l !== lesson.srcLang && cues.some((c) => c.tr?.[l])), [cues, lesson.srcLang]);
  const tlang = langs.includes(trLang) ? trLang : langs[0];

  const apply = () => {
    const root = box.current;
    if (!root) return null;
    const prev = root.querySelector('.cue.active');
    const el = active.current >= 0 ? root.querySelector(`[data-i="${active.current}"]`) : null;
    if (prev && prev !== el) prev.classList.remove('active');
    el?.classList.add('active');
    return el;
  };
  const reveal = (el, force) => {
    const root = box.current;
    if (!el || !root || (!force && !followRef.current)) return;
    const r = el.getBoundingClientRect(), c = root.getBoundingClientRect();
    if (force || r.top < c.top + c.height * 0.15 || r.bottom > c.top + c.height * 0.8) el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  };

  useEffect(() => player.on('cue', (i) => {
    active.current = i;
    const p = lesson.parts[partOf(lesson.parts, i)];
    if (p && !openRef.current.has(p.id)) { pending.current = true; setOpen(new Set([...openRef.current, p.id])); return; } // 展开后由下方 effect 完成高亮
    reveal(apply());
  }), [player, lesson.parts]);

  // 每次渲染后重新应用高亮（展开/折叠、编辑后 DOM 重建）
  useEffect(() => { const el = apply(); if (pending.current && el) { pending.current = false; reveal(el); } });

  useEffect(() => { // 初始定位到 ?cue=
    if (focusCue == null) return;
    active.current = focusCue;
    setTimeout(() => { const el = apply(); reveal(el, true); }, 30);
  }, [focusCue]);

  const matches = useMemo(() => (query.trim().length < 2 ? null : cues.filter((c) => c.text.toLowerCase().includes(query.trim().toLowerCase())).map((c) => c.i)), [query, cues]);
  useEffect(() => { // 搜索命中的 Part 自动展开
    if (!matches?.length) return;
    setOpen(new Set(matches.map((i) => lesson.parts[partOf(lesson.parts, i)]?.id).filter(Boolean)));
  }, [matches?.length, query]);

  const toggle = (id) => { const n = new Set(open); n.has(id) ? n.delete(id) : n.add(id); setOpen(n); };
  const handlers = {
    ...on,
    edit: (i) => setEditing(i),
    cancelEdit: () => setEditing(-1),
    saveEdit: async (i, text) => { setEditing(-1); if (text.trim() && text !== cues[i].text) await on.editCue(i, text.trim()); },
  };

  return html`<div class=${'pane' + (blind ? ' blind' : '')} ref=${box}>
    <div class="tool">
      ${langs.length > 0 && html`<div class="seg" role="group" aria-label="译文">${langs.map((l) => html`<button class=${showTr && tlang === l ? 'on' : ''} onClick=${() => { actions.setSetting('trLang', l); actions.setSetting('showTr', showTr && tlang === l ? false : true); }}>${LANG_SHORT[l]}</button>`)}</div>`}
      <label class=${'chip' + (hide ? ' on' : '')} title="仅隐藏显示，不改数据"><input type="checkbox" class="hide" checked=${hide} onChange=${(e) => actions.setSetting('hideFillers', e.target.checked)} />隐藏语气词</label>
      <label class=${'chip' + (blind ? ' on' : '')} title="盲听：模糊文字，悬停显示（H）"><input type="checkbox" class="hide" checked=${blind} onChange=${(e) => actions.setSetting('blind', e.target.checked)} />🙈 盲听</label>
      <label class=${'chip' + (follow ? ' on' : '')}><input type="checkbox" class="hide" checked=${follow} onChange=${(e) => setFollow(e.target.checked)} />自动跟随</label>
      <input type="search" placeholder="本课内搜索" value=${query} onInput=${(e) => setQuery(e.target.value)} style="width:130px;padding:3px 8px" aria-label="本课内搜索" />
      ${matches ? html`<span class="tiny muted">${matches.length} 处</span>` : ''}
      <button class="btn sm ghost right" onClick=${() => setOpen(open.size >= lesson.parts.length ? new Set() : new Set(lesson.parts.map((p) => p.id)))}>${open.size >= lesson.parts.length ? '全部折叠' : '全部展开'}</button>
    </div>
    ${lesson.parts.map((p) => {
      const isOpen = open.has(p.id);
      const a = cues[p.startCue], b = cues[p.endCue];
      const nStuck = isOpen ? 0 : cues.slice(p.startCue, p.endCue + 1).filter((c) => stuckSet.has(c.i)).length;
      return html`<section key=${p.id}>
        <div class="part-h" onClick=${() => toggle(p.id)} role="button" aria-expanded=${isOpen} tabindex="0" onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(p.id))}>
          <span class="caret">${isOpen ? '▾' : '▸'}</span><b>${p.title}</b>
          <span class="tiny muted mono">${a ? fmtTime(a.start) : ''}–${b ? fmtTime(b.end) : ''}</span>
          ${nStuck ? html`<span class="badge stuck">${nStuck} 卡点</span>` : ''}
        </div>
        ${isOpen && p.summary ? html`<div class="small muted" style="padding:6px 8px 4px 22px">${p.summary}</div>` : ''}
        ${isOpen ? cues.slice(p.startCue, p.endCue + 1).map((c) => html`<${CueRow} key=${c.i} cue=${c} stuck=${stuckSet.has(c.i)} trLang=${tlang} showTr=${showTr} hide=${hide} query=${query} editing=${editing === c.i} on=${handlers} />`) : ''}
      </section>`;
    })}
  </div>`;
}
