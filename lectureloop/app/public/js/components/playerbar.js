// 播放条：播放控制 · 倍速 · A-B 循环 · 逐句重复 · 引擎切换 · 时间轴（作为 children 传入）
import { html, useState, useEffect, useRef } from '../h.js';
import { fmtTime } from '../lib/util.js';
import { SPEEDS } from '../lib/player.js';

const ENGINE = { audio: '🔊 录音', tts: '🗣 朗读', clock: '⏱ 静音' };

export function PlayerBar({ player, children }) {
  const [st, setSt] = useState(player.state);
  const [a, setA] = useState(null);
  const label = useRef();
  useEffect(() => { setSt(player.state); return player.on('state', setSt); }, [player]);
  useEffect(() => player.on('time', (t) => { if (label.current) label.current.textContent = `${fmtTime(t)} / ${fmtTime(player.duration)}`; }), [player]);
  useEffect(() => { if (label.current) label.current.textContent = `${fmtTime(player.time)} / ${fmtTime(player.duration)}`; }, [st.duration]);

  const setB = () => { if (a != null && player.time > a) { player.setLoop(a, player.time); setA(null); } };
  const engines = ['audio', 'tts', 'clock'].filter((k) => (k === 'audio' ? st.hasAudio : k === 'tts' ? st.ttsOk : true));

  return html`<div class="player">
    <div class="ctl">
      <button class="btn sm" title="上一句（←）" aria-label="上一句" onClick=${() => player.prevCue()}>⏮</button>
      <button class="round" title="播放 / 暂停（Space）" aria-label=${st.playing ? '暂停' : '播放'} onClick=${() => player.toggle()}>${st.playing ? '⏸' : '▶'}</button>
      <button class="btn sm" title="下一句（→）" aria-label="下一句" onClick=${() => player.nextCue()}>⏭</button>
      <span class="time" ref=${label}></span>
      <span class="row" style="gap:2px" title="倍速（[ ]）">
        <button class="btn sm ghost" aria-label="降速" onClick=${() => player.stepRate(-1)}>−</button>
        <select aria-label="倍速" value=${String(st.rate)} onChange=${(e) => player.setRate(+e.target.value)} style="padding:3px 6px">${SPEEDS.map((s) => html`<option value=${String(s)}>${s}×</option>`)}</select>
        <button class="btn sm ghost" aria-label="升速" onClick=${() => player.stepRate(1)}>＋</button>
      </span>
      <span class="row" style="gap:4px">
        <button class=${'btn sm' + (a != null ? ' primary' : '')} title="设置循环起点（A）" onClick=${() => setA(player.time)}>A${a != null ? ' ' + fmtTime(a) : ''}</button>
        <button class="btn sm" title="设置循环终点并开始循环（B）" disabled=${a == null} onClick=${setB}>B</button>
        <button class=${'btn sm' + (st.loop ? ' primary' : '')} title="循环当前句（L）" onClick=${() => (st.loop ? player.clearLoop() : player.loopCue(Math.max(0, player.curCue)))}>🔁${st.loop ? ' 循环中' : ''}</button>
        ${st.loop || a != null ? html`<button class="btn sm ghost" aria-label="清除循环" onClick=${() => { player.clearLoop(); setA(null); }}>✕</button>` : ''}
      </span>
      <label class="row small" title="逐句重复：每句自然播放时重复 N 遍再继续">逐句重复
        <select value=${String(st.sentenceN)} onChange=${(e) => player.setSentenceRepeat(e.target.value === 'Infinity' ? Infinity : +e.target.value)} style="padding:3px 6px">
          <option value="1">关</option><option value="2">2×</option><option value="3">3×</option><option value="5">5×</option><option value="Infinity">∞</option></select></label>
      <select class="right" title="播放引擎" aria-label="播放引擎" value=${st.engine} onChange=${(e) => player.useEngine(e.target.value)} style="padding:3px 6px">${engines.map((k) => html`<option value=${k}>${ENGINE[k]}</option>`)}</select>
    </div>
    ${children}
  </div>`;
}
