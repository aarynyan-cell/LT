// 上课模式（展示层）：录音会话由全局控制器 lib/live.js 持有，切换页面不会中断。
import { html, useState, useEffect, useRef } from '../h.js';
import { useStore, actions, navigate, lessonUrl, toast, getCourse } from '../store.js';
import { asrSupported, micSupported } from '../lib/asr.js';
import { translateAvailable } from '../lib/api.js';
import { live, useLive, liveElapsed } from '../lib/live.js';
import { fmtTime, fmtDate } from '../lib/util.js';
import { Modal, LANGS, useHotkeys } from '../components/ui.js';
import { NewCourse } from './library.js';

export const STATUS = { listening: '● 识别中', reconnecting: '重连中…', network: '网络波动，重试中', paused: '已暂停', 'demo-end': '演示结束，可点“结束并归档”', 'no-asr': '仅录音' };

/** 录音计时（自己每 500ms 刷新，不拖累整页） */
export function RecTimer({ demo }) {
  const phase = useLive((s) => s.phase);
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 500); return () => clearInterval(t); }, []);
  const on = phase === 'running';
  return html`<span class=${'rec' + (on ? '' : ' off')} aria-live="off"><i></i>${demo ? 'DEMO' : phase === 'paused' ? 'PAUSED' : on ? 'REC' : ''} ${fmtTime(liveElapsed())}</span>`;
}

/** 结束并归档（上课页与全局录音条共用）：归档后跳到新课时 */
export async function finishLive() {
  const lesson = await live.stop();
  if (!lesson) { toast('没有识别到任何内容，未归档'); return; }
  toast(`已归档：${lesson.stats.sentences} 句`);
  navigate(lessonUrl(lesson.id));
}

export function Live({ route }) {
  const courses = useStore((s) => s.courses);
  const settings = useStore((s) => s.settings);
  const config = useStore((s) => s.config);
  const L = useLive();

  const [courseId, setCourseId] = useState(() => route.query.course || (courses.some((c) => c.id === settings.lastCourse) ? settings.lastCourse : courses[0]?.id) || '');
  const course = courses.find((c) => c.id === courseId);
  const [lang, setLang] = useState(course?.srcLang || settings.srcLang);
  const [title, setTitle] = useState(`实时课堂 ${fmtDate(Date.now())}`);
  const [ack, setAck] = useState(false);
  const [newCourse, setNewCourse] = useState(false);
  const [peek, setPeek] = useState(false);
  const [draft, setDraft] = useState(null);
  const stage = useRef();

  const running = L.phase !== 'idle';
  const showLang = running ? L.lang : lang;
  const targets = (running ? L.targets : settings.targets.filter((t) => t !== (lang)).slice(0, 2));
  const canMic = asrSupported() && micSupported();

  useEffect(() => { actions.getLiveDraft().then((d) => d?.lines?.length && setDraft(d)); }, []);
  // 回到上课页时，显示正在进行的会话的课程/标题
  useEffect(() => { if (running) { setCourseId(L.courseId); setTitle(L.title); } }, []);
  useEffect(() => { const el = stage.current; if (el) el.scrollTop = el.scrollHeight; }, [L.lines, L.interim]);
  useEffect(() => { const up = (e) => (e.key === 'h' || e.key === 'H') && setPeek(false); window.addEventListener('keyup', up); return () => window.removeEventListener('keyup', up); }, []);

  // acked：刚在确认框里点了“我已获得许可”。不能依赖 settings.recordingAck——这个闭包里它还是旧值，会再次弹出确认框
  async function start(src, acked = false) {
    if (!courseId) { toast('请先选择或新建一门课程', { kind: 'warn' }); return; }
    if (src === 'mic' && !acked && !settings.recordingAck) { setAck(true); return; }
    try {
      document.activeElement?.blur?.();
      await live.start({ courseId, lang, title, source: src, targets: settings.targets, demoSpeed: +route.query.demoSpeed || 2.2 });
      actions.setSetting('lastCourse', courseId);
    } catch (e) {
      toast(`无法开始录音：${e.message}。可改用“演示课堂”体验。`, { kind: 'warn', ms: 9000 });
    }
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
    if ((e.key === ' ' || e.key === 'm' || e.key === 'M') && L.phase === 'running') {
      // 上课时空格永远是"没听懂"：阻止它激活当前聚焦的按钮（否则可能误触"暂停/结束并归档"）
      e.preventDefault();
      if (e.target?.tagName === 'BUTTON') e.target.blur();
      if (!e.repeat) live.mark();
    }
    if (e.key === 'h' || e.key === 'H') setPeek(true);
  });

  const toggleTarget = (l) => {
    const cur = settings.targets;
    actions.setSetting('targets', cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l].slice(-2));
  };
  const f = settings.float || {};
  const shown = L.lines.slice(-8);

  return html`<div class="live">
    <div class="live-bar">
      <label class="row small">课程
        <select value=${running ? L.courseId : courseId} disabled=${running} onChange=${(e) => { if (e.target.value === '__new') { setNewCourse(true); return; } setCourseId(e.target.value); const c = getCourse(e.target.value); if (c) setLang(c.srcLang); }}>
          ${!courses.length ? html`<option value="">（还没有课程）</option>` : ''}
          ${courses.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
          <option value="__new">＋ 新建课程…</option>
        </select></label>
      <label class="row small">讲课语言
        <select value=${showLang} disabled=${running} onChange=${(e) => setLang(e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></label>
      <span class="row small">译文 ${Object.entries(LANGS).filter(([k]) => k !== showLang).map(([k, v]) => html`<span class=${'chip ' + (settings.targets.includes(k) ? 'on' : '')} onClick=${() => toggleTarget(k)}>${v}</span>`)}</span>
      <label class="row small">字号 <input type="range" min="18" max="52" value=${settings.fontSize} onInput=${(e) => actions.setSetting('fontSize', +e.target.value)} aria-label="字幕字号" /></label>
      <label class="row small" title="原文模糊，悬停或按住 H 才显示：逼自己先听再看"><input type="checkbox" checked=${settings.fadeOriginal} onChange=${(e) => actions.setSetting('fadeOriginal', e.target.checked)} /> 淡出原文</label>
      <input class="grow" value=${running ? L.title : title} onInput=${(e) => { setTitle(e.target.value); if (running) live.setTitle(e.target.value); }} aria-label="课时标题" placeholder="课时标题" style="min-width:140px" />
    </div>

    <div class="live-ctl">
      ${running ? html`<${RecTimer} demo=${L.source === 'demo'} />` : ''}
      ${!running ? html`
        <button key="start-mic" class="btn primary" disabled=${!canMic} title=${canMic ? '' : '当前浏览器不支持语音识别或录音'} onClick=${() => start('mic')}>🎙 开始上课</button>
        <button key="start-demo" class="btn" onClick=${() => start('demo')}>▶ 演示课堂（无需麦克风）</button>`
      : html`
        <button key="pause" class="btn" disabled=${L.phase === 'saving' || L.phase === 'starting'} onKeyDown=${(e) => e.key === ' ' && e.preventDefault()} onClick=${() => (L.phase === 'paused' ? live.resume() : live.pause())}>${L.phase === 'paused' ? '▶ 继续' : '⏸ 暂停'}</button>
        <button key="stop" class="btn primary" disabled=${L.phase === 'saving' || L.phase === 'starting'} onKeyDown=${(e) => e.key === ' ' && e.preventDefault()} onClick=${finishLive}>${L.phase === 'saving' ? html`<span class="spin"></span> 归档中…` : '■ 结束并归档'}</button>`}
      <button class=${'btn' + (f.on ? ' primary' : '')} title="把字幕做成可拖动的悬浮块（切换页面也会一直显示）；还可以弹出到桌面" onClick=${() => actions.setSetting('float', { ...f, on: !f.on })}>🪟 悬浮字幕${f.on ? '：开' : ''}</button>
      ${L.status && running ? html`<span class=${'badge ' + (L.status === 'listening' ? 'ok' : 'warn')}>${STATUS[L.status] || L.status}</span>` : ''}
      ${L.trErr && running ? html`<span class="badge" title=${L.trErr}>译文暂不可用，仅显示原文</span>` : ''}
      <span class="right small muted">${running ? `${L.lines.length} 句 · ${L.marks} 个卡点 · 切换页面不会中断录音` : ''}</span>
    </div>

    ${draft && !running ? html`<div class="banner warn">发现上次未归档的课堂草稿（${draft.lines.length} 句，${new Date(draft.ts).toLocaleString()}）。
      <button class="btn sm" onClick=${recoverDraft}>恢复为课时（无录音）</button><button class="btn sm ghost" onClick=${() => { actions.clearLiveDraft(); setDraft(null); }}>丢弃</button></div>` : ''}

    ${!running ? html`<div class="stage"><div class="card" style="max-width:640px;margin:auto;font-size:15px">
        <h2>课中：听懂当下，标记卡点</h2>
        <ol class="small" style="line-height:1.9">
          <li>选择课程与讲课语言，勾选需要的译文（最多 2 种）。</li>
          <li>点 <b>开始上课</b>：实时字幕 + 同步录音（首次需确认录音许可）。<b>可以切换到其他页面或其他标签页，录音不会中断</b>（请保持这个浏览器标签页打开）。</li>
          <li>没听懂就按 <span class="kbd">Space</span> 或点下方大按钮——自动标记最近约 15 秒，不打断听课。</li>
          <li>想把字幕放在别的软件旁边？点 <b>悬浮字幕</b>，再点“弹出到桌面”，字幕会浮在所有窗口之上。</li>
          <li>下课点 <b>结束并归档</b>：进入 Studio，把卡点变成精听练习。</li>
        </ol>
        ${!canMic ? html`<div class="banner warn" style="border-radius:8px">此浏览器不支持实时语音识别或录音（建议使用桌面版 Chrome / Edge，并通过 localhost 或 https 访问）。可以先用“演示课堂”体验完整流程，或在课程库导入转录。</div>` : ''}
        <div class="tiny muted" style="margin-top:8px">提示：浏览器的语音识别可能由浏览器厂商的云服务处理；录音只保存在本机。${config && !translateAvailable() ? ' 当前没有可用的翻译服务，实时译文不可用（演示课堂自带参考译文；可在“设置”里填入 API 密钥）。' : ''}</div>
      </div></div>`
    : html`<div class=${'stage' + (settings.fadeOriginal ? ' fade' : '') + (peek ? ' peek' : '')} ref=${stage} style=${`font-size:${settings.fontSize}px`} aria-live="polite">
        ${shown.map((l, k) => html`<div class=${'ln' + (k < shown.length - 1 ? ' old' : '')} key=${l.id}>
          <div class="o">${l.text}</div>
          ${targets.map((t, n) => (l.tr?.[t] ? html`<div class=${'tr' + (n ? ' tr2' : '')} style="font-size:.62em">${l.tr[t]}</div>` : ''))}
        </div>`)}
        ${L.interim ? html`<div class="ln interim"><div class="o">${L.interim}</div></div>` : ''}
        ${!L.lines.length && !L.interim ? html`<div class="muted center" style="font-size:16px">${L.phase === 'paused' ? '已暂停' : '正在聆听…'}</div>` : ''}
      </div>
      <div class="stuck-dock">
        <button class="btn stuck" disabled=${L.phase !== 'running'} onMouseDown=${(e) => e.preventDefault()} onClick=${() => live.mark()}>🚩 没听懂 <span class="kbd" style="color:var(--ink)">Space</span></button>
        <span class="small" aria-live="polite">${L.flash || (L.marks ? `已标记 ${L.marks} 处` : '标记最近约 15 秒')}</span>
      </div>`}

    ${ack && html`<${Modal} title="课堂录音提醒" onClose=${() => setAck(false)}
      foot=${html`<button class="btn" onClick=${() => setAck(false)}>取消</button><button class="btn primary" onClick=${async () => { setAck(false); actions.setSetting('recordingAck', true); start('mic', true); }}>我已获得许可，开始</button>`}>
      <p>请确认你已获得<b>授课教师 / 学校</b>对课堂录音的许可。</p>
      <p class="small muted">录音只保存在本机浏览器（IndexedDB），不会上传。实时字幕使用浏览器自带的语音识别，可能由浏览器厂商的云服务处理语音。</p>
    <//>`}
    ${newCourse && html`<${NewCourse} onClose=${() => setNewCourse(false)} onCreated=${(c) => { setCourseId(c.id); setLang(c.srcLang); }} />`}
  </div>`;
}
