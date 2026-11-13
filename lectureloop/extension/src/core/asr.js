// 语音识别会话（内容脚本）：从视频元素取音频（video.captureStream，不会让视频静音）→ 重采样 16 kHz → 切块 → onChunk。
// 受 DRM 保护的视频（Netflix 等）取到的是静音，会报告 drm；跨域且没有 CORS 的媒体同样取不到声音。
import { Resampler, Chunker } from './pcm.js';

export class AsrSession {
  constructor({ video, win, onChunk, onProblem = () => {} }) {
    this.video = video; this.win = win; this.onChunk = onChunk; this.onProblem = onProblem;
    this.lastEnd = null; this.silentMs = 0; this.heard = false; this.running = false; this.problem = '';
  }
  async start() {
    const v = this.video;
    const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream ? v.mozCaptureStream() : null;
    const tracks = stream?.getAudioTracks?.() || [];
    if (!tracks.length) throw new Error('这个视频拿不到音频轨道');
    const AC = this.win.AudioContext || this.win.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.src = this.ctx.createMediaStreamSource(new this.win.MediaStream(tracks));
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1); // 虽然不推荐，但不需要额外的 worklet 文件，也不用把扩展资源暴露给网页
    this.res = new Resampler(this.ctx.sampleRate, 16000);
    this.chunker = new Chunker({ onChunk: (c) => this.onChunk(c) });
    this.proc.onaudioprocess = (e) => this._process(e.inputBuffer.getChannelData(0));
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination); // 不接到输出就不会触发处理；我们不往输出写数据，所以是静音的
    this.running = true;
  }
  _process(data) {
    const v = this.video, rate = v.playbackRate || 1;
    const dur = (data.length / this.ctx.sampleRate) * rate;
    const mediaStart = v.currentTime - dur;
    if (this.lastEnd != null && Math.abs(mediaStart - this.lastEnd) > 1.0) { this.chunker.flush(); } // 拖动了进度条：上一块作罢
    this.lastEnd = v.currentTime;
    let peak = 0;
    for (let i = 0; i < data.length; i += 16) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    if (peak > 1e-4) { this.heard = true; this.silentMs = 0; }
    else if (!v.paused) { this.silentMs += (data.length / this.ctx.sampleRate) * 1000; if (!this.heard && this.silentMs > 12000 && !this.problem) { this.problem = 'drm'; this.onProblem('drm'); } }
    this.chunker.push(this.res.process(data), Math.max(0, mediaStart), rate);
  }
  stop() {
    this.running = false;
    try { this.chunker?.flush(); } catch { /* 忽略 */ }
    try { this.proc && (this.proc.onaudioprocess = null); this.src?.disconnect(); this.proc?.disconnect(); this.ctx?.close(); } catch { /* 忽略 */ }
  }
}
