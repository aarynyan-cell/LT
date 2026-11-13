// YouTube 转写：直接取视频自带的字幕数据（比屏幕上滚动的字幕准确、完整），整理成与播放进度对齐的句子。
// 取法（依次尝试，任何一步失败就换下一个）：
//   1. 向页面里的小脚本（yt-main.js，运行在页面自己的世界）要播放器的字幕轨道列表 → 取 timedtext（json3，其次 XML）；
//   2. 页面脚本拿不到时，直接请求本视频的页面 HTML，从里面取 "captionTracks"；
//   3. timedtext 取不到（返回空内容）时，打开页面自带的"转写文字"面板，读里面的每一行（带时间）。
// ⚠️ 这些都是 YouTube 的内部结构，网站改动会失效；失效时控制器会退回到读取屏幕字幕。
import { parseJson3, parseXml, cuesFromPanel, parseTimestamp, extractCaptionTracksFromHtml, pickTrack, withFormat, isYouTubeUrl } from './captions.js';
import { cuesToSentences } from './segment.js';
import { detectLang } from './langs.js';

export const isYouTubeHost = (host) => /(^|\.)youtube(-nocookie)?\.com$/.test(host || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 向 MAIN 世界的脚本要播放器数据（页面里的变量，内容脚本直接读不到） */
export function askPlayerData(win, videoId, timeout = 1500) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const done = (v) => { win.removeEventListener('message', on); clearTimeout(timer); resolve(v); };
    const on = (e) => { if (e.source === win && e.data?.type === 'lectureloop:yt-data' && e.data.id === id) done(e.data.payload); };
    const timer = setTimeout(() => done(null), timeout);
    win.addEventListener('message', on);
    win.postMessage({ type: 'lectureloop:yt-request', id, videoId }, '*');
  });
}

async function fetchCues(baseUrl, fetchFn) {
  for (const fmt of ['json3', null]) {
    let text = '';
    try { const r = await fetchFn(withFormat(baseUrl, fmt), { credentials: 'include' }); if (!r.ok) continue; text = await r.text(); } catch { continue; }
    if (!text.trim()) continue; // 空内容：YouTube 有时要求播放器才有的校验参数
    let cues = [];
    try { cues = parseJson3(JSON.parse(text)); } catch { cues = parseXml(text); }
    if (cues.length) return cues;
  }
  return [];
}

/** 播放器自己请求过本视频的字幕（打开 CC 时）：它的地址带着播放器才有的校验参数，直接复用 */
export function observedTimedtextUrl(win, videoId) {
  try {
    const e = win.performance.getEntriesByType('resource').filter((x) => x.name.includes('timedtext') && x.name.includes(`v=${videoId}`) && isYouTubeUrl(x.name));
    return e.length ? e[e.length - 1].name : '';
  } catch { return ''; }
}

/** 打开页面自带的"转写文字"面板并读出每一行；读完把面板关回去 */
// YouTube 正在把组件迁移成 view-model：新旧两种结构都认
const SEG = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
const TS = '.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp, [class*="TranscriptSegmentViewModelTimestamp"]';
const TX = '.segment-text, .yt-core-attributed-string, [class*="TranscriptSegmentViewModelText"]';
const TX_BTN = /transcript|transcription|转写|转录|文字记录|transcripción/i;
export async function scrapePanel(doc, { wait = 6000 } = {}) {
  let opened = false;
  if (!doc.querySelector(SEG)) {
    let btn = doc.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) btn = [...doc.querySelectorAll('#description button, ytd-watch-metadata button, #above-the-fold button')].find((b) => TX_BTN.test(b.getAttribute('aria-label') || '') || TX_BTN.test(b.textContent || ''));
    if (!btn) return [];
    btn.click(); opened = true;
    for (let t = 0; t < wait && !doc.querySelector(SEG); t += 200) await sleep(200);
  }
  const rows = [...doc.querySelectorAll(SEG)].map((el) => ({
    t: parseTimestamp(el.querySelector(TS)?.textContent),
    text: el.querySelector(TX)?.textContent || '',
  }));
  if (opened) doc.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button, [target-id="engagement-panel-searchable-transcript"] [aria-label="Close"], [target-id="engagement-panel-searchable-transcript"] #visibility-button button')?.click();
  return cuesFromPanel(rows);
}

/**
 * 取并整理本视频的转写。
 * @returns {{ lines, lang, kind: 'manual'|'asr'|'panel', name, words }}  lines：[{ id, start, end, text, lang }]
 * @throws Error  没有可用的转写（message 说明原因）
 */
export async function loadYouTubeTranscript({ win, doc, videoId, settings = {}, fetchFn = (u, i) => win.fetch(u, i) }) {
  const origin = win.location.origin;
  let tracks = [];
  const data = await askPlayerData(win, videoId);
  if (data?.videoId === videoId && data.tracks?.length) tracks = data.tracks;
  if (!tracks.length) { // 页面脚本没响应 / 数据过期（单页应用里切了视频）：直接取本视频的页面
    try { const r = await fetchFn(`${origin}/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' }); if (r.ok) tracks = extractCaptionTracksFromHtml(await r.text()); } catch { /* 下面走面板 */ }
  }
  tracks = tracks.map((t) => ({ ...t, baseUrl: t.baseUrl && new URL(t.baseUrl, origin).toString() })).filter((t) => isYouTubeUrl(t.baseUrl));
  const choice = pickTrack(tracks, { source: settings.source || 'auto' });

  let cues = [], kind = choice?.kind, lang = choice?.lang, name = choice?.name || '';
  if (choice) cues = await fetchCues(choice.track.baseUrl, fetchFn);
  if (!cues.length) { // 轨道地址取不到：试试播放器自己请求过的地址
    const seen = observedTimedtextUrl(win, videoId);
    if (seen) { cues = await fetchCues(seen, fetchFn); if (cues.length) { const l = new URL(seen).searchParams.get('lang') || ''; kind ||= new URL(seen).searchParams.get('kind') === 'asr' ? 'asr' : 'manual'; lang ||= l.slice(0, 2).toLowerCase() || undefined; name = '播放器请求过的字幕'; } }
  }
  if (!cues.length) { // 轨道列表里没有 / 取到的是空的：读"转写文字"面板
    cues = await scrapePanel(doc);
    if (cues.length) { kind = 'panel'; name = '转写文字面板'; lang = settings.source && settings.source !== 'auto' ? settings.source : null; }
  }
  if (!cues.length) throw new Error(tracks.length ? '字幕数据取不到（YouTube 返回了空内容）' : '这个视频没有可用的转写或字幕');

  lang ||= detectLang(cues.slice(0, 40).map((c) => c.text).join(' ')) || 'en';
  const sentences = cuesToSentences(cues, lang);
  if (!sentences.length) throw new Error('转写里没有可用的文字');
  const lines = sentences.map((s) => ({ id: `t${Math.round(s.start * 1000)}`, start: s.start, end: s.end, text: s.text, lang }));
  return { lines, lang, kind, name, words: cues.reduce((n, c) => n + (c.words?.length || c.text.split(/\s+/).length), 0) };
}
