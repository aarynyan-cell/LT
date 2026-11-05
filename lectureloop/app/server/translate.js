// 翻译 Provider 链：Google Cloud Translation（Basic v2）→ Claude → 报错（前端再降级到浏览器内置 Translator）。
// 选型依据见 docs/01-PRD.md §9.3。
import { AiError, askJson, claudeEnabled, FAST_MODEL } from './claude.js';

const GOOGLE_URL = () => process.env.GOOGLE_TRANSLATE_ENDPOINT || 'https://translation.googleapis.com/language/translate/v2';
export const googleEnabled = () => !!process.env.GOOGLE_TRANSLATE_API_KEY;

const GOOGLE_CODE = { zh: 'zh-CN', en: 'en', fr: 'fr' };
const LANG_NAME = { zh: 'Simplified Chinese', en: 'English', fr: 'French' };

export function availableProviders() {
  return { google: googleEnabled(), claude: claudeEnabled() };
}

/** 选择 provider 顺序。TRANSLATE_PROVIDER=google|claude|auto（默认 auto：有谁用谁，Google 优先） */
function order() {
  const pref = (process.env.TRANSLATE_PROVIDER || 'auto').toLowerCase();
  const list = [];
  if (pref === 'claude') list.push('claude', 'google');
  else list.push('google', 'claude');
  return list.filter((p) => (p === 'google' ? googleEnabled() : claudeEnabled()));
}

/**
 * @param {{source:string,targets:string[],items:{i:number,t:string}[],context?:string[],glossary?:string[]}} req
 * @returns {Promise<{provider:string, results:Record<string,{i:number,t:string}[]>}>}
 */
export async function translateBatch(req) {
  const providers = order();
  if (!providers.length) throw new AiError('no_provider', '未配置翻译服务（GOOGLE_TRANSLATE_API_KEY 或 ANTHROPIC_API_KEY）', 503);
  const targets = req.targets.filter((t) => t !== req.source);
  let lastErr;
  for (const p of providers) {
    try {
      const results = {};
      await Promise.all(
        targets.map(async (tgt) => {
          results[tgt] = p === 'google' ? await viaGoogle(req.items, req.source, tgt) : await viaClaude(req, tgt);
        }),
      );
      return { provider: p, results };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------- Google ----------
const decode = (x) =>
  x.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function viaGoogle(items, source, target) {
  const out = [];
  for (let k = 0; k < items.length; k += 100) {
    const chunk = items.slice(k, k + 100);
    const r = await fetch(`${GOOGLE_URL()}?key=${encodeURIComponent(process.env.GOOGLE_TRANSLATE_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: chunk.map((c) => c.t), source: GOOGLE_CODE[source] || source, target: GOOGLE_CODE[target] || target, format: 'text' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new AiError('upstream', `Google Translate 错误 ${r.status}`, 502);
    const j = await r.json();
    const tr = j?.data?.translations;
    if (!Array.isArray(tr) || tr.length !== chunk.length) throw new AiError('upstream', 'Google Translate 返回数量不一致', 502);
    chunk.forEach((c, n) => out.push({ i: c.i, t: decode(tr[n].translatedText || '') }));
  }
  return out;
}

// ---------- Claude ----------
const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, t: { type: 'string' } }, required: ['i', 't'], additionalProperties: false } } },
  required: ['items'],
  additionalProperties: false,
};

async function viaClaude({ items, source, context = [], glossary = [] }, target) {
  const system = `You translate live lecture subtitles from ${LANG_NAME[source] || source} to ${LANG_NAME[target] || target}.
Each input line is "index|text". The text comes from speech recognition: it has filler words (uh, um, okay) and sometimes wrong technical words - use the context to translate the intended meaning, but never add information.
Rules: natural, concise subtitle style; drop pure fillers; keep technical terms accurate and consistent${glossary.length ? ` (glossary: ${glossary.slice(0, 80).join('; ')})` : ''}; return exactly one item per input line with the same index; do not merge or split lines.`;
  const ctx = context.length ? `Previous lines (context only, do NOT translate):\n${context.slice(-3).join('\n')}\n\n` : '';
  const user = `${ctx}Translate these lines:\n${items.map((c) => `${c.i}|${c.t.replace(/\s+/g, ' ').trim()}`).join('\n')}`;
  const { data } = await askJson({ model: FAST_MODEL(), system, user, schema: TRANSLATE_SCHEMA, effort: 'low', maxTokens: 8000 });
  const byI = new Map((data.items || []).map((x) => [x.i, String(x.t || '')]));
  if (byI.size === 0) throw new AiError('bad_json', '翻译结果为空', 502);
  return items.map((c) => ({ i: c.i, t: byI.get(c.i) ?? '' })); // 缺失的行留空，前端只显示原文
}
