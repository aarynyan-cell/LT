// 语音识别（后台）：把一小段 WAV 发给"OpenAI 兼容的语音转写接口"（POST {base}/audio/transcriptions，Whisper 系列）。
// 能用的服务商：OpenAI（whisper-1）、Groq（whisper-large-v3-turbo）、以及任何实现了这个接口的自定义地址（本机 faster-whisper-server 等）。
// Anthropic / DeepSeek 等没有语音转写接口，不能用。音频只发给用户自己选的这个服务。
import { ApiError } from '../../../app/public/js/lib/errors.js';
import { PROVIDERS } from '../../../app/public/js/lib/providers.js';

export const ASR_PROVIDERS = { openai: { model: 'whisper-1' }, groq: { model: 'whisper-large-v3-turbo' }, custom: { model: '' } };

/** 当前用哪个服务做语音识别：{ id, key, model, base } 或 null。优先用户在设置里指定的，其次第一个可用的 */
export function asrSelection({ keys = {}, use = '' }, asr = {}) {
  const capable = Object.keys(keys).filter((id) => ASR_PROVIDERS[id]);
  const id = capable.includes(asr.use) ? asr.use : capable[0];
  if (!id) return null;
  const e = keys[id];
  const model = (id === asr.use && asr.model) || e.asrModel || ASR_PROVIDERS[id].model;
  if (!model) return null; // 自定义地址必须填模型名
  return { id, key: e.key, model, base: e.base || PROVIDERS[id].base };
}

// Whisper 在没有人声的片段上常"幻听"出这些套话；有 VAD 切块已经少很多，这里再兜一层
const HALLUCINATION = /^(thanks? (you )?for watching|thank you\.?$|merci d['’]avoir regardé|sous-titr|subtitles? by|amara\.org|www\.|♪|\[.*\]$|please subscribe|n'oubliez pas de vous abonner|字幕由|谢谢观看)/i;

/** 过滤并整理识别结果：segments → [{ start, end, text }]（时间相对这一块的开头，秒） */
export function cleanSegments(json, durSec) {
  const segs = Array.isArray(json?.segments) && json.segments.length ? json.segments : json?.text ? [{ start: 0, end: durSec, text: json.text }] : [];
  const out = [];
  for (const s of segs) {
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text || HALLUCINATION.test(text)) continue;
    if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8) continue; // 模型自己都觉得没人在说话
    if ((s.compression_ratio ?? 0) > 2.4) continue;                              // 重复循环的幻觉
    out.push({ start: Math.max(0, +s.start || 0), end: Math.min(durSec + 0.5, +s.end || durSec), text });
  }
  return out;
}

export async function transcribe({ sel, wav, language, durSec, fetchFn = fetch }) {
  if (!sel) throw new ApiError('no_asr', '没有可用的语音识别服务');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', sel.model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language && language !== 'auto') form.append('language', language);
  let r;
  try { r = await fetchFn(`${sel.base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${sel.key}` }, body: form }); }
  catch { throw new ApiError('network', '无法连接语音识别服务'); }
  if (r.status === 401 || r.status === 403) throw new ApiError('auth', '语音识别服务的密钥无效或没有权限', r.status);
  if (r.status === 429) throw new ApiError('rate_limit', '语音识别请求过于频繁或额度不足', 429);
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new ApiError(r.status >= 500 ? 'upstream' : 'bad_request', `语音识别服务错误 ${r.status}${t ? '：' + t.slice(0, 160) : ''}`, r.status); }
  const j = await r.json().catch(() => null);
  if (!j) throw new ApiError('bad_json', '语音识别服务返回了无法解析的内容');
  return { segments: cleanSegments(j, durSec), language: (j.language || '').slice(0, 2).toLowerCase() || null };
}
