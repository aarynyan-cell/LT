// 语言拆解面板：词汇 / 句式 / 听力陷阱（ASR 纠错）
import { html, useState } from '../h.js';
import { actions, toast, getCourse } from '../store.js';
import { fmtTime } from '../lib/util.js';
import { FN_LABEL } from '../lib/heuristics.js';
import { Tabs, Empty, Seg } from '../components/ui.js';
import { Play } from './notes.js';

const ST = { new: '新词', learning: '学习中', known: '已掌握' };

export function LanguagePanel({ lesson, cues, player, busy, settings }) {
  const corr = lesson.corrections || [];
  const pending = corr.filter((c) => c.state === 'pending');
  const [view, setView] = useState(pending.length && !lesson.language ? 'traps' : 'vocab');
  const [lang, setLang] = useState(settings.noteLang);
  const [st, setSt] = useState('all');
  const L = lesson.language;
  const course = getCourse(lesson.courseId);

  const run = html`<button class="btn sm right" disabled=${busy} onClick=${() => actions.runLanguage(lesson.id)}>${busy ? html`<span class="spin"></span> 提取中…` : L ? '↻ 重新提取' : '✨ 提取词汇与句式'}</button>`;

  return html`<div>
    <div class="row wrap" style="margin-bottom:8px">
      ${L ? html`<span class=${'badge ' + (L.source === 'claude' ? 'acc' : 'warn')} title=${L.fallbackReason || ''}>${L.source === 'claude' ? `AI · ${L.model || 'Claude'}` : '离线版'}</span>` : ''}
      ${run}
    </div>
    <${Tabs} value=${view} onChange=${setView} options=${[['vocab', `词汇${L ? ' ' + L.vocab.length : ''}`], ['patterns', `句式${L ? ' ' + L.patterns.length : ''}`], ['traps', `听力陷阱${pending.length ? ' ·' + pending.length : ''}`]]} />

    ${view === 'traps' ? html`<${Traps} lesson=${lesson} cues=${cues} player=${player} corr=${corr} course=${course} />`
      : !L ? html`<${Empty} icon="🔤" title="还没有提取词汇与句式">点右上“提取词汇与句式”：有 Claude 密钥时由 AI 生成三语释义、配套句式与扩展，否则使用离线词典 + 讲者话语标记识别。<//>`
      : view === 'vocab' ? html`<div>
        <div class="row wrap" style="margin-bottom:10px"><${Seg} value=${lang} onChange=${setLang} options=${[['zh', '中'], ['en', 'EN'], ['fr', 'FR']]} />
          <${Seg} value=${st} onChange=${setSt} options=${[['all', '全部'], ...Object.entries(ST)]} /></div>
        ${L.vocab.filter((v) => st === 'all' || v.status === st).map((v) => html`<div class="vcard" key=${v.term}>
          <div class="row"><span class="term">${v.term}</span><span class="muted small">${v.pos || ''}</span>${v.kind !== 'term' ? html`<span class="badge">${v.kind === 'phrase' ? '短语' : '搭配'}</span>` : ''}
            <${Play} cue=${v.cue} cues=${cues} player=${player} />
            <select class="right" value=${v.status} onChange=${(e) => actions.setVocabStatus(lesson.id, v.term, e.target.value)} aria-label="状态">${Object.entries(ST).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>
          <div>${v.def?.[lang] || v.def?.en || html`<span class="muted small">（离线版无释义）</span>`}</div>
          <div class="small muted" style="margin-top:2px">“${cues[v.cue]?.text?.slice(0, 120) || ''}”</div>
          ${v.heardAs?.length ? html`<div class="heard">⚠ 常被听成：${v.heardAs.join(' / ')}</div>` : ''}
        </div>`)}
      </div>`
      : html`<div>${L.patterns.length ? L.patterns.map((p, k) => html`<div class="vcard" key=${k}>
          <div class="row"><span class="badge acc">${FN_LABEL[p.fn] || p.fn}</span><span class="term" style="font-size:15px">${p.template}</span>${p.count ? html`<span class="muted tiny">× ${p.count}</span>` : ''}</div>
          ${p.explain ? html`<div class="small muted">${p.explain}</div>` : ''}
          ${(p.cues || [p.cue]).slice(0, 2).map((ci) => html`<div class="row small" style="margin-top:4px"><${Play} cue=${ci} cues=${cues} player=${player} /><span>“${cues[ci]?.text?.slice(0, 130)}”</span></div>`)}
          ${p.extensions?.length ? p.extensions.map((e) => html`<div class="ext"><div>${e.en}</div><div class="muted">${e.zh}</div></div>`) : html`<div class="tiny muted" style="margin-top:4px">扩展句式需要 AI 生成</div>`}
        </div>`) : html`<${Empty} icon="🗣" title="没有识别到句式" />`}</div>`}
  </div>`;
}

function Traps({ lesson, cues, player, corr, course }) {
  const pending = corr.filter((c) => c.state === 'pending');
  const applied = corr.filter((c) => c.state === 'applied');
  const ignored = corr.filter((c) => c.state === 'ignored');
  const first = (c) => c.cues?.[0] ?? 0;
  const addToDrill = async (c) => {
    const i = first(c);
    await actions.addClip({ lessonId: lesson.id, kind: 'stuck', startCue: i, endCue: i, reason: 'term', note: `ASR 听成 “${c.wrong}”，实为 “${c.right}”`, source: 'trap' });
    toast('已加入卡点训练');
  };
  const Row = ({ c, children }) => html`<div class="vcard" key=${c.wrong}>
    <div class="row wrap"><span style="text-decoration:line-through;color:var(--stuck)">${c.wrong}</span><span>→</span><b>${c.right}</b><span class="badge">× ${c.count}</span>
      <${Play} cue=${first(c)} cues=${cues} player=${player} /></div>
    ${c.reason ? html`<div class="tiny muted">${c.reason}${c.src === 'claude' ? ' · AI' : c.src === 'glossary' ? ' · 术语表' : ''}</div>` : ''}
    <div class="row" style="margin-top:6px">${children}</div></div>`;
  return html`<div>
    <p class="small muted">语音识别把下面这些词听错了——<b>这些恰恰是容易听错的地方</b>。确认后会改写全文（可撤销，保留 ASR 原文），并可一键加入训练。</p>
    ${pending.length ? html`<div class="row" style="margin-bottom:8px"><b>待确认 ${pending.length}</b><button class="btn sm primary right" onClick=${() => actions.applyAllCorrections(lesson.id)}>全部采纳</button></div>
      ${pending.map((c) => html`<${Row} c=${c}><button class="btn sm primary" onClick=${() => actions.setCorrection(lesson.id, c.wrong, 'applied')}>采纳</button><button class="btn sm" onClick=${() => actions.setCorrection(lesson.id, c.wrong, 'ignored')}>忽略</button><//>`)}` : ''}
    ${applied.length ? html`<div class="nsec" style="margin-top:12px"><h3>已采纳（听力陷阱）${applied.length}</h3>${applied.map((c) => html`<${Row} c=${c}><button class="btn sm" onClick=${() => addToDrill(c)}>＋ 加入训练</button><button class="btn sm ghost" onClick=${() => actions.setCorrection(lesson.id, c.wrong, 'pending')}>撤销</button><//>`)}</div>` : ''}
    ${ignored.length ? html`<details style="margin-top:8px"><summary class="small muted">已忽略 ${ignored.length}</summary>${ignored.map((c) => html`<${Row} c=${c}><button class="btn sm" onClick=${() => actions.setCorrection(lesson.id, c.wrong, 'pending')}>恢复</button><//>`)}</details>` : ''}
    ${!corr.length ? html`<${Empty} icon="👂" title="没有发现可疑的术语错误">可以在课程术语表里添加“常被听成”，或点上方“提取”让 AI 找。<//>` : ''}
    <div class="tiny muted" style="margin-top:10px">没找到想改的词？去 <a href=${'#/course/' + course?.id}>课程术语表</a> 添加“正确术语 / 常被听成”，再重新扫描。</div>
  </div>`;
}
