import { html, useState, useEffect } from '../h.js';
import { useStore, actions, navigate, lessonUrl, getCourse, getLesson } from '../store.js';
import { debounce, fmtTime } from '../lib/util.js';
import { highlightParts } from '../lib/text.js';
import { Modal, Empty, Hl, LANGS } from '../components/ui.js';

export function Library() {
  const courses = useStore((s) => s.courses);
  const lessons = useStore((s) => s.lessons);
  const clips = useStore((s) => s.clips);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const run = debounce(async () => setHits(await actions.search(q)), 150);
    run();
    return () => run.cancel();
  }, [q, lessons]);

  const terms = [...new Set(courses.map((c) => c.term || '未分学期'))].sort().reverse();

  return html`<div class="page">
    <div class="page-head">
      <div class="grow"><h1>课程库</h1><div class="muted small">学期 › 课程 › 课时 › 片段 —— 所有课堂内容长期保存在本机</div></div>
      <button class="btn" onClick=${() => setAdding(true)}>＋ 新建课程</button>
      <button class="btn primary" onClick=${() => actions.setUi({ importOpen: true })}>📥 导入</button>
    </div>
    <input type="search" placeholder="🔍 在所有课堂里搜索一个词或短语（原文 / 译文）…" value=${q} onInput=${(e) => setQ(e.target.value)} style="width:100%;padding:10px 14px;font-size:16px;margin-bottom:16px" aria-label="全文搜索" />

    ${hits ? html`<div class="card flat">
      <div class="small muted" style="margin-bottom:6px">${hits.length ? `找到 ${hits.length}${hits.length >= 120 ? '+' : ''} 处` : '没有匹配'}</div>
      ${hits.map((h) => html`<a key=${h.lessonId + h.i} class="row" style="padding:8px 4px;border-bottom:1px solid var(--line);color:inherit;align-items:flex-start" href=${'#' + lessonUrl(h.lessonId, { cue: h.i })}>
        <span class="mono muted tiny" style="min-width:48px;padding-top:3px">${fmtTime(h.start)}</span>
        <div class="grow"><div class="tiny muted">${getCourse(h.courseId)?.name} › ${getLesson(h.lessonId)?.title}</div><div><${Hl} parts=${highlightParts(h.text, q)} /></div>${h.tr?.zh ? html`<div class="small muted">${h.tr.zh}</div>` : ''}</div>
      </a>`)}
    </div>` : courses.length ? terms.map((t) => html`<div class="sect" key=${t}><h2>${t}</h2><div class="grid">
      ${courses.filter((c) => (c.term || '未分学期') === t).map((c) => {
        const ls = lessons.filter((l) => l.courseId === c.id);
        const n = clips.filter((x) => ls.some((l) => l.id === x.lessonId) && x.kind === 'stuck').length;
        return html`<a key=${c.id} class="card" href=${'#/course/' + c.id} style=${`color:inherit;border-top:4px solid ${c.color}`}>
          <div class="row"><h3 class="grow">${c.name}</h3>${c.sample ? html`<span class="badge">示例</span>` : ''}</div>
          <div class="small muted" style="margin-top:6px">${ls.length} 课时 · ${LANGS[c.srcLang] || ''}</div>
          <div class="row" style="margin-top:8px"><span class="badge stuck">${n} 卡点</span>${ls.some((l) => l.hasAudio) ? html`<span class="badge ok">🔊 有录音</span>` : ''}</div>
        </a>`;
      })}</div></div>`) : html`<${Empty} icon="📚" title="还没有课程">点右上角“导入”或去“上课”开始第一堂课。<//>`}
    ${adding && html`<${NewCourse} onClose=${() => setAdding(false)} />`}
  </div>`;
}

export function NewCourse({ onClose, onCreated }) {
  const defaults = useStore((s) => s.settings);
  const [name, setName] = useState('');
  const [term, setTerm] = useState('2026 秋季');
  const [lang, setLang] = useState(defaults.srcLang);
  async function go() {
    if (!name.trim()) return;
    const c = await actions.createCourse({ name, term, srcLang: lang });
    onClose();
    if (onCreated) onCreated(c); else navigate('/course/' + c.id);
  }
  return html`<${Modal} title="新建课程" onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${!name.trim()} onClick=${go}>创建</button>`}>
    <div class="field"><label>课程名</label><input autofocus value=${name} onInput=${(e) => setName(e.target.value)} placeholder="例如 MLAI / Bioinformatics & Omics" onKeyDown=${(e) => e.key === 'Enter' && go()} /></div>
    <div class="row" style="gap:12px"><div class="field grow"><label>学期</label><input value=${term} onInput=${(e) => setTerm(e.target.value)} /></div>
      <div class="field"><label>主要授课语言</label><select value=${lang} onChange=${(e) => setLang(e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div></div>
  <//>`;
}
