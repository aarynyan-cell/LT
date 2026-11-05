// 听写评分：词级 diff（忽略大小写与标点）。纯函数。

export const tokenize = (s) =>
  (s.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || []);

/**
 * @returns {{ops:{t:'eq'|'miss'|'extra'|'sub', ref?:string, got?:string}[], accuracy:number, missed:string[]}}
 *  miss = 漏听（参考有、听写无）；extra = 多写；sub = 听错（相邻 miss+extra 合并）
 */
export function wordDiff(reference, attempt) {
  const a = tokenize(reference), b = tokenize(attempt);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ t: 'eq', ref: a[i], got: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) raw.push({ t: 'miss', ref: a[i++] });
    else raw.push({ t: 'extra', got: b[j++] });
  }
  while (i < n) raw.push({ t: 'miss', ref: a[i++] });
  while (j < m) raw.push({ t: 'extra', got: b[j++] });
  // 相邻的 miss + extra → sub
  const ops = [];
  for (let k = 0; k < raw.length; k++) {
    const x = raw[k], y = raw[k + 1];
    if (x.t === 'miss' && y?.t === 'extra') { ops.push({ t: 'sub', ref: x.ref, got: y.got }); k++; }
    else if (x.t === 'extra' && y?.t === 'miss') { ops.push({ t: 'sub', ref: y.ref, got: x.got }); k++; }
    else ops.push(x);
  }
  const eq = ops.filter((o) => o.t === 'eq').length;
  return {
    ops,
    accuracy: n ? eq / n : 0,
    missed: ops.filter((o) => o.t === 'miss' || o.t === 'sub').map((o) => o.ref),
  };
}
