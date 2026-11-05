import { html } from '../h.js';
import { useStore, dueClips, navigate, lessonUrl, actions, getCourse } from '../store.js';
import { fmtDate } from '../lib/util.js';
import { REASONS } from '../components/ui.js';

export function Home() {
  const lessons = useStore((s) => s.lessons);
  const clips = useStore((s) => s.clips);
  const courses = useStore((s) => s.courses);
  const config = useStore((s) => s.config);

  const stuck = clips.filter((c) => c.kind === 'stuck');
  const due = dueClips(clips);
  const recent = [...lessons].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  // 卡点密度（每 10 分钟）——北极星指标；按课时日期排序取最近 8 节
  const dens = [...lessons].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt).slice(-8).map((l) => ({
    l, v: stuck.filter((c) => c.lessonId === l.id).length / Math.max(1, l.duration / 600),
  }));
  const maxD = Math.max(0.0001, ...dens.map((d) => d.v));
  const reasons = Object.entries(REASONS).map(([k, label]) => [label, stuck.filter((c) => c.reason === k).length]).filter(([, n]) => n);
  const unlabeled = stuck.filter((c) => !c.reason).length;
  const maxR = Math.max(1, ...reasons.map(([, n]) => n), unlabeled);
  const week = Date.now() - 7 * 86400000;
  const doneWeek = clips.reduce((s, c) => s + (c.srs?.attempts || []).filter((a) => a.ts > week).length, 0);
  const hasSample = courses.some((c) => c.sample);

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>${due.length ? `今天有 ${due.length} 张卡点待练` : '今天的卡点已清空 🎉'}</h1>
      <div class="muted small">课上听懂，课后听会 · 本周已完成 ${doneWeek} 次精听</div></div></div>

    ${hasSample && html`<div class="banner" style="border-radius:10px;margin-bottom:14px">📌 当前包含示例课程（取自真实课堂转录的短摘录）。<button class="btn sm" onClick=${() => navigate(lessonUrl('l_seed_ml1'))}>去体验</button>
      <button class="btn sm ghost right" onClick=${() => confirm('删除全部示例课程及其卡点？') && actions.removeSamples()}>删除示例数据</button></div>`}

    <div class="hero">
      <div class="card big-cta">
        <h2>${due.length ? '开始今日训练' : '去标记新的卡点'}</h2>
        <div class="small" style="opacity:.9;margin-top:4px">${due.length ? `${due.length} 张 · 约 ${Math.max(1, Math.round(due.length * 1.5))} 分钟 · 盲听 → 听写 → 揭示 → 自评` : '在课程里框选听不懂的片段，它们会出现在这里'}</div>
        <button class="btn lg" onClick=${() => navigate(due.length ? '/drill' : '/library')}>${due.length ? '▶ 开始' : '去课程库'}</button>
      </div>
      <div class="card"><h3>🎙 开始上课</h3><p class="small muted">实时字幕 + 翻译 + 录音，一键标记没听懂。没有麦克风可用演示课堂体验。</p><button class="btn primary" onClick=${() => navigate('/live')}>进入上课模式</button></div>
      <div class="card"><h3>📥 导入转录</h3><p class="small muted">支持语音备忘录导出的 .docx、txt、srt、vtt，可附带录音。</p><button class="btn" onClick=${() => actions.setUi({ importOpen: true })}>导入课堂</button></div>
    </div>

    <div class="sect"><h2>卡点密度 <span class="muted small">每 10 分钟课堂的卡点数 —— 越往右越低说明越听得懂</span></h2>
      <div class="card">${dens.length ? html`<div class="spark" role="img" aria-label="卡点密度趋势">${dens.map(({ l, v }) => html`<i title=${`${l.title}：${v.toFixed(1)} / 10min`} class=${v === maxD && v > 0 ? 'hot' : ''} style=${`height:${Math.max(6, (v / maxD) * 100)}%`}></i>`)}</div>
        <div class="row small muted" style="justify-content:space-between;margin-top:4px"><span>${fmtDate(dens[0].l.date || dens[0].l.createdAt)}</span><span>${fmtDate(dens.at(-1).l.date || dens.at(-1).l.createdAt)}</span></div>` : html`<div class="muted small">还没有课时。</div>`}</div></div>

    <div class="grid sect" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div><h2>最近课时</h2><div class="card flat">${recent.length ? recent.map((l) => html`<a key=${l.id} href=${'#' + lessonUrl(l.id)} class="row" style="padding:8px 0;border-bottom:1px solid var(--line);color:inherit">
        <div class="grow"><div><b>${l.title}</b></div><div class="tiny muted">${getCourse(l.courseId)?.name || ''} · ${l.date || ''}</div></div>
        <span class="badge stuck">${stuck.filter((c) => c.lessonId === l.id).length} 卡点</span></a>`) : html`<div class="muted small">暂无</div>`}</div></div>
      <div><h2>卡点原因</h2><div class="card flat">${reasons.length || unlabeled ? html`${reasons.map(([label, n]) => html`<div class="reason-row"><span>${label}</span><div class="bar"><i style=${`width:${(n / maxR) * 100}%`}></i></div><span class="muted">${n}</span></div>`)}
        ${unlabeled ? html`<div class="reason-row"><span class="muted">未填原因</span><div class="bar"><i style=${`width:${(unlabeled / maxR) * 100}%;background:var(--muted)`}></i></div><span class="muted">${unlabeled}</span></div>` : ''}` : html`<div class="muted small">标记卡点后在这里看到分布。</div>`}</div></div>
    </div>
    ${config && !config.claude && html`<p class="tiny muted" style="margin-top:20px">未检测到 Claude 密钥：笔记/词汇将使用离线版。在 <code>app/.env</code> 配置 <code>ANTHROPIC_API_KEY</code> 后重启即可（见设置页）。</p>`}
  </div>`;
}
