// 字幕记录（纯函数，Node 与浏览器通用）：把"看到的字幕行"合并成一条按时间排序的转录。
// 一行：{ id, start, end, text, tr?: { zh, en, fr } }。循环播放 / 重新打开同一个视频时，同样的句子要认出来，而不是再记一遍。
export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();

/** 在 lines 里找"同一句"：文字（忽略大小写和标点）相同，且开始时间相差不超过 tol 秒。找不到返回 -1 */
export function findMatch(lines, text, start, tol = 3, norms = null) {
  const n = norm(text);
  if (!n) return -1;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((norms ? norms[i] : norm(l.text)) !== n) continue;
    const d = start >= l.start && start <= l.end ? 0 : Math.min(Math.abs(start - l.start), Math.abs(start - l.end));
    if (d <= tol && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

export const lineId = (prefix, start, taken) => {
  let id = `${prefix}${Math.round(start * 1000)}`, k = 1;
  while (taken.has(id)) id = `${prefix}${Math.round(start * 1000)}_${k++}`;
  return id;
};

/** 合并两组行：同一 id、或文字相同且时间相近的视为同一句（合并译文、扩展结束时间）；结果按开始时间排序 */
export function mergeLines(existing, incoming) {
  const out = existing.map((l) => ({ ...l, tr: l.tr ? { ...l.tr } : undefined }));
  const norms = out.map((l) => norm(l.text)); // 预先算好：载入整条轨道时是上千次比较
  const byId = new Map(out.map((l) => [l.id, l]));
  const idx = new Map(out.map((l, i) => [l.id, i]));
  for (const inc of incoming) {
    const n = norm(inc.text);
    let cur = byId.get(inc.id);
    if (cur && norms[idx.get(inc.id)] !== n) cur = null; // 同 id 但内容不同：当作新的一句
    // 模糊匹配（文字相同 + 时间相近）只用于网站 DOM 字幕：字幕轨道里的每一句本来就有唯一的 id，相邻两句同样的话（"Non. Non."）是两句
    if (!cur && !/^[ta]/.test(inc.id)) { const i = findMatch(out, inc.text, inc.start, 3, norms); if (i >= 0) cur = out[i]; }
    if (cur) {
      cur.end = Math.max(cur.end, inc.end);
      if (inc.tr) cur.tr = { ...cur.tr, ...inc.tr };
    } else {
      const l = { ...inc, tr: inc.tr ? { ...inc.tr } : undefined };
      if (byId.has(l.id)) l.id = lineId('x', l.start, byId);
      out.push(l); norms.push(n); byId.set(l.id, l); idx.set(l.id, out.length - 1);
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}
