// 课程库编辑对话框：课程（名称/学期/语言/颜色）、课时（标题/日期/移动到其他课程）、批量移动。
import { html, useState } from '../h.js';
import { useStore, actions, toast } from '../store.js';
import { TAG_COLORS } from '../lib/seed.js';
import { Modal, LANGS } from './ui.js';

const NEW = '__new';

/** 课程：改名、改学期（课程会在课程库里移到对应学期分组）、授课语言、颜色 */
export function CourseEditDialog({ course, onClose }) {
  const [name, setName] = useState(course.name);
  const [term, setTerm] = useState(course.term || '');
  const [lang, setLang] = useState(course.srcLang);
  const [color, setColor] = useState(course.color);
  const ok = name.trim().length > 0;
  async function save() {
    if (!ok) return;
    await actions.updateCourse(course.id, { name: name.trim(), term: term.trim(), srcLang: lang, color });
    toast('课程已更新');
    onClose();
  }
  return html`<${Modal} title="编辑课程" onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${!ok} onClick=${save}>保存</button>`}>
    <div class="field"><label>课程名</label><input autofocus value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></div>
    <div class="row wrap" style="gap:12px">
      <div class="field grow"><label>学期（改它就是把课程移到另一个学期分组）</label><input value=${term} onInput=${(e) => setTerm(e.target.value)} placeholder="例如 2026 秋季" list="term-list" />
        <${TermList} /></div>
      <div class="field"><label>授课语言</label><select value=${lang} onChange=${(e) => setLang(e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
    </div>
    <div class="field"><label>颜色</label><div class="row wrap">${TAG_COLORS.map((c) => html`<button key=${c} aria-label=${'颜色 ' + c} onClick=${() => setColor(c)} style=${`width:26px;height:26px;border-radius:50%;border:3px solid ${color === c ? 'var(--ink)' : 'transparent'};background:${c};cursor:pointer`}></button>`)}</div></div>
  <//>`;
}

function TermList() {
  const courses = useStore((s) => s.courses);
  const terms = [...new Set(courses.map((c) => c.term).filter(Boolean))];
  return html`<datalist id="term-list">${terms.map((t) => html`<option value=${t} />`)}</datalist>`;
}

/** 目标课程选择：已有课程 + “新建课程…”。返回 { courseId, ok, ui } */
function useCoursePicker(initial) {
  const courses = useStore((s) => s.courses);
  const [sel, setSel] = useState(initial || courses[0]?.id || NEW);
  const [newName, setNewName] = useState('');
  const ok = sel !== NEW || newName.trim().length > 0;
  const ui = html`<div class="field"><label>课程</label>
    <select value=${sel} onChange=${(e) => setSel(e.target.value)}>${courses.map((c) => html`<option value=${c.id}>${c.name}${c.term ? `（${c.term}）` : ''}</option>`)}<option value=${NEW}>＋ 新建课程…</option></select>
    ${sel === NEW ? html`<input style="margin-top:6px" placeholder="新课程名" value=${newName} onInput=${(e) => setNewName(e.target.value)} />` : ''}</div>`;
  const resolve = async (srcLang) => (sel === NEW ? (await actions.createCourse({ name: newName, srcLang })).id : sel);
  return { sel, ok, ui, resolve };
}

/** 课时：改标题、日期，并可移动到其他课程 */
export function LessonEditDialog({ lesson, onClose, onMoved }) {
  const [title, setTitle] = useState(lesson.title);
  const [date, setDate] = useState(lesson.date || '');
  const picker = useCoursePicker(lesson.courseId);
  const ok = title.trim().length > 0 && picker.ok;
  async function save() {
    if (!ok) return;
    const courseId = await picker.resolve(lesson.srcLang);
    await actions.updateLesson(lesson.id, { title: title.trim(), date, courseId });
    toast(courseId !== lesson.courseId ? '课时已更新并移动' : '课时已更新');
    onClose();
    if (courseId !== lesson.courseId) onMoved?.(courseId);
  }
  return html`<${Modal} title="编辑课时" onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${!ok} onClick=${save}>保存</button>`}>
    <div class="field"><label>标题</label><input autofocus value=${title} onInput=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></div>
    <div class="field"><label>日期</label><input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} /></div>
    ${picker.ui}
    <p class="tiny muted">移动课时时，它的转录、录音、笔记、卡点和词汇都会一起带走。</p>
  <//>`;
}

/** 批量移动所选课时到另一门课程 */
export function MoveLessonsDialog({ ids, onClose, onDone }) {
  const lessons = useStore((s) => s.lessons);
  const first = lessons.find((l) => l.id === ids[0]);
  const picker = useCoursePicker(null);
  async function go() {
    if (!picker.ok) return;
    const courseId = await picker.resolve(first?.srcLang || 'en');
    await actions.moveLessons(ids, courseId);
    toast(`已移动 ${ids.length} 个课时`);
    onClose();
    onDone?.(courseId);
  }
  return html`<${Modal} title=${`移动 ${ids.length} 个课时到…`} onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${!picker.ok} onClick=${go}>移动</button>`}>
    ${picker.ui}
  <//>`;
}

/** 片段：重命名 */
export function PartRenameDialog({ part, onSave, onClose }) {
  const [title, setTitle] = useState(part.title);
  const ok = title.trim().length > 0;
  const save = () => { if (!ok) return; onSave(title.trim()); onClose(); };
  return html`<${Modal} title="重命名片段" onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" disabled=${!ok} onClick=${save}>保存</button>`}>
    <div class="field"><label>片段标题</label><input autofocus value=${title} onInput=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></div>
  <//>`;
}
