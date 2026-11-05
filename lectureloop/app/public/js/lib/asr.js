// 实时听课：Web Speech 识别 + MediaRecorder 录音（时间零点 = 会话开始）+ 演示课堂（无需麦克风）。
// 对外只暴露回调：onInterim(text) / onFinal({start,end,text,tr?}) / onStatus(code) / onError(code)。
import { units } from './text.js';
import { UtteranceTracker } from './utterance.js';

export const asrSupported = () => !!(self.SpeechRecognition || self.webkitSpeechRecognition);
export const micSupported = () => !!navigator.mediaDevices?.getUserMedia && 'MediaRecorder' in self;
export const LANG_BCP = { en: 'en-US', fr: 'fr-FR', zh: 'zh-CN' };

const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => self.MediaRecorder?.isTypeSupported?.(m)) || '';

export class LiveSession {
  /**
   * @param {{lang:string, source:'mic'|'demo', demoCues?:any[], demoSpeed?:number, onInterim?:Function, onFinal?:Function, onStatus?:Function, onError?:Function}} o
   */
  constructor(o) {
    Object.assign(this, { demoSpeed: 2, ...o });
    this.active = false; this.paused = false; this.fatal = false;
    this.t0 = 0; this.pausedTotal = 0; this.pausedAt = null; this.utterStart = null;
    // 话语跟踪：不丢被引擎替换掉的临时字幕，并校正每句的起止时间（见 utterance.js）
    this.log = []; // 排查用：识别引擎每次返回了什么、何时中断重启、保存了哪些句子（设置页可导出）
    this.tracker = new UtteranceTracker({
      onInterim: (t) => this.onInterim?.(t),
      onFinal: (c) => { this._log('cue', { s: +c.start.toFixed(2), e: +c.end.toFixed(2), text: c.text.slice(0, 80), ...(c.provisional ? { prov: 1 } : {}), ...(c.replace ? { replace: 1 } : {}) }); this.onFinal?.(c); },
    });
    this.chunks = []; this.demoIdx = 0; this.timer = 0; this.mime = '';
  }

  _log(k, d = {}) { if (this.log.length > 6000) this.log.shift(); this.log.push({ t: +this.elapsed().toFixed(2), k, ...d }); }

  /** 已录制秒数（不含暂停） */
  elapsed() {
    const now = this.pausedAt ?? performance.now();
    const raw = Math.max(0, (now - this.t0 - this.pausedTotal) / 1000);
    return this.source === 'demo' ? raw * this.demoSpeed : raw; // 演示以 demoSpeed 倍速吐字，换算回自然语速（≈150 词/分钟）
  }

  async start() {
    this.active = true; this.t0 = performance.now();
    this._log('start', { src: this.source, lang: this.lang });
    if (this.source === 'demo') { this._demoNext(); this.onStatus?.('listening'); return; }
    // 麦克风录音
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.mime = pickMime();
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);
    this.rec.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
    this.t0 = performance.now();
    this.rec.start(5000);
    if (asrSupported()) this._startRecognition();
    else this.onStatus?.('no-asr'); // 只录音，课后可导入转录/重转写
    this.onStatus?.('listening');
  }

  _startRecognition() {
    const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
    if (this.recog) { this.recog.onresult = this.recog.onend = this.recog.onerror = null; } // 旧实例不再发事件，避免重启后出现幽灵结果/重复重启
    const r = new SR();
    r.lang = LANG_BCP[this.lang] || 'en-US';
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      const items = [];
      for (let k = e.resultIndex; k < e.results.length; k++) items.push({ text: e.results[k][0].transcript, final: e.results[k].isFinal });
      this._log('result', { i: e.resultIndex, n: e.results.length, r: items.map((x) => ({ f: x.final ? 1 : 0, x: x.text.slice(0, 120) })) });
      this.tracker.feed(items, this.elapsed());
    };
    r.onerror = (e) => {
      this._log('error', { e: e.error });
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) { this.fatal = true; this.onError?.(e.error); }
      else this.onStatus?.('network');
    };
    // 浏览器会在静音/网络波动时自动结束识别：会话进行中则立即重启。
    // 不用定时器：页面在后台时 setTimeout 会被降频（最长每分钟一次），字幕会长时间断档。
    // 只有短时间内反复失败（例如网络断开）才退回到定时重试。
    r.onend = () => {
      this._log('end');
      this.tracker.flush(); // 识别被结束时，还没定稿的假设不能丢
      if (!this.active || this.fatal || this.paused) return;
      const now = performance.now();
      this.restarts = (this.restarts || []).filter((t) => now - t < 5000);
      this.restarts.push(now);
      this.onStatus?.('reconnecting');
      if (this.restarts.length <= 4) { try { this._startRecognition(); return; } catch { /* 落到定时重试 */ } }
      setTimeout(() => this.active && !this.paused && this._startRecognition(), 1000);
    };
    try { r.start(); } catch { /* 已在运行 */ }
    this.recog = r;
  }

  /** 演示课堂：直接按参考句子生成一句（带参考译文），不经过话语跟踪器 */
  _demoFinal(text, src) {
    const end = this.elapsed();
    const start = this.utterStart ?? Math.max(0, end - units(text) / 2.5);
    this.utterStart = null;
    this.onInterim?.('');
    this.onFinal?.({ start, end, text, ...(src?.tr ? { tr: src.tr } : {}) });
  }

  // ---- 演示课堂：逐词吐出示例课堂，行为与真实识别一致 ----
  _demoNext() {
    if (!this.active || this.paused) return;
    const c = this.demoCues[this.demoIdx];
    if (!c) { this.onStatus?.('demo-end'); return; }
    const words = c.text.split(/\s+/);
    let w = 0;
    this.utterStart = this.elapsed();
    const step = () => {
      if (!this.active || this.paused) return;
      w++;
      this.onInterim?.(words.slice(0, w).join(' '));
      if (w < words.length) this.timer = setTimeout(step, 400 / this.demoSpeed);
      else {
        this.timer = setTimeout(() => { this._demoFinal(c.text, c); this.demoIdx++; this.timer = setTimeout(() => this._demoNext(), 600 / this.demoSpeed); }, 250 / this.demoSpeed);
      }
    };
    step();
  }

  pause() {
    if (this.paused) return;
    this._log('pause');
    this.paused = true; this.pausedAt = performance.now();
    clearTimeout(this.timer);
    try { this.rec?.pause(); } catch { /* ignore */ }
    try { this.recog?.stop(); } catch { /* ignore */ }
    this.tracker.flush();
    this.onStatus?.('paused');
  }
  resume() {
    if (!this.paused) return;
    this._log('resume');
    this.pausedTotal += performance.now() - this.pausedAt; this.pausedAt = null; this.paused = false;
    try { this.rec?.resume(); } catch { /* ignore */ }
    if (this.source === 'demo') this._demoNext(); else if (asrSupported()) this._startRecognition();
    this.onStatus?.('listening');
  }

  /** 结束并返回 { blob, mime, duration } */
  async stop() {
    this._log('stop');
    this.active = false;
    clearTimeout(this.timer);
    try { this.recog?.stop(); } catch { /* ignore */ }
    this.tracker.flush(); // 还没定稿的最后一句也要保存
    const duration = this.elapsed();
    let blob = null;
    if (this.rec && this.rec.state !== 'inactive') {
      blob = await new Promise((res) => {
        this.rec.onstop = () => res(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
        this.rec.stop();
      });
    } else if (this.chunks.length) blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
    this.stream?.getTracks().forEach((t) => t.stop());
    return { blob, mime: this.mime, duration };
  }
}
