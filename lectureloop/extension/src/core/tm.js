// 翻译记忆（Translation Memory）：翻译过的句子永久缓存。同一个视频再看一遍、循环播放、或别的视频里出现同样的句子（"Merci." "On y va !"），
// 都直接命中，不再请求翻译服务。纯逻辑，存取函数由调用方注入（后台用 IndexedDB，测试用内存）。
export const tmKey = (source, target, text) => `${source}|${target}|${text}`;

/**
 * 先查记忆，没命中的才交给 run() 去翻译，翻译结果再写回记忆。
 * @param req   { source, targets, items:[{i,t}], context, engine }
 * @param deps  { getMany(keys)→Map(key→{t,p}), putMany(entries), run(req)→{provider,results,note?}, wantAI:boolean }
 *   wantAI：当前会用 AI 翻译；这时记忆里"免费翻译"质量的条目视为没命中（重翻一次并覆盖），免得 AI 密钥白填
 */
export async function translateWithTM(req, { getMany, putMany, run, wantAI = false }) {
  const { source = 'auto', targets, items } = req;
  const found = await getMany(items.flatMap((it) => targets.map((t) => tmKey(source, t, it.t))));
  const results = Object.fromEntries(targets.map((t) => [t, []]));
  const miss = [];
  let hits = 0;
  for (const it of items) {
    const per = {};
    let ok = true;
    for (const t of targets) {
      const e = found.get(tmKey(source, t, it.t));
      if (!e || !e.t || (wantAI && e.p === 'gtx')) { ok = false; break; }
      per[t] = e.t;
    }
    if (ok) { hits++; for (const t of targets) results[t].push({ i: it.i, t: per[t] }); } else miss.push(it);
  }
  let provider = 'cache', note = '';
  if (miss.length) {
    const r = await run({ ...req, items: miss });
    provider = r.provider; note = r.note || '';
    const entries = [];
    for (const t of targets) for (const x of r.results?.[t] || []) {
      results[t].push(x);
      const src = miss.find((m) => m.i === x.i);
      if (src && x.t) entries.push({ k: tmKey(source, t, src.t), t: x.t, p: provider.startsWith('ai:') ? 'ai' : provider, ts: Date.now() });
    }
    if (entries.length) await putMany(entries).catch(() => {}); // 记忆写失败不影响这次翻译
  }
  for (const t of targets) results[t].sort((a, b) => a.i - b.i);
  return { provider, results, note, cached: hits };
}
