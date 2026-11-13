// 转录记录器（内容脚本里用）：把"当前字幕"变成按视频保存的转录。
//  · 字幕轨道：整条轨道已载入 → loadAll 一次性载入全部句子（侧边栏立刻看到整部剧）；
//  · 网站 DOM 字幕：每句稳定后 observe 一次（边播边记）；循环播放时认出已有的句子，不重复记录；
//  · 译文：attach 给所有同文的句子补上；
//  · take() 取走变化的行，由控制器定时发给后台保存。
import { norm, findMatch, lineId, mergeLines } from './transcript.js';

export class Recorder {
  constructor() { this.reset(null); }
  reset(meta) { this.meta = meta; this.lines = []; this.dirty = new Set(); this.loadedTrack = ''; }

  /** 载入已保存的转录（不算"变化"） */
  load(lines) { this.lines = mergeLines([], lines || []); }

  /** 字幕轨道的全部句子：cues = [{start,end,text}]。已有的（含译文）保留 */
  loadAll(cues, lang) {
    const incoming = cues.filter((c) => norm(c.text)).map((c) => ({ id: `t${Math.round(c.start * 1000)}`, start: c.start, end: c.end, text: c.text, lang }));
    const before = new Map(this.lines.map((l) => [l.id, l.end + '|' + l.text]));
    this.lines = mergeLines(this.lines, incoming);
    for (const l of this.lines) if (!before.has(l.id) || before.get(l.id) !== l.end + '|' + l.text) this.dirty.add(l.id);
  }

  /** 用整份新的转录替换（YouTube 转写整理好之后）：旧的网站字幕记录作废，已有的译文按文字沿用 */
  replaceAll(lines) {
    const old = new Map(this.lines.filter((l) => l.tr).map((l) => [norm(l.text), l.tr]));
    this.lines = mergeLines([], lines.map((l) => ({ ...l, tr: old.get(norm(l.text)) || l.tr })));
    this.dirty = new Set(this.lines.map((l) => l.id));
    this.loadedTrack = 'replaced';
  }

  /** 网站字幕稳定下来的一句：返回它的 id（已有的就复用） */
  observe(text, t, lang) {
    const i = findMatch(this.lines, text, t);
    if (i >= 0) { const l = this.lines[i]; if (t > l.end) { l.end = t; this.dirty.add(l.id); } return l.id; }
    // 滚动字幕：新句子以上一句为开头（上一句只是还没说完）→ 直接延长上一句
    const prev = this.lines.filter((l) => l.start <= t && t - l.end < 2).at(-1);
    if (prev && norm(text).startsWith(norm(prev.text)) && prev.id.startsWith('d')) { prev.text = text; prev.end = t; delete prev.tr; this.dirty.add(prev.id); return prev.id; }
    const l = { id: lineId('d', t, new Set(this.lines.map((x) => x.id))), start: t, end: t, text, lang };
    this.lines = mergeLines(this.lines, [l]);
    this.dirty.add(l.id);
    return l.id;
  }

  /** 当前句还在显示：把结束时间推到 t */
  touch(id, t) { const l = this.lines.find((x) => x.id === id); if (l && t > l.end) { l.end = t; this.dirty.add(id); } }

  /** 译文回来了：补给所有同文的句子 */
  attach(text, tr) {
    const n = norm(text);
    for (const l of this.lines) if (norm(l.text) === n) { l.tr = { ...l.tr, ...tr }; this.dirty.add(l.id); }
  }

  /** 此刻 t 对应的句子 id（字幕轨道：时间落在哪句；找不到返回 ''） */
  idAt(t) { const l = this.lines.find((x) => t >= x.start && t < x.end); return l?.id || ''; }

  /** 缺少某些目标语言译文的句子 */
  missing(targets) { return this.lines.filter((l) => targets.some((t) => !l.tr?.[t])); }

  /** 取走变化的行（同时清空标记） */
  take() { const out = this.lines.filter((l) => this.dirty.has(l.id)); this.dirty.clear(); return out; }
  get hasDirty() { return this.dirty.size > 0; }
}
