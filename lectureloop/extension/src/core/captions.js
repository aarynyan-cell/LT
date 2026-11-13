// 字幕数据解析（纯函数）：YouTube 的 timedtext（json3 / XML）、网页里的"转写文字"面板、播放器数据里的字幕轨道列表。
// 统一输出 cue：{ start, end, text, words?: [{ w, t }] }；ASR（自动生成）的 json3 带逐词时间，后面据此精确断句。

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[e.toLowerCase()] ?? m;
});
/** YouTube 的 XML 里文字常被编码两次（&amp;#39;），解两次 */
const decode2 = (s) => decodeEntities(decodeEntities(s)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); // 解码后可能露出 <i>…</i> 之类的标签，一并去掉

/** json3：{ events:[{ tStartMs, dDurationMs, segs:[{ utf8, tOffsetMs? }] }] } */
export function parseJson3(data) {
  const cues = [];
  for (const ev of data?.events || []) {
    if (!Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue; // 只有换行的事件
    const start = (ev.tStartMs || 0) / 1000, end = start + (ev.dDurationMs || 0) / 1000;
    const timed = ev.segs.some((s) => typeof s.tOffsetMs === 'number' && s.tOffsetMs > 0);
    const cue = { start, end: Math.max(end, start + 0.2), text };
    if (timed) {
      cue.words = [];
      for (const s of ev.segs) {
        const toks = String(s.utf8 || '').trim().split(/\s+/).filter(Boolean);
        toks.forEach((w, i) => cue.words.push({ w, t: start + ((s.tOffsetMs || 0) + i * 120) / 1000 }));
      }
    }
    cues.push(cue);
  }
  return cues;
}

/** XML：<transcript><text start="1.2" dur="3.4">…</text></transcript>（srv1）或 <timedtext><body><p t="1200" d="3400"><s t="0">hello</s>…（srv3） */
export function parseXml(xml) {
  const cues = [];
  const s = String(xml || '');
  if (/<p\s[^>]*\bt="/.test(s)) {
    for (const m of s.matchAll(/<p\s+([^>]*)>([\s\S]*?)<\/p>/g)) {
      const at = (k) => { const r = new RegExp(`\\b${k}="(\\d+)"`).exec(m[1]); return r ? +r[1] : null; };
      const t0 = at('t'), d = at('d');
      if (t0 == null) continue;
      const start = t0 / 1000;
      const segs = [...m[2].matchAll(/<s(?:\s+([^>]*))?>([\s\S]*?)<\/s>/g)];
      const text = decode2(segs.length ? segs.map((x) => x[2]).join('') : m[2]);
      if (!text) continue;
      const cue = { start, end: start + (d || 0) / 1000 || start + 2, text };
      if (segs.length > 1) {
        cue.words = [];
        for (const x of segs) { const off = /\bt="(\d+)"/.exec(x[1] || ''); const w = decode2(x[2]); if (w) cue.words.push({ w, t: start + (off ? +off[1] : 0) / 1000 }); }
      }
      cues.push(cue);
    }
    return cues;
  }
  for (const m of s.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/g)) {
    const st = /\bstart="([\d.]+)"/.exec(m[1]), du = /\bdur="([\d.]+)"/.exec(m[1]);
    if (!st) continue;
    const text = decode2(m[2]);
    if (!text) continue;
    const start = +st[1];
    cues.push({ start, end: start + (du ? +du[1] : 2), text });
  }
  return cues;
}

/** 网页"转写文字"面板：[{ t: 秒, text }]（只有每段的开始时间；结束 = 下一段开始） */
export function cuesFromPanel(items) {
  const rows = items.filter((x) => Number.isFinite(x.t) && x.text?.trim()).sort((a, b) => a.t - b.t);
  return rows.map((r, i) => ({ start: r.t, end: Math.max(r.t + 0.5, rows[i + 1]?.t ?? r.t + 5), text: r.text.replace(/\s+/g, ' ').trim() }));
}
/** "1:23" / "1:02:03" → 秒 */
export function parseTimestamp(s) {
  const p = String(s || '').trim().split(':').map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}

/** 从 YouTube 页面 HTML 里取字幕轨道列表（"captionTracks":[…]）。括号配对，容忍字符串里的括号 */
export function extractCaptionTracksFromHtml(html) {
  const i = String(html).indexOf('"captionTracks":');
  if (i < 0) return [];
  const a = html.indexOf('[', i);
  if (a < 0) return [];
  let depth = 0, inStr = false, esc = false;
  for (let k = a; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) { try { return JSON.parse(html.slice(a, k + 1)); } catch { return []; } }
  }
  return [];
}

const trackName = (t) => (typeof t.name === 'string' ? t.name : t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || '');
/**
 * 选字幕轨道。tracks：{ baseUrl, languageCode, kind?: 'asr', name }。
 * 优先：与自动生成轨道同语言的"人工字幕"（最准）> 自动生成轨道（语言 = 视频里说的语言）> 第一条人工字幕。
 * 用户指定了字幕语言时，只在这个语言里选。返回 { track, lang, kind } 或 null。
 */
export function pickTrack(tracks, { source = 'auto' } = {}) {
  const list = (tracks || []).filter((t) => t?.baseUrl && t.languageCode);
  const lang = (t) => t.languageCode.slice(0, 2).toLowerCase();
  const pool = source !== 'auto' ? list.filter((t) => lang(t) === source) : list;
  if (!pool.length) return null;
  const asr = pool.find((t) => t.kind === 'asr');
  const manual = pool.filter((t) => t.kind !== 'asr');
  const pick = (asr && manual.find((t) => lang(t) === lang(asr))) || asr || manual[0];
  return { track: pick, lang: lang(pick), kind: pick.kind === 'asr' ? 'asr' : 'manual', name: trackName(pick) };
}

/** 在 baseUrl 上指定格式（替换已有的 fmt） */
export function withFormat(url, fmt) {
  const u = new URL(url);
  if (fmt) u.searchParams.set('fmt', fmt); else u.searchParams.delete('fmt');
  return u.toString();
}
/** 只允许从 youtube.com 取字幕（页面脚本可以伪造消息，不能让我们去请求任意地址） */
export const isYouTubeUrl = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && /(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname); } catch { return false; } };
