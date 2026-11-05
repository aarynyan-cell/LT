// 卡点训练：① 盲听（循环 + 降速）→ ② 听写（可选，词级对比）→ ③ 揭示（原文/译文/陷阱/前后文）→ ④ 自评（间隔重复）
import { html, useState, useEffect, useMemo, useRef } from '../h.js';
import { useStore, actions, getCues, clipTimes, dueClips, lessonUrl, getLesson, getCourse, toast } from '../store.js';
import { Player } from '../lib/player.js';
import { wordDiff } from '../lib/diff.js';
import { INTERVALS, MAX_BOX, nextBox } from '../lib/srs.js';
import { phraseRegex } from '../lib/glossary.js';
import { fmtTime } from '../lib/util.js';
import { REASONS, Empty, useHotkeys } from '../components/ui.js';
import { STOP } from '../lib/heuristics.js';

const LADDER = [1, 0.9, 0.75, 0.6, 0.5];
const days = (n) => (n <= 0 ? '今天' : n === 1 ? '明天' : `${n} 天后`);

export function Drill({ route }) {
  const clips = useStore((s) => s.clips);
  const lessons = useStore((s) => s.lessons);
  const player = useMemo(() => new Player(), []);
  const valid = (c) => c && lessons.some((l) => l.id === c.lessonId);
  // 进入页面时对队列做快照：练习过程中不因重新排序而跳卡
  const [queue, setQueue] = useState(() => (route.params.id ? [route.params.id] : dueClips(clips).filter(valid).map((c) => c.id)));
  const [pos, setPos] = useState(0);
  const [stats, setStats] = useState({ again: 0, hard: 0, good: 0 });
  useEffect(() => () => player.dispose(), []);

  const clip = clips.find((c) => c.id === queue[pos]);
  const finished = pos >= queue.length;

  const practiceAll = () => {
    const open = clips.filter((c) => valid(c) && (c.kind === 'stuck' || c.practice) && c.status !== 'mastered').sort((a, b) => a.srs.due - b.srs.due).map((c) => c.id);
    setQueue(open); setPos(0);
  };

  if (finished || !clip) {
    const upcoming = clips.filter((c) => valid(c) && (c.kind === 'stuck' || c.practice) && c.status !== 'mastered' && c.srs.due > Date.now()).sort((a, b) => a.srs.due - b.srs.due);
    const nextDue = upcoming[0]?.srs.due;
    const n = stats.again + stats.hard + stats.good;
    return html`<div class="page"><div class="page-head"><h1>卡点训练</h1></div>
      <div class="card drill-card">
        <${Empty} icon="🎉" title=${n ? `完成 ${n} 张！` : '今天的卡点清空了'}>
          ${n ? html`<div>听懂 ${stats.good} · 勉强 ${stats.hard} · 没懂 ${stats.again}</div>` : ''}
          <div style="margin-top:6px">${nextDue ? `下一次到期：${new Date(nextDue).toLocaleDateString()}（共 ${upcoming.length} 张未掌握）` : '没有待复习的卡点。去课程里标记听不懂的片段吧。'}</div>
        <//>
        <div class="row" style="justify-content:center;gap:10px">
          ${upcoming.length ? html`<button class="btn" onClick=${practiceAll}>再练一轮（未到期的也练）</button>` : ''}
          <a class="btn primary" href="#/library">去课程库</a>
        </div>
      </div></div>`;
  }

  const onDone = (rating) => { setStats((s) => ({ ...s, [rating]: s[rating] + 1 })); setPos((p) => p + 1); };
  return html`<div class="page">
    <div class="page-head"><h1 class="grow">卡点训练</h1><span class="muted">${pos + 1} / ${queue.length}</span>
      <button class="btn sm ghost" onClick=${() => setPos((p) => p + 1)}>跳过</button></div>
    <div class="bar" style="margin:-8px 0 16px"><i style=${`width:${(pos / queue.length) * 100}%`}></i></div>
    <${Card} key=${clip.id} clip=${clip} player=${player} onDone=${onDone} />
  </div>`;
}

function Card({ clip, player, onDone }) {
  const lesson = getLesson(clip.lessonId);
  const course = getCourse(lesson?.courseId);
  const settings = useStore((s) => s.settings);
  const [cues, setCues] = useState(null);
  const [step, setStep] = useState(0); // 0 盲听 · 1 听写 · 2 揭示+自评
  const [speed, setSpeed] = useState(1);
  const [minSpeed, setMinSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [text, setText] = useState('');
  const [diff, setDiff] = useState(null);
  const [added, setAdded] = useState([]);
  const span = useRef({ start: 0, end: 0 });

  useEffect(() => player.on('state', (s) => setPlaying(s.playing)), [player]);
  useEffect(() => {
    let dead = false;
    (async () => {
      const cs = await getCues(lesson.id);
      if (player.__lessonId !== lesson.id) {
        const audio = lesson.hasAudio ? await actions.getAudio(lesson.id) : null;
        await player.load({ cues: cs, duration: lesson.duration, blob: audio?.blob || null, lang: lesson.srcLang });
        player.__lessonId = lesson.id;
      } else player.updateCues(cs, lesson.duration);
      if (dead) return;
      span.current = clipTimes(clip, cs);
      setCues(cs);
      player.setSentenceRepeat(1);
      player.playSpan(span.current.start, span.current.end, { rate: 1 }); // 先用正常速度盲听
    })();
    return () => { dead = true; player.pause(); };
  }, [clip.id]);

  const replay = (r = speed) => player.playSpan(span.current.start, span.current.end, { rate: r });
  const slower = () => {
    const k = Math.min(LADDER.length - 1, LADDER.indexOf(speed) + 1);
    setRate(LADDER[k]);
  };
  const setRate = (r) => { setSpeed(r); setMinSpeed((m) => Math.min(m, r)); replay(r); };
  const submit = () => { setDiff(text.trim() ? wordDiff(refText, text) : null); setStep(2); };
  const rate = async (r) => {
    player.pause();
    await actions.rateClip(clip.id, r, { score: diff ? Math.round(diff.accuracy * 100) : null, speed: minSpeed });
    onDone(r);
  };

  useHotkeys((e) => {
    if (e.key === ' ') { e.preventDefault(); playing ? player.pause() : replay(); }
    else if (e.key === 's' || e.key === 'S') slower();
    else if (e.key === 'Enter' && step === 0) setStep(2);
    else if (step === 2 && ['1', '2', '3'].includes(e.key)) rate(['again', 'hard', 'good'][+e.key - 1]);
  });

  if (!lesson) return null;
  if (!cues) return html`<div class="card drill-card"><span class="spin"></span> 载入中…</div>`;

  const range = cues.slice(clip.startCue, clip.endCue + 1);
  const refText = range.map((c) => c.text).join(' ');
  const trLang = ['zh', 'fr', 'en'].find((l) => l !== lesson.srcLang && range.some((c) => c.tr?.[l]));
  const trText = trLang ? range.map((c) => c.tr?.[trLang] || '').join(' ') : '';
  const traps = (lesson.corrections || []).filter((c) => c.state === 'applied' && phraseRegex(c.right).test(refText));
  const vocab = (lesson.language?.vocab || []).filter((v) => phraseRegex(v.term).test(refText)).slice(0, 6);
  const prev = cues[clip.startCue - 1], next = cues[clip.endCue + 1];
  const box = clip.srs?.box ?? 0;
  const engineNote = player.engine?.kind === 'audio' ? '' : player.engine?.kind === 'tts' ? '（无录音：使用浏览器朗读代替真实课堂声音）' : '（无录音且无朗读语音：静音计时）';
  const missed = diff ? [...new Set(diff.missed.filter((w) => w.length >= 4 && !STOP.has(w)))].slice(0, 8) : [];

  return html`<div class="card drill-card">
    <div class="steps">${['① 盲听', '② 听写', '③ 揭示', '④ 自评'].map((s, k) => html`<span class=${step === 2 ? (k < 3 ? 'done' : 'on') : k < step ? 'done' : k === step ? 'on' : ''}>${s}</span>`)}</div>
    <div class="row wrap small">
      <b>${course?.name}</b><span class="muted">› ${lesson.title}</span>
      ${clip.reason ? html`<span class="badge stuck">${REASONS[clip.reason]}</span>` : ''}
      <span class="badge">盒 ${box}</span>
      <a class="right small" href=${'#' + lessonUrl(lesson.id, { cue: clip.startCue })}>在 Studio 中打开 ↗</a>
    </div>

    <div class="row wrap" style="justify-content:center;margin-top:18px;gap:10px">
      <button class="btn primary lg" onClick=${() => (playing ? player.pause() : replay())}>${playing ? '⏸ 暂停' : '▶ 播放（循环）'}</button>
      <button class="btn" onClick=${() => replay()} title="从头再听（Space）">↺ 再听一遍</button>
      <button class="btn" onClick=${slower} title="下一档更慢（S）">🐢 更慢</button>
    </div>
    <div class="row wrap" style="justify-content:center;margin-top:8px">
      ${LADDER.map((r) => html`<span class=${'chip ' + (speed === r ? 'on' : '')} onClick=${() => setRate(r)}>${r}×</span>`)}
      <span class="tiny muted">先用正常速度盲听；听不清再降速，听懂后再回到 1.0×${engineNote}</span>
    </div>

    ${step === 0 ? html`<div class="blindbox">🙈 文字已隐藏 —— 先试着只用耳朵听懂这一段<div class="tiny" style="margin-top:6px">${fmtTime(span.current.start)}–${fmtTime(span.current.end)} · ${range.length} 句</div></div>
      <div class="row" style="justify-content:center;gap:10px"><button class="btn" onClick=${() => setStep(1)}>✍️ 我想听写</button><button class="btn primary" onClick=${() => setStep(2)}>👀 揭示文字 <span class="kbd" style="color:var(--ink)">Enter</span></button></div>` : ''}

    ${step === 1 ? html`<div style="margin-top:16px">
      <textarea rows="4" autofocus placeholder="把你听到的写下来（不用管大小写和标点）。音频会一直循环。Enter 提交，Shift+Enter 换行。" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}></textarea>
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn ghost" onClick=${() => setStep(2)}>跳过</button><button class="btn primary" onClick=${submit}>提交对比</button></div></div>` : ''}

    ${step === 2 ? html`<div style="margin-top:16px">
      ${diff ? html`<div class="nsec"><h3>听写对比 · 正确率 <b style=${`color:${diff.accuracy >= 0.8 ? 'var(--ok)' : diff.accuracy >= 0.5 ? 'var(--warn)' : 'var(--stuck)'}`}>${Math.round(diff.accuracy * 100)}%</b></h3>
        <div class="diff" style="line-height:2">${diff.ops.map((o) => html`<span class=${o.t} title=${o.t === 'sub' ? `你写的：${o.got}` : o.t === 'miss' ? '漏听' : o.t === 'extra' ? '多写' : ''}>${o.t === 'extra' ? o.got : o.ref}</span>`)}</div>
        ${missed.length ? html`<div class="row wrap small" style="margin-top:6px">漏听 / 听错的词：${missed.map((w) => html`<button class="btn sm" disabled=${added.includes(w)} onClick=${async () => { const ok = await actions.addVocabTerm(lesson.id, w, clip.startCue); setAdded([...added, w]); toast(ok ? `已加入词汇：${w}` : `${w} 已在词汇中`); }}>${added.includes(w) ? '✓ ' : '＋'}${w}</button>`)}</div>` : ''}
      </div>` : ''}
      <div class="nsec"><h3>原文</h3><div style="font-size:18px;line-height:1.6">${refText}</div>
        ${trText ? html`<div class="muted" style="margin-top:4px">${trText}</div>` : ''}</div>
      ${traps.length || vocab.length ? html`<div class="nsec"><h3>这一段里的听力陷阱 / 词汇</h3>
        ${traps.map((t) => html`<div class="small">⚠ <s style="color:var(--stuck)">${t.wrong}</s> → <b>${t.right}</b> <span class="muted">（ASR 也听错了：${t.reason || '近音'}）</span></div>`)}
        ${vocab.map((v) => html`<div class="small"><b>${v.term}</b> <span class="muted">${v.def?.[settings.noteLang] || v.def?.en || ''}</span></div>`)}</div>` : ''}
      ${clip.note ? html`<div class="nsec"><h3>备注</h3><div class="small">${clip.note}</div></div>` : ''}
      <div class="nsec"><h3>前后文</h3>
        ${[prev, next].filter(Boolean).map((c) => html`<div class="row small" style="padding:3px 0"><button class="play" onClick=${() => player.playSpan(c.start, c.end, { count: 1 })}>▶ ${fmtTime(c.start)}</button><span class="muted">${c.text}</span></div>`)}</div>
      ${!clip.reason && clip.kind === 'stuck' ? html`<div class="row small" style="margin-bottom:8px">卡在哪？<select onChange=${(e) => actions.updateClip(clip.id, { reason: e.target.value })}><option value="">选择原因（用于统计）</option>${Object.entries(REASONS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>` : ''}
      <div class="rate">
        <button class="btn" onClick=${() => rate('again')}><span style="font-size:22px">😵</span>还是不懂<span class="tiny muted">10 分钟后 · 1</span></button>
        <button class="btn" onClick=${() => rate('hard')}><span style="font-size:22px">😐</span>勉强<span class="tiny muted">${days(INTERVALS[Math.max(1, box)])} · 2</span></button>
        <button class="btn" onClick=${() => rate('good')}><span style="font-size:22px">🙂</span>听懂了<span class="tiny muted">${box >= MAX_BOX ? '掌握 ✓' : days(INTERVALS[nextBox(box)])} · 3</span></button>
      </div>
    </div>` : ''}
  </div>`;
}
