// 视频身份：同一个视频再次打开 / 循环播放时要得到同一个 key，转录与译文才能复用。纯函数。
const DROP = /^(utm_|fbclid$|gclid$|t$|start$|time$|list$|index$|feature$|pp$|si$)/i;

/** @returns {{key:string, site:string, url:string}}  loc 形如 { href, hostname, pathname, search } */
export function videoKeyOf(loc) {
  let u;
  try { u = new URL(loc.href); } catch { return { key: `x:${loc.hostname || ''}${loc.pathname || ''}`, site: loc.hostname || '', url: loc.href || '' }; }
  const host = u.hostname.replace(/^www\./, '');
  let id = null;
  if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host)) id = u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1];
  if (id) return { key: `yt:${id}`, site: host, url: `https://www.youtube.com/watch?v=${id}` };
  if (/(^|\.)netflix\.com$/.test(host)) { const m = u.pathname.match(/\/watch\/(\d+)/); if (m) return { key: `nf:${m[1]}`, site: host, url: `https://www.netflix.com/watch/${m[1]}` }; }
  const params = [...u.searchParams].filter(([k]) => !DROP.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  return { key: `u:${host}${u.pathname.replace(/\/+$/, '')}${q}`, site: host, url: u.origin + u.pathname + q };
}
