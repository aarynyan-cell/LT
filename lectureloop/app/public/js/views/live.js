// 上课模式：实时字幕 + 译文 + 同步录音 + 一键"没听懂"。结束即归档为课时（真实时间轴）。
import { html, useState, useEffect, useRef } from '../h.js';
import { useStore, actions, navigate, lessonUrl, toast, getCourse } from '../store.js';
import { LiveSession, asrSupported, micSupported } from '../lib/asr.js';
import { translate, translateAvailable } from '../lib/api.js';
import { buildSeed } from '../lib/seed.js';
import { fmtTime, fmtDate, uid } from '../lib/util.js';
import { Modal, LANGS, useHotkeys } from '../components/ui.js';
import { NewCourse } from './library.js';

const ERR = {
  'not-allowed': '麦克风或语音识别权限被拒绝',
  'service-not-allowed': '浏览器不允许使用语音识别服务',
  'audio-capture': '没有检测到可用的麦克风',
  'language-not-supported': '浏览器不支持该识别语言',
};
const STATUS = { listening: '● 识别中', reconnecting: '重连中…', network: '网络波动，重试中', paused: '已暂停', 'demo-end': '演示结束，可点“结束并归档”', 'no-asr': '仅录音' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const demoCues = () => buildSeed().transcripts.find((t) => t.lessonId === 'l_seed_ml1').cues;

function Rec({ ses, phase, demo }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 500); return () => clearInterval(t); }, []);
  const on = phase === 'running';
  return html`<span class=${'rec' + (on ? '' : ' off')} aria-live="off"><i></i>${demo ? 'DEMO' : phase === 'paused' ? 'PAUSED' : on ? 'REC' : ''} ${fmtTime(ses.current?.elapsed() || 0)}</span>`;
}

export function Live({ route }) {
  const courses = useStore((s) => s.courses);
  const settings = useStore((s) => s.settings);
  const config = useStore((s) => s.config);

  const [courseId, setCourseId] = useState(() => route.query.course || (courses.some((c) => c.id === settings.lastCourse) ? settings.lastCourse : courses[0]?.id) || '');
  const course = courses.find((c) => c.id === courseId);
  const [lang, setLang] = useState(course?.srcLang || settings.srcLang);
  const [title, setTitle] = useState(`实时课堂 ${fmtDate(Date.now())}`);
  const [phase, setPhase] = useState('idle'); // idle | running | paused | saving
  const [source, setSource] = useState('mic');
  const [lines, setLines] = useState([]);
  const [interim, setInterim] = useState('');
  const [marks, setMarks] = useState(0);
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState(null);
  const [trErr, setTrErr] = useState(null);
  const [ack, setAck] = useState(false);
  const [newCourse, setNewCourse] = useState(false);
  const [peek, setPeek] = useState(false);
  const [draft, setDraft] = useState(null);

  const ses = useRef(null);
  const linesRef = useRef([]);
  const marksRef = useRef([]);
  const pending = useRef([]);
  const flushTimer = useRef(0);
  const flashTimer = useRef(0);
  const stage = useRef();
  const live = useRef({});
  const targets = settings.targets.filter((t) => t !== (source === 'demo' ? 'en' : lang)).slice(0, 2);
  live.current = { lang: source === 'demo' ? 'en' : lang, targets, config, glossary: (course?.glossary || []).map((g) => g.term), courseId, title };

  const canMic = asrSupported() && micSupported();

  // 恢复未归档草稿
  useEffect(() => { actions.getLiveDraft().then((d) => d?.lines?.length && setDraft(d)); }, []);
  // 运行中：每 30 秒落盘草稿；离开页面前提示
  useEffect(() => {
    if (phase !== 'running' && phase !== 'paused') return;
    const save = () => actions.saveLiveDraft({ courseId: live.current.courseId, title: live.current.title, lang: live.current.lang, lines: linesRef.current.map(({ id, ...c }) => c), marks: marksRef.current, ts: Date.now() });
    const t = setInterval(save, 30_000);
    const warn = (e) => { save(); e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', warn); };
  }, [phase]);
  // 卸载（切换页面）时：保存草稿并停止会话
  useEffect(() => () => {
    const s = ses.current;
    if (!s) return;
    actions.saveLiveDraft({ courseId: live.current.courseId, title: live.current.title, lang: live.current.lang, lines: linesRef.current.map(({ id, ...c }) => c), marks: marksRef.current, ts: Date.now() });
    s.stop();
  }, []);
  // 字幕贴底
  useEffect(() => { const el = stage.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, interim]);
  // 按住 H 显示淡出的原文
  useEffect(() => { const up = (e) => (e.key === 'h' || e.key === 'H') && setPeek(false); window.addEventListener('keyup', up); return () => window.removeEventListener('keyup', up); }, []);

  // ---------- 翻译队列 ----------
  const patch = (fn) => { linesRef.current = fn(linesRef.current); setLines(linesRef.current); };
  async function flush() {
    const idxs = pending.current.splice(0);
    const { lang: src, targets: tgs, config: cfg, glossary } = live.current;
    if (!idxs.length || !tgs.length) return;
    const items = idxs.map((i) => ({ i, t: linesRef.current[i].text }));
    const context = linesRef.current.slice(Math.max(0, idxs[0] - 3), idxs[0]).map((l) => l.text);
    try {
      const r = await translate({ source: src, targets: tgs, items, context, glossary, config: cfg });
      patch((ls) => {
        const next = [...ls];
        for (const [tl, arr] of Object.entries(r.results || {})) for (const { i, t } of arr) if (next[i] && t) next[i] = { ...next[i], tr: { ...next[i].tr, [tl]: t } };
        return next;
      });
      setTrErr(null);
    } catch (e) {
      setTrErr(e.message || '翻译不可用');
    }
  }
  function onFinal(c) {
    patch((ls) => [...ls, { ...c, id: uid('ln_') }]);
    const idx = linesRef.current.length - 1;
    const need = live.current.targets.filter((t) => !c.tr?.[t]);
    if (!need.length) return; // 演示课堂自带参考译文
    pending.current.push(idx);
    clearTimeout(flushTimer.current);
    if (pending.current.length >= 4) flush(); else flushTimer.current = setTimeout(flush, 700);
  }

  // ---------- 控制 ----------
  async function start(src) {
    if (!courseId) { toast('请先选择或新建一门课程', { kind: 'warn' }); return; }
    if (src === 'mic' && !settings.recordingAck) { setAck(true); return; }
    linesRef.current = []; setLines([]); marksRef.current = []; setMarks(0); setTrErr(null); setInterim(''); pending.current = [];
    const s = new LiveSession({
      lang: src === 'demo' ? 'en' : lang, source: src, demoCues: src === 'demo' ? demoCues() : null, demoSpeed: +route.query.demoSpeed || 2.2,
      onInterim: setInterim, onFinal, onStatus: setStatus,
      onError: (code) => { setStatus('error'); toast(`${ERR[code] || '语音识别出错'}（${code}）。可改用“演示课堂”或导入转录。`, { kind: 'warn', ms: 9000 }); },
    });
    setSource(src);
    try {
      await s.start();
    } catch (e) {
      toast(`无法开始录音：${e.message}。可改用“演示课堂”体验。`, { kind: 'warn', ms: 9000 });
      return;
    }
    ses.current = s;
    document.activeElement?.blur?.();
    setPhase('running');
    actions.setSetting('lastCourse', courseId);
  }
  function togglePause() {
    const s = ses.current;
    if (!s) return;
    if (phase === 'running') { s.pause(); setPhase('paused'); } else { s.resume(); setPhase('running'); }
  }
  async function stop() {
    const s = ses.current;
    if (!s) return;
    setPhase('saving');
    clearTimeout(flushTimer.current);
    await Promise.race([flush(), sleep(3000)]); // 最后一批译文：尽力而为，不阻塞归档
    const { blob, mime, duration } = await s.stop();
    ses.current = null;
    if (!linesRef.current.length) {
      setPhase('idle');
      await actions.clearLiveDraft();
      toast('没有识别到任何内容，未归档');
      return;
    }
    const lesson = await actions.saveLive({
      courseId, title: title.trim() || '实时课堂', srcLang: live.current.lang, cues: linesRef.current.map(({ id, ...c }) => c),
      marks: marksRef.current, blob: source === 'demo' ? null : blob, mime, duration,
    });
    await actions.clearLiveDraft();
    toast(`已归档：${lesson.stats.sentences} 句 · ${marksRef.current.length} 个卡点`);
    navigate(lessonUrl(lesson.id));
  }
  function mark() {
    const s = ses.current;
    if (!s || phase !== 'running') return;
    const t = s.elapsed();
    marksRef.current.push({ t });
    setMarks(marksRef.current.length);
    setFlash(`✓ 已标记 ${fmtTime(t)}`);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }
  async function recoverDraft() {
    const d = draft;
    if (!getCourse(d.courseId)) { toast('草稿所属课程已不存在', { kind: 'warn' }); return; }
    const lesson = await actions.saveLive({ courseId: d.courseId, title: d.title, srcLang: d.lang, cues: d.lines, marks: d.marks || [], blob: null, duration: d.lines.at(-1)?.end || 0 });
    await actions.clearLiveDraft();
    setDraft(null);
    navigate(lessonUrl(lesson.id));
  }

  useHotkeys((e) => {
    if ((e.key === ' ' || e.key === 'm' || e.key === 'M') && phase === 'running') {
      // 上课时空格永远是"没听懂"：阻止它激活当前聚焦的按钮（否则可能误触"暂停/结束并归档"）
      e.preventDefault();
      if (e.target?.tagName === 'BUTTON') e.target.blur();
      if (!e.repeat) mark();
    }
    if (e.key === 'h' || e.key === 'H') setPeek(true);
  });

  const toggleTarget = (l) => {
    const cur = settings.targets;
    actions.setSetting('targets', cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l].slice(-2));
  };
  const busy = phase === 'running' || phase === 'paused' || phase === 'saving';
  const shown = lines.slice(-8);

  return html`<div class="live">
    <div class="live-bar">
      <label class="row small">课程
        <select value=${courseId} disabled=${busy} onChange=${(e) => { if (e.target.value === '__new') { setNewCourse(true); return; } setCourseId(e.target.value); const c = getCourse(e.target.value); if (c) setLang(c.srcLang); }}>
          ${!courses.length ? html`<option value="">（还没有课程）</option>` : ''}
          ${courses.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
          <option value="__new">＋ 新建课程…</option>
        </select></label>
      <label class="row small">讲课语言
        <select value=${lang} disabled=${busy} onChange=${(e) => setLang(e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></label>
      <span class="row small">译文 ${Object.entries(LANGS).filter(([k]) => k !== live.current.lang).map(([k, v]) => html`<span class=${'chip ' + (settings.targets.includes(k) ? 'on' : '')} onClick=${() => toggleTarget(k)}>${v}</span>`)}</span>
      <label class="row small">字号 <input type="range" min="18" max="52" value=${settings.fontSize} onInput=${(e) => actions.setSetting('fontSize', +e.target.value)} aria-label="字幕字号" /></label>
      <label class="row small" title="原文模糊，悬停或按住 H 才显示：逼自己先听再看"><input type="checkbox" checked=${settings.fadeOriginal} onChange=${(e) => actions.setSetting('fadeOriginal', e.target.checked)} /> 淡出原文</label>
      <input class="grow" value=${title} onInput=${(e) => setTitle(e.target.value)} aria-label="课时标题" placeholder="课时标题" style="min-width:140px" />
    </div>

    <div class="live-ctl">
      ${phase !== 'idle' ? html`<${Rec} ses=${ses} phase=${phase} demo=${source === 'demo'} />` : ''}
      ${phase === 'idle' ? html`
        <button key="start-mic" class="btn primary" disabled=${!canMic} title=${canMic ? '' : '当前浏览器不支持语音识别或录音'} onClick=${() => start('mic')}>🎙 开始上课</button>
        <button key="start-demo" class="btn" onClick=${() => start('demo')}>▶ 演示课堂（无需麦克风）</button>`
      : html`
        <button key="pause" class="btn" disabled=${phase === 'saving'} onKeyDown=${(e) => e.key === ' ' && e.preventDefault()} onClick=${togglePause}>${phase === 'paused' ? '▶ 继续' : '⏸ 暂停'}</button>
        <button key="stop" class="btn primary" disabled=${phase === 'saving'} onKeyDown=${(e) => e.key === ' ' && e.preventDefault()} onClick=${stop}>${phase === 'saving' ? html`<span class="spin"></span> 归档中…` : '■ 结束并归档'}</button>`}
      ${status && phase !== 'idle' ? html`<span class=${'badge ' + (status === 'listening' ? 'ok' : 'warn')}>${STATUS[status] || status}</span>` : ''}
      ${trErr && phase !== 'idle' ? html`<span class="badge" title=${trErr}>译文暂不可用，仅显示原文</span>` : ''}
      <span class="right small muted">${phase !== 'idle' ? `${lines.length} 句 · ${marks} 个卡点` : ''}</span>
    </div>

    ${draft && phase === 'idle' ? html`<div class="banner warn">发现上次未归档的课堂草稿（${draft.lines.length} 句，${new Date(draft.ts).toLocaleString()}）。
      <button class="btn sm" onClick=${recoverDraft}>恢复为课时（无录音）</button><button class="btn sm ghost" onClick=${() => { actions.clearLiveDraft(); setDraft(null); }}>丢弃</button></div>` : ''}

    ${phase === 'idle' ? html`<div class="stage"><div class="card" style="max-width:640px;margin:auto;font-size:15px">
        <h2>课中：听懂当下，标记卡点</h2>
        <ol class="small" style="line-height:1.9">
          <li>选择课程与讲课语言，勾选需要的译文（最多 2 种）。</li>
          <li>点 <b>开始上课</b>：实时字幕 + 同步录音（首次需确认录音许可）。</li>
          <li>没听懂就按 <span class="kbd">Space</span> 或点下方大按钮——自动标记最近约 15 秒，不打断听课。</li>
          <li>想练耳朵？勾选 <b>淡出原文</b>：原文模糊，按住 <span class="kbd">H</span> 才显示。</li>
          <li>下课点 <b>结束并归档</b>：进入 Studio，把卡点变成精听练习。</li>
        </ol>
        ${!canMic ? html`<div class="banner warn" style="border-radius:8px">此浏览器不支持实时语音识别或录音（建议使用桌面版 Chrome / Edge，并通过 localhost 或 https 访问）。可以先用“演示课堂”体验完整流程，或在课程库导入转录。</div>` : ''}
        <div class="tiny muted" style="margin-top:8px">提示：浏览器的语音识别可能由浏览器厂商的云服务处理；录音只保存在本机。${config && !translateAvailable() ? ' 当前没有可用的翻译服务，实时译文不可用（演示课堂自带参考译文；可在“设置”里填入 Claude 密钥）。' : ''}</div>
      </div></div>`
    : html`<div class=${'stage' + (settings.fadeOriginal ? ' fade' : '') + (peek ? ' peek' : '')} ref=${stage} style=${`font-size:${settings.fontSize}px`} aria-live="polite">
        ${shown.map((l, k) => html`<div class=${'ln' + (k < shown.length - 1 ? ' old' : '')} key=${l.id}>
          <div class="o">${l.text}</div>
          ${targets.map((t, n) => (l.tr?.[t] ? html`<div class=${'tr' + (n ? ' tr2' : '')} style="font-size:.62em">${l.tr[t]}</div>` : ''))}
        </div>`)}
        ${interim ? html`<div class="ln interim"><div class="o">${interim}</div></div>` : ''}
        ${!lines.length && !interim ? html`<div class="muted center" style="font-size:16px">${phase === 'paused' ? '已暂停' : '正在聆听…'}</div>` : ''}
      </div>
      <div class="stuck-dock">
        <button class="btn stuck" disabled=${phase !== 'running'} onMouseDown=${(e) => e.preventDefault()} onClick=${mark}>🚩 没听懂 <span class="kbd" style="color:var(--ink)">Space</span></button>
        <span class="small" aria-live="polite">${flash || (marks ? `已标记 ${marks} 处` : '标记最近约 15 秒')}</span>
      </div>`}

    ${ack && html`<${Modal} title="课堂录音提醒" onClose=${() => setAck(false)}
      foot=${html`<button class="btn" onClick=${() => setAck(false)}>取消</button><button class="btn primary" onClick=${async () => { await actions.setSetting('recordingAck', true); setAck(false); start('mic'); }}>我已获得许可，开始</button>`}>
      <p>请确认你已获得<b>授课教师 / 学校</b>对课堂录音的许可。</p>
      <p class="small muted">录音只保存在本机浏览器（IndexedDB），不会上传。实时字幕使用浏览器自带的语音识别，可能由浏览器厂商的云服务处理语音。</p>
    <//>`}
    ${newCourse && html`<${NewCourse} onClose=${() => setNewCourse(false)} onCreated=${(c) => { setCourseId(c.id); setLang(c.srcLang); }} />`}
  </div>`;
}
