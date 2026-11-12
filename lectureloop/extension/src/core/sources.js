// 字幕来源：从网页里读出"此刻正在显示的字幕文字"。优先级：用户手动选取 > 已知网站 > 视频字幕轨道（TextTrack）。
// 所有来源都用 read() 轮询取当前文字（约 150ms 一次），不依赖网站内部事件，也不改页面 DOM。
// ⚠️ 已知网站的选择器来自公开的页面结构，网站改版会失效——失效时用"选取字幕位置"即可。

export const ADAPTERS = [
  { id: 'youtube', label: 'YouTube 字幕', host: /(^|\.)youtube(-nocookie)?\.com$/, sel: '.ytp-caption-segment', hide: '.ytp-caption-window-container', rollingSel: '.ytp-caption-window-rollup' },
  { id: 'netflix', label: 'Netflix 字幕', host: /(^|\.)netflix\.com$/, sel: '.player-timedtext-text-container', hide: '.player-timedtext' },
  { id: 'prime', label: 'Prime Video 字幕', host: /(^|\.)(primevideo\.com|amazon\.[a-z.]+)$/, sel: '.atvwebplayersdk-captions-text', hide: '.atvwebplayersdk-captions-overlay' },
  { id: 'bilibili', label: '哔哩哔哩字幕', host: /(^|\.)bilibili\.com$/, sel: '.bpx-player-subtitle-panel-text', hide: '.bpx-player-subtitle-wrap' },
];

const clean = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const cleanCueText = clean;

/** 元素里的文字：叶子节点的文字用空格拼起来（Netflix 的两行是并排的 span，直接 textContent 会粘在一起） */
export function leafText(el) {
  const kids = el.querySelectorAll('*');
  if (!kids.length) return clean(el.textContent);
  const out = [];
  for (const k of kids) if (!k.firstElementChild && k.textContent.trim()) out.push(k.textContent);
  return clean(out.length ? out.join(' ') : el.textContent);
}

/** 当前页面里最像"正在播放的视频"的 <video>：可见面积最大，播放中的加权 */
export function pickVideo(doc) {
  let best = null, score = 0;
  for (const v of doc.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) continue;
    const s = r.width * r.height * (v.paused ? 1 : 2);
    if (s > score) { best = v; score = s; }
  }
  return best;
}

function domCandidate({ id, label, sel, hide, rollingSel }, doc) {
  return {
    id, label, hide: hide || sel,
    read() {
      let els;
      try { els = doc.querySelectorAll(sel); } catch { return null; }
      if (!els.length) return null;
      const seen = new Set(), parts = [];
      for (const e of els) { const t = leafText(e); if (t && !seen.has(t)) { seen.add(t); parts.push(t); } }
      if (!parts.length) return null;
      return { text: parts.join(' '), lang: null, video: pickVideo(doc), rolling: !!(rollingSel && doc.querySelector(rollingSel)) };
    },
  };
}

const bestTrack = (tracks, source) => (source && source !== 'auto' && tracks.find((t) => (t.language || '').toLowerCase().startsWith(source))) || tracks[0];

function textTrackCandidate(doc, settings, saved) {
  return {
    id: 'texttrack', label: '视频字幕轨道',
    /** 选出当前使用的轨道（没有启用的轨道时，按语言启用一条为 hidden：只读文字，不改变画面） */
    track(video) {
      const tracks = Array.from(video?.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
      if (!tracks.length) return null;
      let active = tracks.filter((t) => t.mode !== 'disabled');
      if (!active.length) { const t = bestTrack(tracks, settings.source); saved.set(t, t.mode); t.mode = 'hidden'; active = [t]; }
      return active.find((t) => t.mode === 'showing') || active[0];
    },
    read() {
      const video = pickVideo(doc);
      const track = video && this.track(video);
      if (!track) return null;
      if (settings.hideSite && track.mode === 'showing') { saved.set(track, 'showing'); track.mode = 'hidden'; } // 隐藏网站自带字幕 = 原生渲染的轨道改成 hidden
      const text = Array.from(track.activeCues || []).map((c) => clean(c.text)).filter(Boolean).join(' ');
      return text ? { text, lang: (track.language || '').slice(0, 2).toLowerCase() || null, video, rolling: false } : null;
    },
    /** 整条轨道的全部句子（侧边栏转录用）：轨道已经载入且不止几句时才有。sig 变化说明轨道换了/又载入了新内容 */
    allCues() {
      const video = pickVideo(doc);
      const track = video && this.track(video);
      const cues = track?.cues;
      if (!cues || cues.length < 3) return null;
      const list = [];
      for (let i = 0; i < cues.length; i++) { const text = clean(cues[i].text); if (text) list.push({ start: cues[i].startTime, end: cues[i].endTime, text }); }
      return { sig: `${track.language}|${track.label}|${cues.length}`, lang: (track.language || '').slice(0, 2).toLowerCase() || null, cues: list };
    },
    /** 即将出现的字幕（预翻译用）：整条轨道已经载入时才有 */
    upcoming(n = 30, ahead = 90) {
      const video = pickVideo(doc);
      const track = video && this.track(video);
      const cues = track?.cues;
      if (!cues || cues.length < 3) return [];
      const t = video.currentTime, out = [];
      for (let i = 0; i < cues.length && out.length < n; i++) {
        const c = cues[i];
        if (c.endTime < t - 0.5) continue;
        if (c.startTime > t + ahead) break;
        const text = clean(c.text);
        if (text) out.push({ text, start: c.startTime, prev: i > 0 ? clean(cues[i - 1].text) : '' });
      }
      return out;
    },
    restore() { for (const [t, m] of saved) { try { t.mode = m; } catch { /* 轨道已移除 */ } } saved.clear(); },
  };
}

/** 候选来源（按优先级）。picked 是用户在这个网站上手动选取的选择器列表 */
export function buildSources(doc, settings, site) {
  const saved = new Map();
  const list = [];
  const picked = (settings.pickers?.[site] || []).filter(Boolean);
  if (picked.length) list.push(domCandidate({ id: 'picker', label: '手动选取的字幕位置', sel: picked.join(', ') }, doc));
  for (const a of ADAPTERS) if (a.host.test(site)) list.push(domCandidate(a, doc));
  const tt = textTrackCandidate(doc, settings, saved);
  list.push(tt);
  return { list, textTrack: tt, hideSelectors: list.filter((c) => c.hide).map((c) => c.hide) };
}

/** 依次尝试，返回第一个有文字的来源：{ id, label, text, lang, video, rolling } */
export function readFirst(sources) {
  for (const c of sources.list) {
    const r = c.read();
    if (r?.text) return { id: c.id, label: c.label, ...r };
  }
  return null;
}

/** 把视频跳到 t 秒（可选播放）。没有视频返回 false */
export function seekTo(doc, t, play = false) {
  const v = pickVideo(doc);
  if (!v) return false;
  v.currentTime = Math.max(0, t);
  if (play) v.play?.().catch(() => {});
  return true;
}
