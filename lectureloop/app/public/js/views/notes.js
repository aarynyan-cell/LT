// 笔记面板：摘要笔记 / 原文对照 / 我的笔记。摘要层与原文层数据与视觉均分离；每条都能回听。
import { html, useState, useEffect, useRef } from '../h.js';
import { actions, getCourse } from '../store.js';
import { fmtTime, debounce, download } from '../lib/util.js';
import { Tabs, Empty } from '../components/ui.js';

export function Play({ cue, cues, player }) {
  const c = cues[cue];
  if (!c) return null;
  return html`<button class="play" title="从这句开始听" onClick=${() => player.seekCue(cue, true)}>▶ ${fmtTime(c.start)}</button>`;
}

function Editable({ value, onSave, rows = 4, empty = '（空）' }) {
  const [on, setOn] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!on) return html`<div style="white-space:pre-wrap">${value || html`<span class="muted">${empty}</span>`} <button class="btn sm ghost" aria-label="编辑" onClick=${() => setOn(true)}>✎</button></div>`;
  return html`<div><textarea rows=${rows} value=${v} onInput=${(e) => setV(e.target.value)}></textarea>
    <div class="row" style="margin-top:4px"><button class="btn sm primary" onClick=${() => { onSave(v); setOn(false); }}>保存</button><button class="btn sm" onClick=${() => { setV(value); setOn(false); }}>取消</button></div></div>`;
}

const List = ({ title, icon, items, cues, player, render }) => items?.length
  ? html`<div class="nsec"><h3>${icon} ${title}</h3>${items.map((it, k) => html`<div class="nitem" key=${k}><${Play} cue=${it.cue} cues=${cues} player=${player} /><div class="grow">${render(it)}</div></div>`)}</div>` : null;

export function exportMarkdown(lesson, cues, course) {
  const n = lesson.notes;
  const L = [`# ${course?.name || ''} · ${lesson.title}`, `> ${lesson.date || ''} · ${n?.source === 'claude' ? 'AI 生成（请对照原文）' : '离线粗略版'}`, ''];
  if (n) {
    if (n.overview) L.push('## 概览', n.overview, '');
    const sect = (t, arr, f) => arr?.length && L.push(`## ${t}`, ...arr.map((x) => `- [${fmtTime(cues[x.cue]?.start || 0)}] ${f(x)}`), '');
    L.push('## Part 摘要', ...lesson.parts.map((p) => `- **${p.title}** [${fmtTime(cues[p.startCue]?.start || 0)}] ${p.summary || ''}`), '');
    sect('要点', n.keyPoints, (x) => x.text);
    sect('概念', n.concepts, (x) => `**${x.term}** — ${x.definition}`);
    sect('公式', n.formulas, (x) => [x.expression && `\`${x.expression}\``, x.spoken && `口述：${x.spoken}`, x.explanation].filter(Boolean).join(' ｜ '));
    sect('老师强调', n.emphasized, (x) => x.text);
    sect('待问问题', n.questions, (x) => x.text);
    if (n.userNotes) L.push('## 我的笔记', n.userNotes, '');
  }
  L.push('## 原文', ...cues.map((c) => `[${fmtTime(c.start)}] ${c.text}`));
  download(`${lesson.title}.md`, L.join('\n'), 'text/markdown');
}

export function NotesPanel({ lesson, cues, player, busy }) {
  const [view, setView] = useState('summary');
  const n = lesson.notes;
  const course = getCourse(lesson.courseId);
  const [mine, setMine] = useState(n?.userNotes || '');
  const save = useRef(debounce((t) => actions.setUserNotes(lesson.id, t), 600)).current;

  const header = html`<div class="row wrap" style="margin-bottom:8px">
    ${n ? html`<span class=${'badge ' + (n.source === 'claude' ? 'acc' : 'warn')} title=${n.fallbackReason || ''}>${n.source === 'claude' ? `AI · ${n.model || 'Claude'}` : n.source === 'offline' ? '离线粗略版' : '仅我的笔记'}</span>` : ''}
    <button class="btn sm right" disabled=${busy} onClick=${() => actions.runNotes(lesson.id)}>${busy ? html`<span class="spin"></span> 生成中…` : n && n.source !== 'none' ? '↻ 重新生成' : '✨ 生成笔记'}</button>
    <button class="btn sm" onClick=${() => exportMarkdown(lesson, cues, course)}>导出 MD</button></div>`;

  return html`<div>
    ${header}
    <${Tabs} value=${view} onChange=${setView} options=${[['summary', '摘要笔记'], ['compare', '原文对照'], ['mine', '我的笔记']]} />
    ${view === 'mine' ? html`<textarea rows="16" placeholder="写下你自己的随堂笔记……（自动保存，重新生成摘要不会覆盖这里）" value=${mine} onInput=${(e) => { setMine(e.target.value); save(e.target.value); }}></textarea>`
      : !n || n.source === 'none' ? html`<${Empty} icon="📝" title="还没有摘要笔记">点右上“生成笔记”：有 Claude 密钥时由 AI 归纳（并重新划分主题片段），否则生成离线粗略版。<//>`
      : view === 'summary' ? html`<div>
        <div class="nsec"><h3>概览</h3><${Editable} value=${n.overview} onSave=${(v) => actions.updateNotes(lesson.id, { overview: v })} /></div>
        <div class="nsec"><h3>📚 Part 摘要</h3>${lesson.parts.map((p) => html`<div class="nitem" key=${p.id}><${Play} cue=${p.startCue} cues=${cues} player=${player} /><div class="grow"><b>${p.title}</b><${Editable} rows="3" value=${p.summary} onSave=${(v) => actions.setPartSummary(lesson.id, p.id, v)} empty="（暂无摘要）" /></div></div>`)}</div>
        <${List} title="要点" icon="📌" items=${n.keyPoints} cues=${cues} player=${player} render=${(x) => x.text} />
        <${List} title="概念" icon="💡" items=${n.concepts} cues=${cues} player=${player} render=${(x) => html`<b>${x.term}</b> — ${x.definition}`} />
        <${List} title="公式 / 口述" icon="∑" items=${n.formulas} cues=${cues} player=${player} render=${(x) => html`${x.expression ? html`<div class="mono">${x.expression}</div>` : ''}${x.spoken ? html`<div class="small muted">口述：“${x.spoken}”</div>` : ''}${x.explanation ? html`<div>${x.explanation}</div>` : ''}`} />
        <${List} title="老师强调" icon="★" items=${n.emphasized} cues=${cues} player=${player} render=${(x) => x.text} />
        <${List} title="待问 / 待回顾" icon="❓" items=${n.questions} cues=${cues} player=${player} render=${(x) => x.text} />
        <div class="tiny muted">${n.source === 'claude' ? 'AI 生成的摘要可能有误，请点 ▶ 对照原话。' : n.fallbackReason ? `离线粗略版（${n.fallbackReason}）：只是按词频与话语标记抽取的原句。` : ''}</div>
      </div>`
      : html`<div>${lesson.parts.map((p) => html`<div class="pair nsec" key=${p.id}>
          <div class="l"><b>${p.title}</b><div class="small" style="margin-top:4px;white-space:pre-wrap">${p.summary || html`<span class="muted">（暂无摘要）</span>`}</div></div>
          <div style="max-height:230px;overflow:auto" class="small">${cues.slice(p.startCue, p.endCue + 1).map((c) => html`<div key=${c.i} style="padding:2px 0;cursor:pointer" onClick=${() => player.seekCue(c.i, true)}><span class="mono muted tiny">${fmtTime(c.start)}</span> ${c.text}</div>`)}</div>
        </div>`)}</div>`}
  </div>`;
}
