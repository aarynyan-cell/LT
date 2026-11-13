// 音频处理（纯函数，Node 与浏览器通用）：重采样到 16 kHz、按停顿切块、编码 WAV。
// 语音识别服务按"一小段一小段的音频文件"识别：这里把连续的音频流切成"一句话一块"，在停顿处断开，
// 并记住每一块在视频里的时间，这样识别结果能对上播放进度。

/** 流式重采样（盒式平均，够用且抗混叠）：输入任意采样率 → 输出 outRate */
export class Resampler {
  constructor(inRate, outRate = 16000) { this.ratio = inRate / outRate; this.tail = new Float32Array(0); this.pos = 0; }
  process(input) {
    const buf = new Float32Array(this.tail.length + input.length);
    buf.set(this.tail); buf.set(input, this.tail.length);
    const out = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const a = Math.floor(pos), b = Math.max(a + 1, Math.floor(pos + this.ratio));
      let s = 0;
      for (let i = a; i < b; i++) s += buf[i];
      out.push(s / (b - a));
      pos += this.ratio;
    }
    const used = Math.floor(pos);
    this.tail = buf.slice(used);
    this.pos = pos - used;
    return Float32Array.from(out);
  }
}

export const rms = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / (f.length || 1)); };

/**
 * 切块器：push(采样, 这段采样在视频里的开始时间, 播放倍速) → 通过 onChunk 吐出 { pcm: Float32Array, start, end, speechSec, rate }。
 *  · 用能量判断有没有人在说话（噪声底自适应），只在"有人说话"时开始一块（带 0.25 秒前导）；
 *  · 停顿 ≥ silenceSec 且已满 minSec 就断开；单块最长 maxSec；太短、几乎没有语音的块丢掉；
 *  · start/end 是视频时间（倍速播放时 1 秒音频 = rate 秒视频）。
 */
export class Chunker {
  constructor({ sr = 16000, frame = 0.02, minSec = 2.2, maxSec = 12, silenceSec = 0.45, shortSilence = 1.1, preRoll = 0.25, minSpeech = 0.45, onChunk }) {
    Object.assign(this, { sr, minSec, maxSec, silenceSec, shortSilence, preRoll, minSpeech, onChunk });
    this.fs = Math.round(sr * frame); this.frameSec = this.fs / sr;
    this.rest = new Float32Array(0); this.restStart = 0;
    this.noise = 0.004; this.pre = []; this.cur = null;
  }
  reset() { this.rest = new Float32Array(0); this.pre = []; this.cur = null; }
  push(samples, mediaStart, rate = 1) {
    // 与上次剩下的半帧拼起来
    const buf = new Float32Array(this.rest.length + samples.length);
    buf.set(this.rest); buf.set(samples, this.rest.length);
    const t0 = this.rest.length ? this.restStart : mediaStart;
    let i = 0;
    for (; i + this.fs <= buf.length; i += this.fs) this._frame(buf.subarray(i, i + this.fs), t0 + (i / this.sr) * rate, rate);
    this.rest = buf.slice(i); this.restStart = t0 + (i / this.sr) * rate;
  }
  _frame(f, t, rate) {
    const e = rms(f);
    const speech = e > Math.max(0.012, this.noise * 2.6);
    if (!speech) this.noise = e < this.noise ? this.noise * 0.9 + e * 0.1 : this.noise * 1.0006 + e * 0.0004; // 噪声底：往下快、往上慢
    if (!this.cur) {
      if (!speech) { this.pre.push(f); if (this.pre.length > Math.ceil(this.preRoll / this.frameSec)) this.pre.shift(); return; }
      const frames = [...this.pre, f];
      this.cur = { frames, start: t - this.pre.length * this.frameSec * rate, speechFrames: 1, silentRun: 0, rate };
      this.pre = [];
      return;
    }
    const c = this.cur;
    c.frames.push(f);
    if (speech) { c.speechFrames++; c.silentRun = 0; } else c.silentRun += this.frameSec;
    const dur = c.frames.length * this.frameSec;
    if (dur >= this.maxSec || (dur >= this.minSec && c.silentRun >= this.silenceSec) || c.silentRun >= this.shortSilence) this._cut();
  }
  _cut() {
    const c = this.cur; this.cur = null;
    if (!c) return;
    const speechSec = c.speechFrames * this.frameSec;
    // 去掉结尾多余的静音（最多留 0.2 秒）
    let n = c.frames.length;
    const keep = Math.ceil(0.2 / this.frameSec), trail = Math.floor(c.silentRun / this.frameSec);
    if (trail > keep) n -= trail - keep;
    if (speechSec < this.minSpeech) return;
    const pcm = new Float32Array(n * this.fs);
    for (let k = 0; k < n; k++) pcm.set(c.frames[k], k * this.fs);
    this.onChunk({ pcm, start: c.start, end: c.start + (pcm.length / this.sr) * c.rate, speechSec, rate: c.rate });
  }
  /** 视频跳转 / 暂停 / 结束：把已经攒下的这一块吐出去 */
  flush() { this._cut(); this.pre = []; this.rest = new Float32Array(0); }
}

/** Float32（-1..1）→ 16 位 PCM 的 WAV（单声道） */
export function encodeWav(f32, sr = 16000) {
  const n = f32.length, out = new Uint8Array(44 + n * 2), dv = new DataView(out.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return out;
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
