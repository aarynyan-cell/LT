import { html, useState } from '../h.js';
import { useStore, actions, navigate, lessonUrl, toast } from '../store.js';
import { fmtDuration } from '../lib/util.js';
import { Tabs, Empty, LANGS } from '../components/ui.js';
import { CourseEditDialog, LessonEditDialog, MoveLessonsDialog } from '../components/dialogs.js';

const TL = { real: ['真实', 'ok'], estimated: ['估算 ⚠', 'warn'], calibrated: ['已校准', 'acc'] };

export function Course({ route }) {
  const course = useStore((s) => s.courses.find((c) => c.id === route.params.id));
  const allLessons = useStore((s) => s.lessons);
  const clips = useStore((s) => s.clips);
  const [tab, setTab] = useState('lessons');
  const [editCourse, setEditCourse] = useState(false);
  const [editLesson, setEditLesson] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [moving, setMoving] = useState(false);
  if (!course) return html`<div class="page"><${Empty} icon="🤷" title="找不到这门课程"><a href="#/library">回课程库</a><//></div>`;
  const lessons = allLessons.filter((l) => l.courseId === course.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return html`<div class="page">
    <div class="crumbs"><a href="#/library">课程库</a><span>›</span><span>${course.name}</span></div>
    <div class="page-head" style="margin-top:8px">
      <div class="grow"><h1 style=${`border-left:6px solid ${course.color};padding-left:10px`}>${course.name}</h1>
        <div class="muted small" style="margin-top:4px">${course.term || '未分学期'} · ${LANGS[course.srcLang]} · ${lessons.length} 课时</div></div>
      <button class="btn" onClick=${() => navigate('/live?course=' + course.id)}>🎙 开始上课</button>
      <button class="btn primary" onClick=${() => actions.setUi({ importOpen: true, importCourse: course.id })}>📥 导入课时</button>
      <button class="btn" onClick=${() => setEditCourse(true)}>✎ 编辑课程</button>
      <button class="btn danger ghost" onClick=${() => confirm(`删除课程“${course.name}”及其所有课时、录音和卡点？此操作不可撤销。`) && actions.deleteCourse(course.id).then(() => navigate('/library'))}>删除</button>
    </div>
    <${Tabs} value=${tab} onChange=${setTab} options=${[['lessons', '课时'], ['glossary', '术语表']]} />
    ${editCourse ? html`<${CourseEditDialog} course=${course} onClose=${() => setEditCourse(false)} />` : ''}
    ${editLesson ? html`<${LessonEditDialog} lesson=${editLesson} onClose=${() => setEditLesson(null)} onMoved=${() => setPicked(new Set())} />` : ''}
    ${moving ? html`<${MoveLessonsDialog} ids=${[...picked]} onClose=${() => setMoving(false)} onDone=${() => setPicked(new Set())} />` : ''}
    ${tab === 'lessons' && picked.size ? html`<div class="banner" style="border-radius:10px;margin-bottom:10px">已选 ${picked.size} 个课时
      <button class="btn sm primary" onClick=${() => setMoving(true)}>移动到其他课程…</button><button class="btn sm ghost" onClick=${() => setPicked(new Set())}>取消选择</button></div>` : ''}
    ${tab === 'lessons' ? (lessons.length ? html`<div class="card flat" style="padding:0;overflow:auto"><table class="table">
      <thead><tr><th style="width:28px"><input type="checkbox" aria-label="全选" checked=${lessons.length > 0 && picked.size === lessons.length} onChange=${(e) => setPicked(e.target.checked ? new Set(lessons.map((l) => l.id)) : new Set())} /></th><th>日期</th><th>课时</th><th>时长</th><th>时间轴</th><th>卡点</th><th>笔记</th><th>词汇</th><th></th></tr></thead>
      <tbody>${lessons.map((l) => {
        const n = clips.filter((c) => c.lessonId === l.id && c.kind === 'stuck').length;
        const [tl, tone] = TL[l.timeline] || TL.estimated;
        return html`<tr key=${l.id}>
          <td><input type="checkbox" aria-label=${'选择 ' + l.title} checked=${picked.has(l.id)} onChange=${(e) => { const n = new Set(picked); e.target.checked ? n.add(l.id) : n.delete(l.id); setPicked(n); }} /></td>
          <td class="mono small">${l.date || ''}</td>
          <td><a href=${'#' + lessonUrl(l.id)}><b>${l.title}</b></a> ${l.hasAudio ? '🔊' : ''}${l.sample ? html` <span class="badge">示例</span>` : ''}</td>
          <td class="small">${fmtDuration(l.duration)}</td>
          <td><span class=${'badge ' + tone}>${tl}</span></td>
          <td><span class="badge stuck">${n}</span></td>
          <td>${l.notes ? (l.notes.source === 'claude' ? '✓ AI' : '✓ 离线') : '—'}</td>
          <td>${l.language ? '✓' : '—'}</td>
          <td style="white-space:nowrap"><button class="btn sm ghost" aria-label="编辑课时" title="改标题 / 日期，或移动到其他课程" onClick=${() => setEditLesson(l)}>✎</button><button class="btn sm danger ghost" aria-label="删除课时" onClick=${() => confirm(`删除课时“${l.title}”（含录音与卡点）？`) && actions.deleteLesson(l.id)}>🗑</button></td>
        </tr>`;
      })}</tbody></table></div>` : html`<${Empty} icon="🗂" title="这门课还没有课时">导入转录或开始上课，课时会出现在这里。<//>`) : html`<${Glossary} course=${course} lessons=${lessons} />`}
  </div>`;
}

function Glossary({ course, lessons }) {
  const [rows, setRows] = useState(course.glossary || []);
  const save = (next) => { setRows(next); actions.updateCourse(course.id, { glossary: next }); };
  const set = (i, patch) => save(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  async function rescan() {
    let n = 0;
    for (const l of lessons) n += await actions.rescanCorrections(l.id);
    toast(n ? `发现 ${n} 条新的纠错建议，请到各课时确认` : '没有发现新的纠错建议');
  }
  return html`<div>
    <p class="small muted">术语表同时服务三件事：<b>离线纠错</b>（“常被听成”→ 正确术语）、<b>AI 上下文</b>（让 Claude 用对术语）、<b>词汇优先</b>。“常被听成”用英文逗号分隔。</p>
    <div class="card flat" style="padding:0;overflow:auto"><table class="table">
      <thead><tr><th>正确术语</th><th>常被听成（逗号分隔）</th><th>备注</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => html`<tr key=${i}>
        <td><input value=${r.term} onChange=${(e) => set(i, { term: e.target.value })} style="width:100%" /></td>
        <td><input value=${(r.heardAs || []).join(', ')} onChange=${(e) => set(i, { heardAs: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} style="width:100%" placeholder="dog product, dog products" /></td>
        <td><input value=${r.note || ''} onChange=${(e) => set(i, { note: e.target.value })} style="width:100%" /></td>
        <td><button class="btn sm danger ghost" aria-label="删除" onClick=${() => save(rows.filter((_, k) => k !== i))}>✕</button></td></tr>`)}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button class="btn" onClick=${() => save([...rows, { term: '', heardAs: [], note: '' }])}>＋ 添加术语</button>
      <button class="btn" onClick=${rescan}>用最新术语表重新扫描本课程纠错</button></div>
  </div>`;
}
