// 播放器：三种引擎（录音 / TTS 逐句朗读 / 静音计时器）+ 控制器（倍速、A-B 循环、逐句重复、按句跳转）。
// 控制器用 requestAnimationFrame 轮询时间（比 timeupdate 精确得多，循环边界误差 < 50ms）。
import { cueAt } from './text.js';
import { clamp } from './util.js';
import { pickVoice, chunkForTts } from './voices.js';

export const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];
const TTS_LANG = { en: 'en-US', fr: 'fr-FR', zh: 'zh-CN' };

// ---------- 引擎 ----------
class AudioEngine {
  kind = 'audio';
  constructor(blob, hint = 0) {
    this.el = new Audio();
    this.url = URL.createObjectURL(blob);
    this.el.src = this.url;
    this.el.preload = 'auto';
    this.el.preservesPitch = this.el.mozPreservesPitch = this.el.webkitPreservesPitch = true; // 变速不变调
    this.hint = hint;
    this.duration = 0;
  }
  async ready() {
    await new Promise((res) => {
      this.el.addEventListener('loadedmetadata', res, { once: true });
      this.el.addEventListener('error', res, { once: true });
      setTimeout(res, 4000);
    });
    // MediaRecorder 录出的 webm 没有时长（Infinity）：跳到末尾强制浏览器计算
    if (!isFinite(this.el.duration)) {
      try {
        this.el.currentTime = 1e7;
        await new Promise((r) => { this.el.addEventListener('timeupdate', r, { once: true }); setTimeout(r, 1500); });
        this.el.currentTime = 0;
      } catch { /* ignore */ }
    }
    const d = this.el.duration;
    this.duration = isFinite(d) && d > 0 ? d : this.hint;
  }
  get time() { return this.el.currentTime; }
  get playing() { return !this.el.paused && !this.el.ended; }
  play() { return this.el.play().catch(() => {}); }
  pause() { this.el.pause(); }
  seek(t) { this.el.currentTime = clamp(t, 0, this.duration || t); }
  setRate(r) { this.el.playbackRate = r; }
  dispose() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); URL.revokeObjectURL(this.url); }
}

class TtsEngine {
  kind = 'tts';
  constructor(cues, lang, duration, voice) {
    this.cues = cues; this.lang = TTS_LANG[lang] || 'en-US'; this.duration = duration; this.voice = voice;
    this.rate = 1; this._playing = false; this._t = 0; this.idx = 0; this.token = 0; this.t0 = 0;
  }
  async ready() {}
  get playing() { return this._playing; }
  get time() {
    if (!this._playing) return this._t;
    const c = this.cues[this.idx];
    const el = ((performance.now() - this.t0) / 1000) * this.rate;
    return Math.min(c.start + el, Math.max(c.start, c.end - 0.001));
  }
  _speak(i) {
    const my = ++this.token; // 先递增再 cancel：旧 utterance 的回调会因 token 不符被忽略
    speechSynthesis.cancel();
    if (i >= this.cues.length) { this._playing = false; this._t = this.duration; return; }
    this.idx = i; this.t0 = performance.now();
    // 远程（在线）语音在约 15 秒后会截断过长的句子：分成小段依次朗读
    const chunks = this.voice && this.voice.localService === false ? chunkForTts(this.cues[i].text) : [this.cues[i].text];
    const speakChunk = (k) => {
      if (my !== this.token || !this._playing) return;
      if (k >= chunks.length) return this._speak(i + 1);
      const u = new SpeechSynthesisUtterance(chunks[k]);
      u.lang = this.voice?.lang || this.lang; u.rate = clamp(this.rate, 0.5, 2);
      if (this.voice) u.voice = this.voice;
      const next = () => speakChunk(k + 1);
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    speakChunk(0);
  }
  play() { this._playing = true; this._speak(cueAt(this.cues, this._t)); }
  pause() { this._t = this.time; this._playing = false; this.token++; speechSynthesis.cancel(); }
  seek(t) { this._t = clamp(t, 0, this.duration); this.idx = cueAt(this.cues, this._t); if (this._playing) this._speak(this.idx); }
  setRate(r) { this.rate = r; if (this._playing) this._speak(this.idx); }
  dispose() { this.token++; speechSynthesis.cancel(); }
}

class ClockEngine {
  kind = 'clock';
  constructor(duration) { this.duration = duration; this.rate = 1; this._playing = false; this._t = 0; this.last = 0; }
  async ready() {}
  get playing() { return this._playing; }
  get time() {
    if (this._playing) {
      const now = performance.now();
      this._t += ((now - this.last) / 1000) * this.rate;
      this.last = now;
      if (this._t >= this.duration) { this._t = this.duration; this._playing = false; }
    }
    return this._t;
  }
  play() { this._playing = true; this.last = performance.now(); }
  pause() { this.time; this._playing = false; }
  seek(t) { this._t = clamp(t, 0, this.duration); this.last = performance.now(); }
  setRate(r) { this.time; this.rate = r; }
  dispose() {}
}

const voicesReady = () => new Promise((res) => {
  if (!('speechSynthesis' in self)) return res(false);
  if (speechSynthesis.getVoices().length) return res(true);
  const done = () => res(speechSynthesis.getVoices().length > 0);
  speechSynthesis.addEventListener('voiceschanged', done, { once: true });
  setTimeout(done, 700);
});

// ---------- 控制器 ----------
export class Player {
  constructor() {
    this.cues = []; this.duration = 0; this.rate = 1; this.loop = null; this.engine = null;
    this.curCue = -1; this.sentenceN = 1; this.rep = 0; this.raf = 0; this._seeking = false;
    this.listeners = {}; this.blob = null; this.lang = 'en'; this.ttsOk = false;
  }
  on(evt, fn) { (this.listeners[evt] ||= new Set()).add(fn); return () => this.listeners[evt].delete(fn); }
  emit(evt, v) { this.listeners[evt]?.forEach((f) => f(v)); }
  get state() {
    return { playing: !!this.engine?.playing, rate: this.rate, loop: this.loop, engine: this.engine?.kind, duration: this.duration, sentenceN: this.sentenceN, ttsOk: this.ttsOk, hasAudio: !!this.blob };
  }
  get time() { return this.engine?.time ?? 0; }

  /** tts: { mode:'auto'|'on'|'off', voice?:string }——见 voices.js；没有合适的语音时 ttsOk=false，改用静音计时 */
  async load({ cues, duration, blob = null, lang = 'en', engine = null, tts = {} }) {
    this.dispose();
    this.cues = cues; this.duration = duration; this.blob = blob; this.lang = lang;
    this.ttsPrefs = tts;
    this.ttsVoice = null;
    if (await voicesReady()) this.ttsVoice = pickVoice(speechSynthesis.getVoices(), lang, tts).voice;
    this.ttsOk = !!this.ttsVoice;
    await this._makeEngine(engine);
    this.curCue = -1;
    this.emit('state', this.state);
    this._tick(false);
  }
  async _makeEngine(kind) {
    const want = kind || (this.blob ? 'audio' : this.ttsOk ? 'tts' : 'clock');
    const t = this.engine?.time ?? 0;
    this.engine?.dispose();
    let e;
    if (want === 'audio' && this.blob) { e = new AudioEngine(this.blob, this.duration); await e.ready(); this.duration = e.duration || this.duration; }
    else if (want === 'tts' && this.ttsOk) e = new TtsEngine(this.cues, this.lang, this.duration, this.ttsVoice);
    else e = new ClockEngine(this.duration);
    e.setRate(this.rate);
    this.engine = e;
    if (t) e.seek(t);
  }
  /** 纠错 / 校准 / 编辑后更新句子与时长，无需重载引擎 */
  updateCues(cues, duration) {
    this.cues = cues;
    if (this.engine?.kind !== 'audio' && duration) { this.duration = duration; this.engine.duration = duration; }
    if (this.engine?.kind === 'tts') this.engine.cues = cues;
    this.curCue = -1;
    this._tick(false);
    this.emit('state', this.state);
  }
  async useEngine(kind) {
    const was = this.engine?.playing;
    await this._makeEngine(kind);
    this.emit('state', this.state);
    if (was) this.play();
  }

  play() {
    if (!this.engine) return;
    if (this.engine.time >= this.duration - 0.1) this.engine.seek(0);
    this.engine.play();
    this._startRaf();
    this.emit('state', this.state);
  }
  pause() { this.engine?.pause(); this._tick(false); this.emit('state', this.state); }
  toggle() { this.engine?.playing ? this.pause() : this.play(); }
  seek(t) { this._seeking = true; this.engine?.seek(clamp(t, 0, this.duration)); this.rep = 0; this._tick(false); }
  seekCue(i, play = false) { const c = this.cues[clamp(i, 0, this.cues.length - 1)]; if (!c) return; this.seek(c.start + 0.001); if (play) this.play(); }
  nextCue() { this.seekCue(Math.max(0, this.curCue) + 1, this.engine?.playing); }
  prevCue() {
    // 句子播放超过 1.2s 时，"上一句"先回到本句开头
    const c = this.cues[this.curCue];
    if (c && this.time - c.start > 1.2) return this.seekCue(this.curCue, this.engine?.playing);
    this.seekCue(this.curCue - 1, this.engine?.playing);
  }
  setRate(r) { this.rate = clamp(r, 0.25, 3); this.engine?.setRate(this.rate); this.emit('state', this.state); }
  stepRate(dir) {
    const i = SPEEDS.findIndex((s) => Math.abs(s - this.rate) < 1e-6);
    const k = clamp((i < 0 ? SPEEDS.indexOf(1) : i) + dir, 0, SPEEDS.length - 1);
    this.setRate(SPEEDS[k]);
  }

  // A-B 循环（count 缺省为无限；tag 用于识别"是哪一句的循环"）
  setLoop(a, b, count = Infinity, tag = null) { this.loop = b > a ? { a, b, left: count, tag } : null; this.emit('state', this.state); }
  clearLoop() { this.loop = null; this.emit('state', this.state); }
  /** 播放 [a,b] 并循环（精确时间，不做边界处理） */
  playRange(a, b, { count = Infinity, rate, tag = null } = {}) {
    if (rate) this.setRate(rate);
    this.setLoop(a, b, count, tag);
    this.seek(a);
    this.play();
  }
  /**
   * 按句子边界播放一段并循环，按引擎处理边界：
   * - 录音：前后各留一点余量，避免切掉起音/尾音（估算时间轴本身也有误差）
   * - TTS：整句朗读，不能向前留余量（否则会先念上一句）；终点略过句尾，等这句念完再回环
   * - 静音计时器：精确边界
   */
  playSpan(start, end, opts = {}) {
    const k = this.engine?.kind;
    const a = k === 'audio' ? Math.max(0, start - 0.25) : start;
    const b = k === 'audio' ? Math.min(this.duration || end + 0.2, end + 0.2) : k === 'tts' ? end + 0.05 : end;
    this.playRange(a, b, opts);
  }
  loopCue(i) { const c = this.cues[i]; if (c) this.playSpan(c.start, c.end, { tag: `cue:${i}` }); }
  isLoopingCue(i) { return this.loop?.tag === `cue:${i}`; }
  /** 逐句重复 N 遍（1 = 关闭；Infinity = 无限重复当前句） */
  setSentenceRepeat(n) { this.sentenceN = n; this.rep = 0; this.emit('state', this.state); }

  _startRaf() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this._tick(true); }); }

  _tick(loopRaf) {
    const e = this.engine;
    if (!e) return;
    const t = e.time;
    this.emit('time', t);
    const i = cueAt(this.cues, t);
    const prev = this.curCue;
    if (i !== prev) {
      if (this.sentenceN > 1 && !this._seeking && prev >= 0 && i === prev + 1 && e.playing) {
        // 自然播放跨入下一句：重复上一句 N 遍后再放行
        this.rep++;
        if (this.sentenceN === Infinity || this.rep < this.sentenceN) {
          e.seek(this.cues[prev].start);
          if (e.playing) this._startRaf();
          return;
        }
        this.rep = 0;
      }
      this.curCue = i;
      this.emit('cue', i);
    }
    this._seeking = false;
    if (this.loop && e.playing && t >= this.loop.b - 0.03) {
      this.loop.left -= 1;
      if (this.loop.left > 0) e.seek(this.loop.a);
      else { this.loop = null; e.pause(); this.emit('state', this.state); }
    }
    if (e.playing) { if (loopRaf) this._startRaf(); }
    else if (loopRaf) this.emit('state', this.state); // 自然播放结束
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.engine?.dispose(); this.engine = null;
    this.loop = null; this.rep = 0;
  }
}
