// 片段（Part）编辑：重命名、并入上一段、从某句起拆分。纯函数：输入 parts 数组，返回新数组（失败返回 null）。
// 不变量：片段按顺序连续排列，第一段从 0 开始，最后一段到 n-1，没有空隙、重叠或空片段，id 唯一。

const num = (id) => +String(id).replace(/\D/g, '') || 0;
export const nextPartId = (parts) => `p${Math.max(0, ...parts.map((p) => num(p.id))) + 1}`;

export function renamePart(parts, id, title) {
  const t = String(title ?? '').trim();
  if (!t || !parts.some((p) => p.id === id)) return null;
  return parts.map((p) => (p.id === id ? { ...p, title: t } : p));
}

/** 把片段 id 并入它的上一段（标题沿用上一段，摘要合并）。第一段无法并入，返回 null */
export function mergeWithPrev(parts, id) {
  const i = parts.findIndex((p) => p.id === id);
  if (i <= 0) return null;
  const prev = parts[i - 1], cur = parts[i];
  const merged = { ...prev, endCue: cur.endCue, summary: [prev.summary, cur.summary].filter(Boolean).join('\n') };
  return [...parts.slice(0, i - 1), merged, ...parts.slice(i + 1)];
}

/** 从第 cueIdx 句开始新开一个片段（该句成为新片段的第一句）。该句已经是某片段的第一句时返回 null */
export function splitAt(parts, cueIdx) {
  const i = parts.findIndex((p) => cueIdx > p.startCue && cueIdx <= p.endCue);
  if (i < 0) return null;
  const p = parts[i];
  const first = { ...p, endCue: cueIdx - 1 };
  const second = { id: nextPartId(parts), title: `${p.title.replace(/ \(续\)$/, '')} (续)`, startCue: cueIdx, endCue: p.endCue, summary: '' };
  return [...parts.slice(0, i), first, second, ...parts.slice(i + 1)];
}

/** 校验不变量（测试与调试用）：返回错误描述，通过返回 null */
export function validateParts(parts, n) {
  if (!parts.length) return n ? '没有片段' : null;
  if (parts[0].startCue !== 0) return '第一段必须从 0 开始';
  if (parts.at(-1).endCue !== n - 1) return '最后一段必须到最后一句';
  const ids = new Set();
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.endCue < p.startCue) return `片段 ${p.id} 为空`;
    if (k && p.startCue !== parts[k - 1].endCue + 1) return `片段 ${p.id} 与上一段不连续`;
    if (ids.has(p.id)) return `片段 id 重复：${p.id}`;
    ids.add(p.id);
  }
  return null;
}
