// 字幕稳定器：网站的字幕有两种更新方式——
//   整句一次出现（Netflix / 字幕轨道）：很快就能翻译；
//   滚动增长（YouTube 自动字幕，一个词一个词往后加）：等它停下来再翻译，否则每个词都翻译一次。
// push(text) 返回立刻要显示的原文；settle 回调在文本稳定后触发。无定时器依赖以外的状态，便于测试（可注入 setTimeout）。
export class Stabilizer {
  constructor({ onSettle, quickMs = 90, rollingMs = 550, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } }) {
    this.onSettle = onSettle; this.quickMs = quickMs; this.rollingMs = rollingMs; this.t = timers;
    this.text = ''; this.timer = null; this.settled = '';
  }
  /** rollingHint：来源已知是滚动字幕（如 YouTube 自动字幕）时为 true */
  push(text, rollingHint = false) {
    text = String(text || '').trim();
    if (text === this.text) return this.text;
    const prev = this.text;
    this.text = text;
    this.t.clear(this.timer);
    this.timer = null;
    if (!text) return text;
    // 新文本以旧文本开头（或旧文本以新文本开头）= 滚动增长中
    const rolling = rollingHint || !!prev && (text.startsWith(prev) || prev.startsWith(text) || sharedPrefix(prev, text) >= Math.min(prev.length, text.length) * 0.6);
    this.timer = this.t.set(() => { this.timer = null; this.settled = this.text; this.onSettle(this.text); }, rolling ? this.rollingMs : this.quickMs);
    return text;
  }
  clear() { this.t.clear(this.timer); this.timer = null; this.text = ''; this.settled = ''; }
}
function sharedPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
