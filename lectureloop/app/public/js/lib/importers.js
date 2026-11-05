// 导入器：txt / md / docx / srt / vtt → 草稿 Lesson（含 cues、parts、时间轴类型）。纯函数 + 一个异步读取入口。
import { buildCues, estimateTimeline, segmentParts, units, normalize } from './text.js';
import { readDocxParagraphs } from './zip.js';
import { titleParts } from './heuristics.js';

/**
 * 从文件名/标题行解析 日期、课程、标题。
 * "1008-bioinfo & omics_ Porte d'Issy 5" → { date:'2026-10-08', course:'bioinfo & omics', title:"Porte d'Issy 5" }
 */
export function parseFilename(raw, now = new Date()) {
  let s = String(raw || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/^[0-9a-f]{8}-(?=\d{4})/i, '').trim();
  const m = s.match(/^(\d{2})(\d{2})(?:\d{4})?[-_ ]+(.+)$/);
  let date = null;
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = now.getFullYear();
      if (new Date(y, mo - 1, d) > new Date(now.getTime() + 2 * 86400000)) y -= 1;
      date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      s = m[3];
    }
  }
  const clean = (x) => x.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(/__+|_ | [-–—] /).map(clean).filter(Boolean);
  if (parts.length >= 2) return { date, course: parts.slice(0, -1).join(' '), title: parts.at(-1) };
  return { date, course: clean(s), title: '' };
}

/** SRT / VTT → [{start,end,text}] */
export function parseCaptions(text) {
  const out = [];
  const t = (h, m, s, ms) => (+h || 0) * 3600 + +m * 60 + +s + +ms / 1000;
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(Boolean);
    const k = lines.findIndex((l) => l.includes('-->'));
    if (k < 0) continue;
    const m = lines[k].match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const body = lines.slice(k + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) out.push({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: body });
  }
  return out;
}

const looksLikeTitle = (p, total) => total > 1 && p.length <= 90 && units(p) <= 12 && !/[.?!。？！]$/.test(p);

/**
 * 读取文件内容。name: 文件名；buf: ArrayBuffer/Uint8Array。
 * @returns {{kind, paragraphs, timed, titleLine}}
 */
export async function readTranscript(name, buf) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'txt').toLowerCase();
  if (ext === 'docx') {
    const paragraphs = await readDocxParagraphs(buf);
    return withTitle({ kind: 'docx', paragraphs, timed: null });
  }
  const text = new TextDecoder('utf-8').decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).replace(/^﻿/, '');
  if (ext === 'srt' || ext === 'vtt' || /-->/.test(text.slice(0, 2000))) {
    const timed = parseCaptions(text);
    if (timed.length) return { kind: ext === 'vtt' ? 'vtt' : 'srt', paragraphs: [], timed, titleLine: '' };
  }
  const paragraphs = text.split(/\n\s*\n|\n/).map(normalize).filter(Boolean);
  return withTitle({ kind: 'text', paragraphs, timed: null });
}

function withTitle(r) {
  let titleLine = '';
  if (r.paragraphs.length && looksLikeTitle(r.paragraphs[0], r.paragraphs.length)) titleLine = r.paragraphs.shift();
  return { ...r, titleLine };
}

/**
 * 生成草稿：断句 → 时间轴（真实/估算）→ 分 Part → Part 标题。
 * @param {{name:string, kind, paragraphs, timed, titleLine}} src
 * @param {{lang?:string, audioDuration?:number, wpm?:number}} opts
 */
export function buildDraft(src, { lang = 'en', audioDuration = 0, wpm = 150 } = {}) {
  const meta = parseFilename(src.titleLine || src.name);
  let cues, duration, timeline;
  if (src.timed?.length) {
    cues = src.timed.map((c, i) => ({ i, start: c.start, end: c.end, text: normalize(c.text) }));
    duration = Math.max(audioDuration, cues.at(-1).end);
    timeline = 'real';
  } else {
    cues = buildCues(src.paragraphs);
    duration = estimateTimeline(cues, { wpm, duration: audioDuration });
    timeline = 'estimated';
  }
  const parts = titleParts(cues, segmentParts(cues));
  const words = Math.round(cues.reduce((s, c) => s + units(c.text), 0));
  return {
    title: meta.title || meta.course || src.name.replace(/\.[a-z0-9]+$/i, ''),
    course: meta.course,
    date: meta.date,
    srcLang: lang,
    cues,
    parts,
    duration,
    timeline,
    stats: { sentences: cues.length, words, minutes: Math.round(duration / 60), hadTitleLine: !!src.titleLine },
  };
}

/** 粗略猜测文本语种：zh / fr / en */
export function guessLang(text) {
  const s = text.slice(0, 4000);
  const cjk = (s.match(/[㐀-鿿]/g) || []).length;
  if (cjk > s.length * 0.2) return 'zh';
  const fr = (s.match(/\b(le|la|les|des|est|que|pour|une|dans|nous|vous|et)\b/gi) || []).length;
  const en = (s.match(/\b(the|and|is|that|of|to|you|we|it)\b/gi) || []).length;
  return fr > en * 0.8 ? 'fr' : 'en';
}

/** 读取音频文件时长（秒），失败返回 0 */
export function readAudioDuration(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 6000);
    a.src = url;
  });
}
