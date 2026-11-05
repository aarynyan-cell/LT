// 应用外壳：侧栏导航 + 路由出口 + 全局组件（Toast / 导入对话框 / 快捷键面板）
import { html, useState, useEffect } from './h.js';
import { useStore, dueClips, navigate } from './store.js';
import { Toasts, Shortcuts, useHotkeys } from './components/ui.js';
import { Importer } from './components/importer.js';
import { Home } from './views/home.js';
import { Live, RecTimer, finishLive } from './views/live.js';
import { FloatingCaptions } from './components/floating.js';
import { live, useLive } from './lib/live.js';
import { Library } from './views/library.js';
import { Course } from './views/course.js';
import { Lesson } from './views/lesson.js';
import { Drill } from './views/drill.js';
import { Vocab } from './views/vocab.js';
import { Settings } from './views/settings.js';
import { actions } from './store.js';

const VIEWS = { home: Home, live: Live, library: Library, course: Course, lesson: Lesson, drill: Drill, vocab: Vocab, settings: Settings };
const NAV = [
  ['home', '/', '🏠', '首页'], ['live', '/live', '🎙', '上课'], ['library', '/library', '📚', '课程库'],
  ['drill', '/drill', '🎧', '训练'], ['vocab', '/vocab', '🔤', '词汇'], ['settings', '/settings', '⚙️', '设置'],
];

export function App() {
  const ready = useStore((s) => s.ready);
  const route = useStore((s) => s.route);
  const clips = useStore((s) => s.clips);
  const ui = useStore((s) => s.ui);
  const due = ready ? dueClips(clips).length : 0;

  const phase = useLive((s) => s.phase);
  const lines = useLive((s) => s.lines.length);
  const marks = useLive((s) => s.marks);
  const demo = useLive((s) => s.source === 'demo');
  const flash = useLive((s) => s.flash);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 5000); return () => clearTimeout(t); }, []);
  useHotkeys((e) => { if (e.key === '?') actions.setUi({ shortcuts: true }); });

  const active = route.name === 'course' ? 'library' : route.name;
  const View = VIEWS[route.name] || Home;

  return html`<div class="app">
    <aside class="side">
      <div class="brand"><i>↻</i><span>LectureLoop</span></div>
      <nav class="nav" aria-label="主导航">
        ${NAV.map(([k, path, ic, label]) => html`<a key=${k} href=${'#' + path} class=${active === k || (k === 'home' && !VIEWS[route.name]) ? 'on' : ''}>
          <span class="ic">${ic}</span><span>${label}</span>${k === 'live' && phase !== 'idle' ? html`<span class="pill" title="正在录音">●</span>` : ''}${k === 'drill' && due > 0 ? html`<span class="pill" aria-label=${due + ' 张待练'}>${due}</span>` : ''}
        </a>`)}
      </nav>
      <div class="foot tiny muted">课上听懂，课后听会<br /><a href="#" onClick=${(e) => { e.preventDefault(); actions.setUi({ shortcuts: true }); }}>快捷键 <span class="kbd">?</span></a></div>
    </aside>
    <main class="main">
      ${phase !== 'idle' && route.name !== 'live' ? html`<div class="recbar" role="status">
        <${RecTimer} demo=${demo} /><span class="grow">${lines} 句 · ${marks} 个卡点 · 录音在后台继续${flash ? ' · ' + flash : ''}</span>
        <button class="btn sm stuck" disabled=${phase !== 'running'} onClick=${() => live.mark()}>🚩 没听懂</button>
        <a class="btn sm" href="#/live">回到字幕</a>
        <button class="btn sm primary" disabled=${phase === 'saving'} onClick=${finishLive}>■ 结束并归档</button>
      </div>` : ''}
      ${ready ? html`<${View} route=${route} key=${route.name + (route.params.id || '')} />` : html`<div class="page"><div class="row muted"><span class="spin"></span> 加载中…</div>${slow ? html`<p class="small muted">如果一直停在这里：请关闭其它打开 LectureLoop 的标签页后刷新页面。</p>` : ''}</div>`}
    </main>
    <${Toasts} />
    ${ready ? html`<${FloatingCaptions} />` : ''}
    ${ui.importOpen && html`<${Importer} />`}
    ${ui.shortcuts && html`<${Shortcuts} onClose=${() => actions.setUi({ shortcuts: false })} />`}
  </div>`;
}
