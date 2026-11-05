import { html, useState, useMemo } from '../h.js';
import { useStore, lessonUrl, getCourse, actions, getCues } from '../store.js';
import { download } from '../lib/util.js';
import { Empty, Seg } from '../components/ui.js';

const ST = { new: '新词', learning: '学习中', known: '已掌握' };

export function Vocab() {
  const lessons = useStore((s) => s.lessons);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('zh');

  const items = useMemo(() => lessons.flatMap((l) => (l.language?.vocab || []).map((v) => ({ ...v, lesson: l }))), [lessons]);
  const shown = items.filter((v) => (status === 'all' || v.status === status) && (!q || (v.term + Object.values(v.def || {}).join(' ')).toLowerCase().includes(q.toLowerCase())));

  async function exportCsv() {
    const rows = [];
    for (const v of shown) {
      const cue = (await getCues(v.lesson.id))[v.cue];
      const d = v.def || {};
      rows.push([v.term, [v.pos, d.zh, d.en, d.fr].filter(Boolean).join(' · '), cue?.text || '', `${getCourse(v.lesson.courseId)?.name || ''} / ${v.lesson.title}`].map((x) => `"${String(x).replace(/"/g, '""')}"`).join('\t'));
    }
    download('lectureloop-vocab.tsv', rows.join('\n'), 'text/tab-separated-values');
  }

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>词汇</h1><div class="muted small">来自所有课时的专业词汇与搭配 · 点 ▶ 回听原句</div></div>
      <button class="btn" disabled=${!shown.length} onClick=${exportCsv}>导出 Anki (TSV)</button></div>
    <div class="row wrap" style="margin-bottom:14px">
      <${Seg} value=${status} onChange=${setStatus} options=${[['all', `全部 ${items.length}`], ...Object.entries(ST)]} />
      <${Seg} value=${lang} onChange=${setLang} options=${[['zh', '中'], ['en', 'EN'], ['fr', 'FR']]} />
      <input type="search" placeholder="筛选…" value=${q} onInput=${(e) => setQ(e.target.value)} style="min-width:180px" />
    </div>
    ${items.length ? shown.map((v) => html`<div class="vcard" key=${v.lesson.id + v.term}>
      <div class="row"><span class="term">${v.term}</span><span class="muted small">${v.pos || ''}</span>
        <a class="play" href=${'#' + lessonUrl(v.lesson.id, { cue: v.cue })} aria-label="回听">▶</a>
        <select class="right" value=${v.status} onChange=${(e) => actions.setVocabStatus(v.lesson.id, v.term, e.target.value)}>${Object.entries(ST).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>
      <div>${v.def?.[lang] || v.def?.en || html`<span class="muted small">（离线版无释义，在课时的“语言”页用 AI 生成）</span>`}</div>
      ${v.heardAs?.length ? html`<div class="heard">常被听成：${v.heardAs.join(' / ')}</div>` : ''}
      <div class="tiny muted">${getCourse(v.lesson.courseId)?.name} › ${v.lesson.title}</div>
    </div>`) : html`<${Empty} icon="🔤" title="还没有词汇">打开一个课时，在“语言”页点“提取词汇”。<//>`}
  </div>`;
}
