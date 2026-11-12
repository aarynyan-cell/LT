// 翻译引擎编排（background）：auto = AI 密钥 → Google 免费；单独指定时只用那一个。
// 'chrome'（浏览器内置翻译）只能在页面里运行，由内容脚本处理，这里不涉及。
import { ApiError } from '../../../app/public/js/lib/errors.js';
import { selection } from './keys.js';
import { translateLLM } from './llm.js';

const GTX = 'https://translate.googleapis.com/translate_a/single';
const GCODE = { zh: 'zh-CN', en: 'en', fr: 'fr', auto: 'auto' };

async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (next < arr.length) { const i = next++; out[i] = await fn(arr[i], i); }
  }));
  return out;
}

/** Google 翻译免费网页接口（非官方、无需密钥；可能被限流或改动）。每句一个请求，最多 4 个并发。 */
export async function translateGtx({ source, targets, items, fetchFn = fetch, endpoint = GTX }) {
  const results = {};
  for (const target of targets.filter((t) => t !== source)) {
    results[target] = await mapLimit(items, 4, async (it) => {
      const url = `${endpoint}?client=gtx&sl=${GCODE[source] || 'auto'}&tl=${GCODE[target]}&dt=t&q=${encodeURIComponent(it.t)}`;
      let r;
      try { r = await fetchFn(url); } catch { throw new ApiError('network', '无法连接 Google 翻译（网络问题）'); }
      if (r.status === 429) throw new ApiError('rate_limit', 'Google 免费翻译被限流，请稍后再试或换用 AI 密钥', 429);
      if (!r.ok) throw new ApiError('upstream', `Google 翻译错误 ${r.status}`, r.status);
      const j = await r.json().catch(() => null);
      if (!Array.isArray(j?.[0])) throw new ApiError('bad_json', 'Google 翻译返回了无法解析的内容');
      return { i: it.i, t: j[0].map((x) => x?.[0] || '').join('').trim() };
    });
  }
  return { provider: 'gtx', results };
}

/**
 * @param req { source, targets, items:[{i,t}], context, engine }
 * @param deps { keys:{keys,use}, endpoints?, fetchFn? }
 * @returns {provider, results, note?}  note：发生了降级时的说明
 */
export async function translateBatch(req, { keys, endpoints = {}, fetchFn = fetch }) {
  const { source = 'auto', targets, items, context = [], engine = 'auto' } = req;
  const order = engine === 'llm' ? ['llm'] : engine === 'gtx' ? ['gtx'] : engine === 'auto' ? ['llm', 'gtx'] : [];
  let note = '', last = null;
  for (const name of order) {
    try {
      if (name === 'llm') {
        const sel = selection(keys);
        if (!sel) { last = new ApiError('no_key', '还没有设置 AI 密钥'); continue; }
        return { ...(await translateLLM({ sel, source, targets, items, context, fetchFn })), note };
      }
      return { ...(await translateGtx({ source, targets, items, fetchFn, endpoint: endpoints.gtx })), note };
    } catch (e) {
      last = e;
      if (name === 'llm' && e.code !== 'no_key') note = `AI 翻译失败（${e.message}），已改用 Google 免费翻译`;
    }
  }
  throw last || new ApiError('no_provider', '没有可用的翻译引擎');
}
