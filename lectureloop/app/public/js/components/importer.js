// 导入对话框：转录文件(+可选录音) → 解析预览 → 新建课时
import { html, useState, useRef } from '../h.js';
import { actions, navigate, lessonUrl, useStore, toast } from '../store.js';
import { readTranscript, buildDraft, guessLang, readAudioDuration } from '../lib/importers.js';
import { fmtTime } from '../lib/util.js';
import { Modal, LANGS } from './ui.js';

export function Importer() {
  const ui = useStore((s) => s.ui);
  const courses = useStore((s) => s.courses);
  const settings = useStore((s) => s.settings);
  const [src, setSrc] = useState(null);       // { name, ...readTranscript }
  const [audio, setAudio] = useState(null);   // { file, duration }
  const [draft, setDraft] = useState(null);
  const [course, setCourse] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [lang, setLang] = useState(settings.srcLang);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef(), audioRef = useRef();

  const close = () => actions.setUi({ importOpen: false, importCourse: null });

  async function build(s, a, l) {
    const d = buildDraft(s, { lang: l, audioDuration: a?.duration || 0 });
    setDraft(d);
    return d;
  }

  async function onFile(file) {
    if (!file) return;
    setErr(''); setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const r = await readTranscript(file.name, buf);
      const s = { ...r, name: file.name };
      if (!r.timed && !r.paragraphs.length) throw new Error('没有读到文字内容');
      const sample = r.timed ? r.timed.map((c) => c.text).join(' ') : r.paragraphs.slice(0, 40).join(' ');
      const l = guessLang(sample);
      setLang(l); setSrc(s);
      const d = await build(s, audio, l);
      const preset = ui.importCourse && courses.find((c) => c.id === ui.importCourse);
      setCourse(preset?.name || d.course || ''); setTitle(d.title); setDate(d.date || new Date().toISOString().slice(0, 10));
    } catch (e) {
      setErr(`无法解析该文件：${e.message}。docx 需要较新的浏览器；也可以另存为 .txt 再导入。`);
      setSrc(null); setDraft(null);
    } finally { setBusy(false); }
  }

  async function onAudio(file) {
    if (!file) return;
    const duration = await readAudioDuration(file);
    const a = { file, duration };
    setAudio(a);
    if (src) await build(src, a, lang);
  }

  async function submit() {
    if (!draft) return;
    setBusy(true);
    try {
      const c = await actions.findOrCreateCourse(course || '未分类', lang);
      const lesson = await actions.importLesson({ draft: { ...draft, srcLang: lang }, courseId: c.id, title, date, audio: audio?.file, sourceName: src.name });
      toast(`已导入：${draft.cues.length} 句，${draft.parts.length} 个片段`);
      close();
      navigate(lessonUrl(lesson.id));
    } catch (e) {
      setErr('导入失败：' + e.message);
    } finally { setBusy(false); }
  }

  return html`<${Modal} title="导入转录" onClose=${close} wide
    foot=${html`<button class="btn" onClick=${close}>取消</button><button class="btn primary" disabled=${!draft || busy} onClick=${submit}>${busy ? '处理中…' : '导入'}</button>`}>
    <div class=${'drop ' + (over ? 'over' : '')}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
      <div>${src ? html`<b>${src.name}</b>` : '把转录文件拖到这里，或'} <button class="btn sm" onClick=${() => fileRef.current.click()}>选择文件</button></div>
      <div class="tiny" style="margin-top:4px">支持 .docx（如 macOS 语音备忘录导出）、.txt、.md、.srt、.vtt。文件只在本机浏览器内处理。</div>
      <input ref=${fileRef} type="file" accept=".docx,.txt,.md,.srt,.vtt,text/plain" class="hide" onChange=${(e) => onFile(e.target.files[0])} />
    </div>
    <div class="row small" style="margin:10px 0 14px">
      <span>录音（可选，用于精听）：</span>
      <button class="btn sm" onClick=${() => audioRef.current.click()}>${audio ? '更换' : '选择录音'}</button>
      ${audio && html`<span class="muted">${audio.file.name} · ${fmtTime(audio.duration)}</span>`}
      <input ref=${audioRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" class="hide" onChange=${(e) => onAudio(e.target.files[0])} />
    </div>
    ${err && html`<div class="banner warn" style="border-radius:8px;margin-bottom:10px">${err}</div>`}
    ${busy && !draft && html`<div class="row muted"><span class="spin"></span> 正在解析…</div>`}
    ${draft && html`<div>
      <div class="row wrap" style="gap:12px">
        <div class="field grow"><label>课程</label><input list="course-list" value=${course} onInput=${(e) => setCourse(e.target.value)} placeholder="课程名（不存在则新建）" /><datalist id="course-list">${courses.map((c) => html`<option value=${c.name} />`)}</datalist></div>
        <div class="field grow"><label>课时标题</label><input value=${title} onInput=${(e) => setTitle(e.target.value)} /></div>
      </div>
      <div class="row wrap" style="gap:12px">
        <div class="field"><label>日期</label><input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} /></div>
        <div class="field"><label>讲课语言</label><select value=${lang} onChange=${(e) => setLang(e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <div class="field grow"><label>识别结果</label><div class="small" style="padding-top:6px"><b>${draft.cues.length}</b> 句 · <b>${draft.parts.length}</b> 个片段 · <b>${draft.stats.words}</b> 词 · ${draft.timeline === 'real' ? '含时间戳' : `估算时长 ${draft.stats.minutes} 分钟`}</div></div>
      </div>
      ${draft.timeline === 'estimated' && html`<div class="banner warn" style="border-radius:8px;margin-bottom:10px">⚠ 未检测到时间戳：将按语速估算时间轴${audio ? '（已按录音时长缩放）' : ''}。${audio ? '' : '绑定录音后'}可在课时页用“锚点”校准。</div>`}
      <div class="small muted" style="margin-bottom:4px">预览（前 12 句）</div>
      <div style="max-height:190px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px">
        ${draft.cues.slice(0, 12).map((c) => html`<div class="small" style="padding:2px 0"><span class="mono muted">${fmtTime(c.start)}</span> ${c.text}</div>`)}
      </div>
    </div>`}
  <//>`;
}
