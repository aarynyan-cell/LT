// Studio：转录 + 笔记/语言/片段 + 播放器 + 时间轴。一节课的"精听工作台"。
import { html, useState, useEffect, useMemo, useRef } from '../h.js';
import { useStore, actions, getCues, toast, navigate, ttsPrefsFor } from '../store.js';
import { Player } from '../lib/player.js';
import { readAudioDuration } from '../lib/importers.js';
import { fmtDuration, fmtTime } from '../lib/util.js';
import { Transcript } from '../components/transcript.js';
import { Timeline } from '../components/timeline.js';
import { PlayerBar } from '../components/playerbar.js';
import { Modal, Tabs, Empty, TagChip, useHotkeys } from '../components/ui.js';
import { NotesPanel } from './notes.js';
import { LanguagePanel } from './language.js';
import { ClipsPanel } from './clips.js';

const TL = { real: ['真实时间轴', 'ok'], estimated: ['⚠ 估算时间轴', 'warn'], calibrated: ['已校准', 'acc'] };

export function Lesson({ route }) {
  const id = route.params.id;
  const lesson = useStore((s) => s.lessons.find((l) => l.id === id));
  const course = useStore((s) => s.courses.find((c) => c.id === lesson?.courseId));
  const allClips = useStore((s) => s.clips);
  const tags = useStore((s) => s.tags);
  const settings = useStore((s) => s.settings);
  const rev = useStore((s) => s.cuesRev[id] || 0);
  const busyNotes = useStore((s) => !!s.busy['notes:' + id]);
  const busyLang = useStore((s) => !!s.busy['lang:' + id]);

  const player = useMemo(() => new Player(), [id]);
  const [cues, setCues] = useState(null);
  const [tab, setTab] = useState('notes');
  const [clipDlg, setClipDlg] = useState(null);
  const [calib, setCalib] = useState(false);
  const focusCue = route.query.cue != null ? +route.query.cue : undefined;
  const audioInput = useRef();
  const keyRef = useRef();
  useHotkeys((e) => keyRef.current?.(e)); // 必须在任何提前 return 之前调用（Hooks 顺序）

  // 载入转录 + 录音，初始化播放器
  useEffect(() => {
    if (!lesson) return;
    let dead = false;
    (async () => {
      const cs = await getCues(id);
      const audio = lesson.hasAudio ? await actions.getAudio(id) : null;
      if (dead) return;
      await player.load({ cues: cs, duration: lesson.duration, blob: audio?.blob || null, lang: lesson.srcLang, tts: ttsPrefsFor(lesson.srcLang) });
      if (dead) { player.dispose(); return; }
      setCues(cs);
      if (focusCue != null) player.seekCue(focusCue);
      else if (route.query.t) player.seek(+route.query.t);
    })();
    return () => { dead = true; player.dispose(); };
  }, [id, lesson?.hasAudio]);

  // 转录被改写（纠错 / 编辑 / 校准）后刷新
  useEffect(() => {
    if (!cues || !lesson) return;
    getCues(id).then((cs) => { if (cs !== cues) { setCues(cs); player.updateCues(cs, lesson.duration); } });
  }, [rev]);

  // 同一课时内通过搜索/笔记跳到 ?cue=N 时（视图不重建），定位播放位置
  useEffect(() => { if (cues && focusCue != null) player.seekCue(focusCue); }, [focusCue]);

  const clips = useMemo(() => allClips.filter((c) => c.lessonId === id), [allClips, id]);
  const stuckSet = useMemo(() => {
    const s = new Set();
    for (const c of clips) if (c.kind === 'stuck') for (let i = c.startCue; i <= c.endCue; i++) s.add(i);
    return s;
  }, [clips]);

  if (!lesson) return html`<div class="page"><${Empty} icon="🤷" title="找不到这个课时"><a href="#/library">回课程库</a><//></div>`;
  if (!cues) return html`<div class="page"><div class="row muted"><span class="spin"></span> 正在载入转录与录音…</div></div>`;

  // ----- 标记 -----
  const markCue = async (i) => {
    const cover = clips.find((c) => c.kind === 'stuck' && c.startCue <= i && c.endCue >= i);
    if (cover) { await actions.deleteClip(cover.id); toast('已取消卡点'); return; }
    const clip = await actions.addClip({ lessonId: id, kind: 'stuck', startCue: i, endCue: i, source: 'studio' });
    toast(`✓ 已标记 ${fmtTime(cues[i].start)}`, { undo: () => actions.deleteClip(clip.id) });
  };
  const onSelect = async (s) => {
    if (!s?.act) return;
    if (s.act === 'stuck') {
      const clip = await actions.addClip({ lessonId: id, kind: 'stuck', startCue: s.startCue, endCue: s.endCue, source: 'timeline' });
      toast(`✓ 已标记 ${fmtTime(s.a)}–${fmtTime(s.b)}`, { undo: () => actions.deleteClip(clip.id) });
    } else setClipDlg(s);
  };
  const anchorCue = async (i) => {
    if (!lesson.hasAudio) { toast('锚点用于对齐录音：请先在“时间轴”里绑定录音', { kind: 'warn' }); setCalib(true); return; }
    await actions.addAnchor(id, i, player.time);
    toast(`⚓ 已把当前播放位置设为第 ${i + 1} 句的起点`);
  };

  const on = {
    play: (i) => player.seekCue(i, true),
    seek: (i) => player.seekCue(i, !!player.engine?.playing),
    loop: (i) => (player.isLoopingCue(i) ? player.clearLoop() : player.loopCue(i)),
    mark: markCue,
    anchor: anchorCue,
    editCue: (i, text) => actions.editCue(id, i, text),
  };

  keyRef.current = (e) => {
    const k = e.key;
    if (k === ' ') { e.preventDefault(); player.toggle(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); player.prevCue(); }
    else if (k === 'ArrowRight') { e.preventDefault(); player.nextCue(); }
    else if (k === 'r' || k === 'R') player.loopCue(Math.max(0, player.curCue));
    else if (k === 'l' || k === 'L') on.loop(Math.max(0, player.curCue));
    else if (k === '[') player.stepRate(-1);
    else if (k === ']') player.stepRate(1);
    else if (k === 'm' || k === 'M') markCue(Math.max(0, player.curCue));
    else if (k === 'a' || k === 'A') window.__loopA = player.time;
    else if (k === 'b' || k === 'B') { if (window.__loopA != null && player.time > window.__loopA) { player.setLoop(window.__loopA, player.time); window.__loopA = null; } }
    else if (k === 'h' || k === 'H') actions.setSetting('blind', !settings.blind);
    else if (k === 'Escape') { player.clearLoop(); window.__loopA = null; }
  };

  const [tlLabel, tlTone] = TL[lesson.timeline] || TL.estimated;
  const pending = (lesson.corrections || []).filter((c) => c.state === 'pending').length;
  const needNotes = !lesson.notes || lesson.notes.source === 'none';
  const showBanner = pending > 0 || needNotes || !lesson.language;

  async function attach(file) {
    if (!file) return;
    const d = await readAudioDuration(file);
    await actions.attachAudio(id, file, d);
    toast(`已绑定录音（${fmtTime(d)}）。接下来用 ⚓ 校准几处位置。`);
  }

  return html`<div class="studio">
    <div class="studio-head">
      <div class="crumbs"><a href="#/library">课程库</a><span>›</span><a href=${'#/course/' + lesson.courseId}>${course?.name}</a><span>›</span><span>${lesson.title}</span></div>
      <div class="row wrap" style="margin-top:4px">
        <h1 style="font-size:19px" title="双击重命名" onDblClick=${() => { const t = prompt('课时标题', lesson.title); if (t) actions.updateLesson(id, { title: t }); }}>${lesson.title}</h1>
        <span class="muted small">${lesson.date || ''} · ${fmtDuration(lesson.duration)} · ${cues.length} 句</span>
        <button class=${'badge ' + tlTone} style="border:0;cursor:pointer" onClick=${() => setCalib(true)} title="点击了解如何校准">${tlLabel}${lesson.anchors?.length ? ` · ${lesson.anchors.length} 锚点` : ''}</button>
        <span class=${'badge ' + (lesson.hasAudio ? 'ok' : '')}>${lesson.hasAudio ? '🔊 有录音' : '无录音'}</span>
        ${lesson.sample ? html`<span class="badge">示例</span>` : ''}
        <button class="btn sm right" onClick=${() => navigate('/drill')}>🎧 去训练</button>
      </div>
    </div>
    ${showBanner && html`<div class="banner">
      <b>🧹 课后整理</b>
      ${pending > 0 && html`<button class="btn sm" onClick=${() => setTab('language')}>① 术语纠错 ${pending} 项待确认</button>`}
      ${needNotes && html`<button class="btn sm" disabled=${busyNotes} onClick=${() => { setTab('notes'); actions.runNotes(id); }}>${busyNotes ? '生成中…' : '② 生成笔记'}</button>`}
      ${!lesson.language && html`<button class="btn sm" disabled=${busyLang} onClick=${() => { setTab('language'); actions.runLanguage(id); }}>${busyLang ? '提取中…' : '③ 提取词汇与句式'}</button>`}
    </div>`}
    <div class="studio-main">
      <${Transcript} lesson=${lesson} cues=${cues} player=${player} stuckSet=${stuckSet} settings=${settings} focusCue=${focusCue} on=${on} />
      <div class="pane">
        <${Tabs} value=${tab} onChange=${setTab} options=${[['notes', '笔记'], ['language', `语言${pending ? ' ·' + pending : ''}`], ['clips', `片段 ${clips.length}`]]} />
        ${tab === 'notes' ? html`<${NotesPanel} lesson=${lesson} cues=${cues} player=${player} busy=${busyNotes} />`
          : tab === 'language' ? html`<${LanguagePanel} lesson=${lesson} cues=${cues} player=${player} busy=${busyLang} settings=${settings} />`
          : html`<${ClipsPanel} lesson=${lesson} cues=${cues} clips=${allClips} tags=${tags} player=${player} />`}
      </div>
    </div>
    <${PlayerBar} player=${player}>
      <${Timeline} player=${player} cues=${cues} parts=${lesson.parts} duration=${Math.max(1, player.duration || lesson.duration)} clips=${clips} tags=${tags} anchors=${lesson.anchors} onSelect=${onSelect} showDensity=${lesson.timeline !== 'estimated'} />
    <//>

    ${clipDlg && html`<${ClipDialog} sel=${clipDlg} cues=${cues} tags=${tags} onClose=${() => setClipDlg(null)} lessonId=${id} />`}
    ${calib && html`<${Modal} title="时间轴与校准" onClose=${() => setCalib(false)} foot=${html`<button class="btn primary" onClick=${() => setCalib(false)}>好的</button>`}>
      <p>当前：<span class=${'badge ' + tlTone}>${tlLabel}</span></p>
      ${lesson.timeline === 'real'
        ? html`<p class="small">这份转录的时间来自实时录制或字幕文件，无需校准。</p>`
        : html`<p class="small">这份转录<b>没有时间戳</b>（例如语音备忘录的导出文件），时间轴是按语速<b>估算</b>的。要精准精听，请：</p>
          <ol class="small"><li>绑定这节课的<b>录音文件</b>（下方按钮）；</li><li>播放到讲者说出某一句时，在转录里悬停该句，点 <b>⚓ 设为锚点</b>（把“当前播放位置”设为这句的起点）；</li><li>建议每 10–15 分钟加一个锚点，锚点之间自动按词数插值；</li><li>顶部徽标会变为“已校准”。</li></ol>`}
      <div class="row wrap">
        <button class="btn" onClick=${() => audioInput.current.click()}>${lesson.hasAudio ? '更换录音' : '绑定录音…'}</button>
        <input ref=${audioInput} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" class="hide" onChange=${(e) => attach(e.target.files[0])} />
        ${lesson.anchors?.length ? html`<button class="btn danger" onClick=${() => actions.clearAnchors(id)}>清除全部 ${lesson.anchors.length} 个锚点</button>` : ''}
      </div>
      ${!lesson.hasAudio ? html`<p class="tiny muted" style="margin-top:10px">没有录音也能用：播放会改用浏览器“朗读”或“静音计时器”，用于对照阅读和演示循环，但不是真实课堂声音。</p>` : ''}
    <//>`}
  </div>`;
}

function ClipDialog({ sel, cues, tags, lessonId, onClose }) {
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const [practice, setPractice] = useState(false);
  async function save() {
    await actions.addClip({ lessonId, kind: 'clip', startCue: sel.startCue, endCue: sel.endCue, tags: picked, note, practice, source: 'timeline' });
    toast('片段已保存');
    onClose();
  }
  return html`<${Modal} title="存为片段" onClose=${onClose} foot=${html`<button class="btn" onClick=${onClose}>取消</button><button class="btn primary" onClick=${save}>保存</button>`}>
    <p class="small muted">${fmtTime(sel.a)}–${fmtTime(sel.b)} · “${cues.slice(sel.startCue, sel.endCue + 1).map((c) => c.text).join(' ').slice(0, 140)}”</p>
    <div class="field"><label>标签</label><div class="row wrap">${tags.map((t) => html`<${TagChip} key=${t.id} tag=${t} on=${picked.includes(t.id)} onClick=${() => setPicked(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : [...picked, t.id])} />`)}</div></div>
    <div class="field"><label>备注</label><input value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="例如：老师强调的定义" /></div>
    <label class="row small"><input type="checkbox" checked=${practice} onChange=${(e) => setPractice(e.target.checked)} /> 同时加入精听训练队列</label>
  <//>`;
}
