// 翻译 Provider 链：Google Cloud Translation（Basic v2）→ Claude → 报错（前端再降级到浏览器内置 Translator）。
// 选型依据见 docs/01-PRD.md §9.3。
import { AiError, askJson, claudeEnabled, FAST_MODEL } from './claude.js';
import { translateTask, alignTranslation } from '../public/js/lib/ai-tasks.js';

const GOOGLE_URL = () => process.env.GOOGLE_TRANSLATE_ENDPOINT || 'https://translation.googleapis.com/language/translate/v2';
export const googleEnabled = () => !!process.env.GOOGLE_TRANSLATE_API_KEY;

const GOOGLE_CODE = { zh: 'zh-CN', en: 'en', fr: 'fr' };

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
async function viaClaude({ items, source, context = [], glossary = [] }, target) {
  const { data } = await askJson({ model: FAST_MODEL(), ...translateTask({ items, source, target, context, glossary }) });
  const out = alignTranslation(items, data);
  if (!out) throw new AiError('bad_json', '翻译结果为空', 502);
  return out;
}
