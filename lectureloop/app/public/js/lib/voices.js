// 朗读语音的评级与选择。纯函数（输入语音列表），可在 Node 里用各平台的模拟列表测试。
//
// 为什么需要它：speechSynthesis.getVoices() 的顺序是任意的，直接取"第一个英语语音"在 Mac 上可能选到
// Whisper / Zarvox / Bad News 这类搞怪语音（它们的语言标签也是 en-US），听起来很吓人。
// 这里把语音分为五档，并默认只在存在"好"语音时才启用朗读，否则静音计时。

export const TIER = { bad: 0, poor: 1, ok: 2, good: 3, great: 4 };
export const TIER_LABEL = { bad: '不推荐（搞怪/机械）', poor: '机械感较重', ok: '一般', good: '推荐', great: '最佳' };

// macOS 自带的搞怪语音：不适合听力练习
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
// 老式合成语音：能听清但机械感重
const POOR = /^(Fred|Junior|Ralph|Kathy|Princess|Agnes|Bruce|Vicki|Victoria)\b|espeak|mbrola|festival/i;
// 名称里带这些词的是高质量（神经网络 / 增强）语音
const GREAT = /(premium|enhanced|natural|neural|siri|online|\bhd\b|studio|wavenet|chirp|journey)/i;
// 常见的、清晰度不错的系统语音（标准档，机械感比神经语音重）
const KNOWN_OK = /^(Samantha|Alex|Daniel|Karen|Moira|Tessa|Fiona|Ava|Allison|Susan|Tom|Serena|Oliver|Kate|Thomas|Am[ée]lie|Audrey|Aur[ée]lie|Marie|Tingting|Ting-Ting|Meijia|Mei-Jia|Sinji|Sin-ji|Lili|Yu-shu|Li-mu|Microsoft (Zira|David|Mark|Hortense|Julie|Paul|Huihui|Yaoyao|Kangkang|Hazel|George|Susan))/i;

export const normLang = (l) => String(l || '').replace('_', '-').toLowerCase();
const LANG_ROOT = { en: 'en', fr: 'fr', zh: 'zh' };
// 同语言下更偏好的地区（口音）
const PREFER_REGION = { en: ['en-us', 'en-gb'], fr: ['fr-fr'], zh: ['zh-cn'] };

export function tierOf(v) {
  const name = v.name || '';
  if (NOVELTY.test(name)) return 'bad';
  if (POOR.test(name) || POOR.test(v.voiceURI || '')) return 'poor';
  if (GREAT.test(name)) return 'great';
  if (/^google\b/i.test(name)) return 'good'; // Chrome 内置的 Google 在线语音
  if (KNOWN_OK.test(name)) return 'ok';
  return 'ok';
}

/** 浏览器 SpeechSynthesisVoice → 统一结构 */
export function describe(v) {
  const tier = tierOf(v);
  return { uri: v.voiceURI || v.name, name: v.name, lang: normLang(v.lang), local: v.localService !== false, tier, score: TIER[tier], raw: v };
}

export function listForLang(voices, lang) {
  const root = LANG_ROOT[lang] || lang;
  const pref = PREFER_REGION[lang] || [];
  return voices
    .map(describe)
    .filter((v) => v.lang === root || v.lang.startsWith(root + '-'))
    .sort((a, b) =>
      b.score - a.score
      || (pref.indexOf(a.lang) < 0 ? 9 : pref.indexOf(a.lang)) - (pref.indexOf(b.lang) < 0 ? 9 : pref.indexOf(b.lang))
      || Number(b.local) - Number(a.local)
      || a.name.localeCompare(b.name));
}

/**
 * 选择朗读语音。
 * @param voices  speechSynthesis.getVoices()
 * @param lang    'en' | 'fr' | 'zh'
 * @param prefs   { mode: 'auto'|'on'|'off', voice?: 保存的语音 uri/名称 }
 * @returns       { voice, tier, reason } —— voice 为 null 表示"不朗读"（静音计时）
 *
 * - mode=off：不朗读。
 * - 用户明确选了某个语音：尊重选择（哪怕它很一般）。
 * - 否则只在存在"推荐"及以上（Google / Premium / Enhanced / Natural / Siri）的语音时自动启用；
 *   只有标准档语音时，auto 不启用（避免机械、吓人的声音），mode=on 才使用最好的一个。
 */
export function pickVoice(voices, lang, prefs = {}) {
  const mode = prefs.mode || 'auto';
  if (mode === 'off') return { voice: null, tier: null, reason: 'off' };
  const list = listForLang(voices, lang);
  if (prefs.voice) {
    const saved = list.find((v) => v.uri === prefs.voice || v.name === prefs.voice);
    if (saved) return { voice: saved.raw, tier: saved.tier, reason: 'chosen' };
  }
  const best = list.find((v) => v.score >= TIER.ok);
  if (!best) return { voice: null, tier: null, reason: list.length ? 'only-bad' : 'none' };
  if (mode === 'on' || best.score >= TIER.good) return { voice: best.raw, tier: best.tier, reason: best.score >= TIER.good ? 'good' : 'forced' };
  return { voice: null, tier: best.tier, reason: 'not-natural' };
}

/** 把一句话切成 ≤ max 字符的小段（Chrome 的 Google 在线语音会在约 15 秒后截断过长的句子） */
export function chunkForTts(text, max = 140) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return [t];
  const parts = t.split(/(?<=[,;:.?!，；：。？！])\s*/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length <= max) cur = (cur + ' ' + p).trim();
    else { if (cur) out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  // 单段仍然过长（没有标点）：按空格硬切
  return out.flatMap((s) => {
    if (s.length <= max) return [s];
    const w = s.split(' ');
    const r = [];
    let c = '';
    for (const x of w) { if ((c + ' ' + x).trim().length > max) { r.push(c); c = x; } else c = (c + ' ' + x).trim(); }
    if (c) r.push(c);
    return r;
  });
}

export const SAMPLE = {
  en: 'Okay, so just remember that the margin depends only on the support vectors.',
  fr: 'D’accord, retenez simplement que la marge ne dépend que des vecteurs de support.',
  zh: '好，请记住：间隔只取决于支持向量。',
};
