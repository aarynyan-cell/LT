// 片段面板：卡点 + 素材片段 + 标签
import { html, useState } from '../h.js';
import { actions, clipTimes } from '../store.js';
import { fmtTime } from '../lib/util.js';
import { TAG_COLORS } from '../lib/seed.js';
import { REASONS, TagChip, Empty } from '../components/ui.js';

export function ClipsPanel({ lesson, cues, clips, tags, player }) {
  const [filter, setFilter] = useState(null);
  const [newTag, setNewTag] = useState('');
  const mine = clips.filter((c) => c.lessonId === lesson.id).sort((a, b) => a.startCue - b.startCue);
  const shown = filter ? mine.filter((c) => c.tags?.includes(filter)) : mine;

  const toggleTag = (c, id) => actions.updateClip(c.id, { tags: c.tags?.includes(id) ? c.tags.filter((t) => t !== id) : [...(c.tags || []), id] });
  const addTag = async () => { if (!newTag.trim()) return; await actions.addTag(newTag, TAG_COLORS[tags.length % TAG_COLORS.length]); setNewTag(''); };

  return html`<div>
    <div class="row wrap" style="margin-bottom:10px">
      <span class="small muted">标签筛选：</span>
      ${tags.map((t) => html`<${TagChip} key=${t.id} tag=${t} on=${filter === t.id} onClick=${() => setFilter(filter === t.id ? null : t.id)} />`)}
      <input placeholder="＋ 新标签" value=${newTag} onInput=${(e) => setNewTag(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addTag()} style="width:96px;padding:2px 8px;font-size:12px" aria-label="新标签名" />
    </div>
    <p class="tiny muted">在转录里点 🚩，或在时间轴上拖拽框选，即可添加卡点 / 片段。卡点会进入“卡点训练”队列。</p>
    ${shown.length ? shown.map((c) => {
      const { start, end } = clipTimes(c, cues);
      const st = c.kind === 'stuck';
      return html`<div class="vcard" key=${c.id} style=${st ? 'border-left:4px solid var(--stuck)' : 'border-left:4px solid var(--accent)'}>
        <div class="row wrap">
          <span class=${'badge ' + (st ? 'stuck' : 'acc')}>${st ? '🚩 卡点' : '🏷 片段'}</span>
          <span class="mono small">${fmtTime(start)}–${fmtTime(end)}</span>
          <button class="play" onClick=${() => player.playSpan(start, end)} title="循环播放这一段">🔁 听</button>
          ${c.practice ? html`<span class="tiny muted">盒 ${c.srs?.box} · ${c.status === 'mastered' ? '已掌握' : '下次 ' + new Date(c.srs.due).toLocaleDateString()}</span>` : ''}
          <button class="btn sm danger ghost right" aria-label="删除" onClick=${() => actions.deleteClip(c.id)}>🗑</button>
        </div>
        <div class="small" style="margin:4px 0">“${cues.slice(c.startCue, c.endCue + 1).map((x) => x.text).join(' ').slice(0, 160)}”</div>
        <div class="row wrap">
          ${st ? html`<select value=${c.reason || ''} onChange=${(e) => actions.updateClip(c.id, { reason: e.target.value })} aria-label="卡点原因"><option value="">原因？</option>${Object.entries(REASONS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select>`
            : html`<label class="row small"><input type="checkbox" checked=${c.practice} onChange=${(e) => actions.updateClip(c.id, { practice: e.target.checked })} /> 加入精听队列</label>`}
          <input class="grow" placeholder="备注" value=${c.note || ''} onChange=${(e) => actions.updateClip(c.id, { note: e.target.value })} aria-label="备注" />
        </div>
        <div class="row wrap" style="margin-top:6px">${tags.map((t) => html`<${TagChip} key=${t.id} tag=${t} on=${c.tags?.includes(t.id)} onClick=${() => toggleTag(c, t.id)} />`)}</div>
      </div>`;
    }) : html`<${Empty} icon="🚩" title=${filter ? '这个标签下没有片段' : '还没有标记'}>听不懂的地方按 <span class="kbd">M</span> 标记。<//>`}
  </div>`;
}
