(() => {
  // ../extension/src/core/settings.js
  var DEFAULTS = {
    source: "auto",
    // 原文语言：auto | zh | en | fr
    targets: ["zh"],
    // 译文语言：1–2 个
    engine: "auto",
    // auto（有密钥用 AI，否则 Google 免费，再不行用 Chrome 内置） | llm | gtx | chrome
    showOrig: false,
    // 悬浮层里同时显示原文（"隐藏网站字幕"开启时总是显示）
    hideSite: false,
    // 隐藏网站自带字幕，只显示悬浮层
    asr: "auto",
    // 没有任何字幕时自动识别语音：auto | off（需要支持语音转写的服务商密钥）
    ytTranscript: true,
    // YouTube：优先使用视频自带的转写（整句、与播放进度对齐），而不是读取屏幕上滚动的字幕
    fontScale: 1,
    bg: 0.55,
    pos: null,
    // { cx, by }：字幕块中心横向位置与底边纵向位置，占视频宽/高的比例；null = 默认
    sites: {},
    // { 'www.netflix.com': true }：这个网站打开页面就自动开启
    pickers: {},
    // { 'host': ['css selector', …] }：手动选取的字幕位置
    endpoints: {}
    // 测试用：{ gtx: 'http://127.0.0.1:8788/gtx' }
  };
  var clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function normalize(raw = {}) {
    const s = { ...DEFAULTS, ...raw };
    s.source = ["auto", "zh", "en", "fr"].includes(s.source) ? s.source : "auto";
    s.targets = [...new Set((Array.isArray(s.targets) ? s.targets : [s.targets]).filter((t) => ["zh", "en", "fr"].includes(t)))].slice(0, 2);
    if (!s.targets.length) s.targets = ["zh"];
    s.engine = ["auto", "llm", "gtx", "chrome"].includes(s.engine) ? s.engine : "auto";
    s.showOrig = !!s.showOrig;
    s.hideSite = !!s.hideSite;
    s.ytTranscript = s.ytTranscript !== false;
    s.asr = s.asr === "off" ? "off" : "auto";
    s.fontScale = clamp(+s.fontScale || 1, 0.5, 2.5);
    s.bg = clamp(Number.isFinite(+s.bg) ? +s.bg : 0.55, 0, 1);
    s.pos = s.pos && Number.isFinite(s.pos.cx) && Number.isFinite(s.pos.by) ? { cx: clamp(s.pos.cx, 0, 1), by: clamp(s.pos.by, 0.05, 1) } : null;
    s.sites = s.sites && typeof s.sites === "object" ? s.sites : {};
    s.pickers = s.pickers && typeof s.pickers === "object" ? s.pickers : {};
    s.endpoints = s.endpoints && typeof s.endpoints === "object" ? s.endpoints : {};
    return s;
  }
  var area = (c) => c.storage.sync || c.storage.local;
  async function loadSettings(c = globalThis.chrome) {
    try {
      return normalize(await area(c).get(null));
    } catch {
      return normalize(await c.storage.local.get(null));
    }
  }
  async function saveSettings(patch, c = globalThis.chrome) {
    try {
      await area(c).set(patch);
    } catch {
      await c.storage.local.set(patch);
    }
  }
  function watchSettings(cb, c = globalThis.chrome) {
    const f = (changes, name) => {
      if (name === "sync" || name === "local") loadSettings(c).then(cb);
    };
    c.storage.onChanged.addListener(f);
    return () => c.storage.onChanged.removeListener(f);
  }
  function siteOf(loc = globalThis.location) {
    try {
      const top = loc.ancestorOrigins?.length ? loc.ancestorOrigins[loc.ancestorOrigins.length - 1] : null;
      return new URL(top && top !== "null" ? top : loc.href).hostname;
    } catch {
      return loc.hostname || "";
    }
  }

  // ../extension/src/core/sources.js
  var ADAPTERS = [
    { id: "youtube", label: "YouTube \u5B57\u5E55", host: /(^|\.)youtube(-nocookie)?\.com$/, sel: ".ytp-caption-segment", hide: ".ytp-caption-window-container", rollingSel: ".ytp-caption-window-rollup" },
    { id: "netflix", label: "Netflix \u5B57\u5E55", host: /(^|\.)netflix\.com$/, sel: ".player-timedtext-text-container", hide: ".player-timedtext" },
    { id: "prime", label: "Prime Video \u5B57\u5E55", host: /(^|\.)(primevideo\.com|amazon\.[a-z.]+)$/, sel: ".atvwebplayersdk-captions-text", hide: ".atvwebplayersdk-captions-overlay" },
    { id: "bilibili", label: "\u54D4\u54E9\u54D4\u54E9\u5B57\u5E55", host: /(^|\.)bilibili\.com$/, sel: ".bpx-player-subtitle-panel-text", hide: ".bpx-player-subtitle-wrap" }
  ];
  var clean = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  function leafText(el) {
    const kids = el.querySelectorAll("*");
    if (!kids.length) return clean(el.textContent);
    const out = [];
    for (const k of kids) if (!k.firstElementChild && k.textContent.trim()) out.push(k.textContent);
    return clean(out.length ? out.join(" ") : el.textContent);
  }
  function pickVideo(doc) {
    let best = null, score = 0;
    for (const v of doc.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      const s = r.width * r.height * (v.paused ? 1 : 2);
      if (s > score) {
        best = v;
        score = s;
      }
    }
    return best;
  }
  function domCandidate({ id, label, sel, hide, rollingSel }, doc) {
    return {
      id,
      label,
      hide: hide || sel,
      read() {
        let els;
        try {
          els = doc.querySelectorAll(sel);
        } catch {
          return null;
        }
        if (!els.length) return null;
        const seen = /* @__PURE__ */ new Set(), parts = [];
        for (const e of els) {
          const t = leafText(e);
          if (t && !seen.has(t)) {
            seen.add(t);
            parts.push(t);
          }
        }
        if (!parts.length) return null;
        return { text: parts.join(" "), lang: null, video: pickVideo(doc), rolling: !!(rollingSel && doc.querySelector(rollingSel)) };
      }
    };
  }
  var bestTrack = (tracks, source) => source && source !== "auto" && tracks.find((t) => (t.language || "").toLowerCase().startsWith(source)) || tracks[0];
  function textTrackCandidate(doc, settings, saved) {
    return {
      id: "texttrack",
      label: "\u89C6\u9891\u5B57\u5E55\u8F68\u9053",
      /** 选出当前使用的轨道（没有启用的轨道时，按语言启用一条为 hidden：只读文字，不改变画面） */
      track(video) {
        const tracks = Array.from(video?.textTracks || []).filter((t) => t.kind === "subtitles" || t.kind === "captions");
        if (!tracks.length) return null;
        let active = tracks.filter((t) => t.mode !== "disabled");
        if (!active.length) {
          const t = bestTrack(tracks, settings.source);
          saved.set(t, t.mode);
          t.mode = "hidden";
          active = [t];
        }
        return active.find((t) => t.mode === "showing") || active[0];
      },
      read() {
        const video = pickVideo(doc);
        const track = video && this.track(video);
        if (!track) return null;
        if (settings.hideSite && track.mode === "showing") {
          saved.set(track, "showing");
          track.mode = "hidden";
        }
        const text = Array.from(track.activeCues || []).map((c) => clean(c.text)).filter(Boolean).join(" ");
        return text ? { text, lang: (track.language || "").slice(0, 2).toLowerCase() || null, video, rolling: false } : null;
      },
      /** 整条轨道的全部句子（侧边栏转录用）：轨道已经载入且不止几句时才有。sig 变化说明轨道换了/又载入了新内容 */
      allCues() {
        const video = pickVideo(doc);
        const track = video && this.track(video);
        const cues = track?.cues;
        if (!cues || cues.length < 3) return null;
        const list = [];
        for (let i = 0; i < cues.length; i++) {
          const text = clean(cues[i].text);
          if (text) list.push({ start: cues[i].startTime, end: cues[i].endTime, text });
        }
        return { sig: `${track.language}|${track.label}|${cues.length}`, lang: (track.language || "").slice(0, 2).toLowerCase() || null, cues: list };
      },
      /** 即将出现的字幕（预翻译用）：整条轨道已经载入时才有 */
      upcoming(n = 30, ahead = 90) {
        const video = pickVideo(doc);
        const track = video && this.track(video);
        const cues = track?.cues;
        if (!cues || cues.length < 3) return [];
        const t = video.currentTime, out = [];
        for (let i = 0; i < cues.length && out.length < n; i++) {
          const c = cues[i];
          if (c.endTime < t - 0.5) continue;
          if (c.startTime > t + ahead) break;
          const text = clean(c.text);
          if (text) out.push({ text, start: c.startTime, prev: i > 0 ? clean(cues[i - 1].text) : "" });
        }
        return out;
      },
      restore() {
        for (const [t, m] of saved) {
          try {
            t.mode = m;
          } catch {
          }
        }
        saved.clear();
      }
    };
  }
  var findLineAt = (lines, t) => {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (lines[mid].start <= t + 0.08) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && t < lines[ans].end ? lines[ans] : null;
  };
  function linesCandidate(doc, getTx) {
    return {
      id: "transcript",
      get label() {
        return getTx()?.label || "\u8F6C\u5F55";
      },
      /** 转录已经就绪时，没有当前句就是没有（不要退回去读屏幕字幕，两套断句会互相打架） */
      exclusive: () => !!getTx()?.lines?.length,
      read() {
        const tx = getTx();
        if (!tx?.lines?.length) return null;
        const video = pickVideo(doc);
        if (!video) return null;
        let l = findLineAt(tx.lines, video.currentTime);
        if (!l && tx.recent && Date.now() - tx.recent.at < 7e3 && video.currentTime >= tx.recent.line.start) l = tx.recent.line;
        return l ? { text: l.text, lang: tx.lang || l.lang || null, video, rolling: false, lineId: l.id } : null;
      },
      upcoming(n = 30, ahead = 90) {
        const tx = getTx(), video = pickVideo(doc);
        if (!tx?.lines?.length || !video) return [];
        const t = video.currentTime, out = [];
        for (let i = 0; i < tx.lines.length && out.length < n; i++) {
          const l = tx.lines[i];
          if (l.end < t - 0.5) continue;
          if (l.start > t + ahead) break;
          out.push({ text: l.text, start: l.start, prev: i > 0 ? tx.lines[i - 1].text : "" });
        }
        return out;
      }
    };
  }
  function buildSources(doc, settings, site, getTx = null) {
    const saved = /* @__PURE__ */ new Map();
    const list = [];
    const picked = (settings.pickers?.[site] || []).filter(Boolean);
    if (picked.length) list.push(domCandidate({ id: "picker", label: "\u624B\u52A8\u9009\u53D6\u7684\u5B57\u5E55\u4F4D\u7F6E", sel: picked.join(", ") }, doc));
    const tr = getTx ? linesCandidate(doc, getTx) : null;
    if (tr) list.push(tr);
    for (const a of ADAPTERS) if (a.host.test(site)) list.push(domCandidate(a, doc));
    const tt = textTrackCandidate(doc, settings, saved);
    list.push(tt);
    return { list, textTrack: tt, transcript: tr, hideSelectors: list.filter((c) => c.hide).map((c) => c.hide) };
  }
  function readFirst(sources) {
    for (const c of sources.list) {
      const r = c.read();
      if (r?.text) return { id: c.id, label: c.label, ...r };
      if (c.exclusive?.()) return null;
    }
    return null;
  }
  function seekTo(doc, t, play = false) {
    const v = pickVideo(doc);
    if (!v) return false;
    v.currentTime = Math.max(0, t);
    if (play) v.play?.().catch(() => {
    });
    return true;
  }

  // ../extension/src/core/transcript.js
  var norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  function findMatch(lines, text, start, tol = 3, norms = null) {
    const n = norm(text);
    if (!n) return -1;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if ((norms ? norms[i] : norm(l.text)) !== n) continue;
      const d = start >= l.start && start <= l.end ? 0 : Math.min(Math.abs(start - l.start), Math.abs(start - l.end));
      if (d <= tol && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }
  var lineId = (prefix, start, taken) => {
    let id = `${prefix}${Math.round(start * 1e3)}`, k = 1;
    while (taken.has(id)) id = `${prefix}${Math.round(start * 1e3)}_${k++}`;
    return id;
  };
  function mergeLines(existing, incoming) {
    const out = existing.map((l) => ({ ...l, tr: l.tr ? { ...l.tr } : void 0 }));
    const norms = out.map((l) => norm(l.text));
    const byId = new Map(out.map((l) => [l.id, l]));
    const idx = new Map(out.map((l, i) => [l.id, i]));
    for (const inc of incoming) {
      const n = norm(inc.text);
      let cur = byId.get(inc.id);
      if (cur && norms[idx.get(inc.id)] !== n) cur = null;
      if (!cur && !/^[ta]/.test(inc.id)) {
        const i = findMatch(out, inc.text, inc.start, 3, norms);
        if (i >= 0) cur = out[i];
      }
      if (cur) {
        cur.end = Math.max(cur.end, inc.end);
        if (inc.tr) cur.tr = { ...cur.tr, ...inc.tr };
      } else {
        const l = { ...inc, tr: inc.tr ? { ...inc.tr } : void 0 };
        if (byId.has(l.id)) l.id = lineId("x", l.start, byId);
        out.push(l);
        norms.push(n);
        byId.set(l.id, l);
        idx.set(l.id, out.length - 1);
      }
    }
    return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  }

  // ../extension/src/core/recorder.js
  var Recorder = class {
    constructor() {
      this.reset(null);
    }
    reset(meta) {
      this.meta = meta;
      this.lines = [];
      this.dirty = /* @__PURE__ */ new Set();
      this.loadedTrack = "";
    }
    /** 载入已保存的转录（不算"变化"） */
    load(lines) {
      this.lines = mergeLines([], lines || []);
    }
    /** 字幕轨道的全部句子：cues = [{start,end,text}]。已有的（含译文）保留 */
    loadAll(cues, lang) {
      const incoming = cues.filter((c) => norm(c.text)).map((c) => ({ id: `t${Math.round(c.start * 1e3)}`, start: c.start, end: c.end, text: c.text, lang }));
      const before = new Map(this.lines.map((l) => [l.id, l.end + "|" + l.text]));
      this.lines = mergeLines(this.lines, incoming);
      for (const l of this.lines) if (!before.has(l.id) || before.get(l.id) !== l.end + "|" + l.text) this.dirty.add(l.id);
    }
    /** 追加已识别的句子（语音识别）：按 id 合并 */
    addLines(lines) {
      this.lines = mergeLines(this.lines, lines);
      for (const l of lines) this.dirty.add(l.id);
    }
    /** 用整份新的转录替换（YouTube 转写整理好之后）：旧的网站字幕记录作废，已有的译文按文字沿用 */
    replaceAll(lines) {
      const old = new Map(this.lines.filter((l) => l.tr).map((l) => [norm(l.text), l.tr]));
      this.lines = mergeLines([], lines.map((l) => ({ ...l, tr: old.get(norm(l.text)) || l.tr })));
      this.dirty = new Set(this.lines.map((l) => l.id));
      this.loadedTrack = "replaced";
    }
    /** 网站字幕稳定下来的一句：返回它的 id（已有的就复用） */
    observe(text, t, lang) {
      const i = findMatch(this.lines, text, t);
      if (i >= 0) {
        const l2 = this.lines[i];
        if (t > l2.end) {
          l2.end = t;
          this.dirty.add(l2.id);
        }
        return l2.id;
      }
      const prev = this.lines.filter((l2) => l2.start <= t && t - l2.end < 2).at(-1);
      if (prev && norm(text).startsWith(norm(prev.text)) && prev.id.startsWith("d")) {
        prev.text = text;
        prev.end = t;
        delete prev.tr;
        this.dirty.add(prev.id);
        return prev.id;
      }
      const l = { id: lineId("d", t, new Set(this.lines.map((x) => x.id))), start: t, end: t, text, lang };
      this.lines = mergeLines(this.lines, [l]);
      this.dirty.add(l.id);
      return l.id;
    }
    /** 当前句还在显示：把结束时间推到 t */
    touch(id, t) {
      const l = this.lines.find((x) => x.id === id);
      if (l && t > l.end) {
        l.end = t;
        this.dirty.add(id);
      }
    }
    /** 译文回来了：补给所有同文的句子 */
    attach(text, tr) {
      const n = norm(text);
      for (const l of this.lines) if (norm(l.text) === n) {
        l.tr = { ...l.tr, ...tr };
        this.dirty.add(l.id);
      }
    }
    /** 此刻 t 对应的句子 id（字幕轨道：时间落在哪句；找不到返回 ''） */
    idAt(t) {
      const l = this.lines.find((x) => t >= x.start && t < x.end);
      return l?.id || "";
    }
    /** 缺少某些目标语言译文的句子 */
    missing(targets) {
      return this.lines.filter((l) => targets.some((t) => !l.tr?.[t]));
    }
    /** 取走变化的行（同时清空标记） */
    take() {
      const out = this.lines.filter((l) => this.dirty.has(l.id));
      this.dirty.clear();
      return out;
    }
    get hasDirty() {
      return this.dirty.size > 0;
    }
  };

  // ../extension/src/core/videokey.js
  var DROP = /^(utm_|fbclid$|gclid$|t$|start$|time$|list$|index$|feature$|pp$|si$)/i;
  function videoKeyOf(loc) {
    let u;
    try {
      u = new URL(loc.href);
    } catch {
      return { key: `x:${loc.hostname || ""}${loc.pathname || ""}`, site: loc.hostname || "", url: loc.href || "" };
    }
    const host = u.hostname.replace(/^www\./, "");
    let id = null;
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host)) id = u.searchParams.get("v") || u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1];
    if (id) return { key: `yt:${id}`, site: host, url: `https://www.youtube.com/watch?v=${id}` };
    if (/(^|\.)netflix\.com$/.test(host)) {
      const m = u.pathname.match(/\/watch\/(\d+)/);
      if (m) return { key: `nf:${m[1]}`, site: host, url: `https://www.netflix.com/watch/${m[1]}` };
    }
    const params = [...u.searchParams].filter(([k]) => !DROP.test(k)).sort(([a], [b]) => a < b ? -1 : 1);
    const q = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return { key: `u:${host}${u.pathname.replace(/\/+$/, "")}${q}`, site: host, url: u.origin + u.pathname + q };
  }

  // ../extension/src/core/captions.js
  var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  var decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
  var decode2 = (s) => decodeEntities(decodeEntities(s)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  function parseJson3(data) {
    const cues = [];
    for (const ev of data?.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1e3, end = start + (ev.dDurationMs || 0) / 1e3;
      const timed = ev.segs.some((s) => typeof s.tOffsetMs === "number" && s.tOffsetMs > 0);
      const cue = { start, end: Math.max(end, start + 0.2), text };
      if (timed) {
        cue.words = [];
        for (const s of ev.segs) {
          const toks = String(s.utf8 || "").trim().split(/\s+/).filter(Boolean);
          toks.forEach((w, i) => cue.words.push({ w, t: start + ((s.tOffsetMs || 0) + i * 120) / 1e3 }));
        }
      }
      cues.push(cue);
    }
    return cues;
  }
  function parseXml(xml) {
    const cues = [];
    const s = String(xml || "");
    if (/<p\s[^>]*\bt="/.test(s)) {
      for (const m of s.matchAll(/<p\s+([^>]*)>([\s\S]*?)<\/p>/g)) {
        const at = (k) => {
          const r = new RegExp(`\\b${k}="(\\d+)"`).exec(m[1]);
          return r ? +r[1] : null;
        };
        const t0 = at("t"), d = at("d");
        if (t0 == null) continue;
        const start = t0 / 1e3;
        const segs = [...m[2].matchAll(/<s(?:\s+([^>]*))?>([\s\S]*?)<\/s>/g)];
        const text = decode2(segs.length ? segs.map((x) => x[2]).join("") : m[2]);
        if (!text) continue;
        const cue = { start, end: start + (d || 0) / 1e3 || start + 2, text };
        if (segs.length > 1) {
          cue.words = [];
          for (const x of segs) {
            const off = /\bt="(\d+)"/.exec(x[1] || "");
            const w = decode2(x[2]);
            if (w) cue.words.push({ w, t: start + (off ? +off[1] : 0) / 1e3 });
          }
        }
        cues.push(cue);
      }
      return cues;
    }
    for (const m of s.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/g)) {
      const st = /\bstart="([\d.]+)"/.exec(m[1]), du = /\bdur="([\d.]+)"/.exec(m[1]);
      if (!st) continue;
      const text = decode2(m[2]);
      if (!text) continue;
      const start = +st[1];
      cues.push({ start, end: start + (du ? +du[1] : 2), text });
    }
    return cues;
  }
  function cuesFromPanel(items) {
    const rows = items.filter((x) => Number.isFinite(x.t) && x.text?.trim()).sort((a, b) => a.t - b.t);
    return rows.map((r, i) => ({ start: r.t, end: Math.max(r.t + 0.5, rows[i + 1]?.t ?? r.t + 5), text: r.text.replace(/\s+/g, " ").trim() }));
  }
  function parseTimestamp(s) {
    const p = String(s || "").trim().split(":").map(Number);
    if (!p.length || p.some((x) => !Number.isFinite(x))) return NaN;
    return p.reduce((a, x) => a * 60 + x, 0);
  }
  function extractCaptionTracksFromHtml(html) {
    const i = String(html).indexOf('"captionTracks":');
    if (i < 0) return [];
    const a = html.indexOf("[", i);
    if (a < 0) return [];
    let depth = 0, inStr = false, esc = false;
    for (let k = a; k < html.length; k++) {
      const c = html[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        try {
          return JSON.parse(html.slice(a, k + 1));
        } catch {
          return [];
        }
      }
    }
    return [];
  }
  var trackName = (t) => typeof t.name === "string" ? t.name : t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || "";
  function pickTrack(tracks, { source = "auto" } = {}) {
    const list = (tracks || []).filter((t) => t?.baseUrl && t.languageCode);
    const lang = (t) => t.languageCode.slice(0, 2).toLowerCase();
    const pool = source !== "auto" ? list.filter((t) => lang(t) === source) : list;
    if (!pool.length) return null;
    const asr = pool.find((t) => t.kind === "asr");
    const manual = pool.filter((t) => t.kind !== "asr");
    const pick = asr && manual.find((t) => lang(t) === lang(asr)) || asr || manual[0];
    return { track: pick, lang: lang(pick), kind: pick.kind === "asr" ? "asr" : "manual", name: trackName(pick) };
  }
  function withFormat(url, fmt) {
    const u = new URL(url);
    if (fmt) u.searchParams.set("fmt", fmt);
    else u.searchParams.delete("fmt");
    return u.toString();
  }
  var isYouTubeUrl = (url) => {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) && /(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  };

  // ../extension/src/core/segment.js
  var TERMINAL = /[.!?…。！？]["'”’»)\]]*$/;
  var COMMA = /[,;:，；：、]["'”’)\]]*$/;
  var ABBR = /* @__PURE__ */ new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "m", "mme", "mlle", "mm", "etc", "cf", "no", "p", "fig"]);
  var BOUNDARY = /* @__PURE__ */ new Set(["and", "so", "but", "because", "which", "where", "then", "okay", "ok", "now", "if", "while", "however", "also", "right", "alright", "et", "mais", "donc", "parce", "alors", "puis", "maintenant", "ensuite", "sinon", "quand", "comme", "car"]);
  var NOISE = /^(\[[^\]]*\]|\([^)]*\)|♪+|♫+|[-–—]+)$/;
  var isCjk = (lang) => lang === "zh" || lang === "ja";
  var bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  var wordDur = (w) => Math.min(0.9, 0.12 + 0.065 * [...w].length);
  function cuesToWords(cues, lang = "en") {
    const words = [];
    const cjk = isCjk(lang);
    let prevEnd = null;
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    for (const cue of sorted) {
      let toks;
      if (cue.words?.length) toks = cue.words.map((x) => ({ w: x.w, t: x.t, timed: true }));
      else {
        const parts = cjk ? [...cue.text.replace(/\s+/g, "")] : cue.text.split(/\s+/).filter(Boolean);
        const total = parts.reduce((s, p) => s + [...p].length + 1, 0) || 1;
        let acc = 0;
        toks = parts.map((w) => {
          const t = cue.start + (cue.end - cue.start) * acc / total;
          acc += [...w].length + 1;
          return { w, t, timed: false };
        });
      }
      toks.forEach((x, i) => {
        if (NOISE.test(x.w)) return;
        const prev = words.at(-1);
        let gap;
        if (x.timed && prev && prev.timed) gap = Math.max(0, x.t - (prev.t + wordDur(prev.w)));
        else if (i === 0 && prevEnd != null) gap = Math.max(0, cue.start - prevEnd);
        else gap = 0;
        words.push({ w: x.w, t: x.t, gap, timed: x.timed });
      });
      prevEnd = cue.end;
    }
    return dropRepeats(words);
  }
  function dropRepeats(words) {
    const out = [];
    for (const w of words) {
      out.push(w);
      for (let k = Math.min(12, Math.floor(out.length / 2)); k >= 3; k--) {
        let same = true;
        for (let j = 1; j <= k; j++) if (bare(out[out.length - j].w) !== bare(out[out.length - j - k].w)) {
          same = false;
          break;
        }
        if (same) {
          out.length -= k;
          break;
        }
      }
    }
    return out;
  }
  var isAbbrev = (w) => {
    const b = bare(w.replace(/\.+$/, ""));
    return b.length <= 4 && ABBR.has(b) && /\.$/.test(w);
  };
  var endsSentence = (w) => TERMINAL.test(w) && !isAbbrev(w) && !/^\d+[.,]\d*$/.test(w);
  function segmentSentences(words, { lang = "en", maxWords = 26, maxSec = 9, minWords = 3 } = {}) {
    if (!words.length) return [];
    const cjk = isCjk(lang);
    const maxW = cjk ? maxWords * 2 : maxWords, minW = cjk ? minWords * 2 : minWords, five = cjk ? 10 : 5;
    const punctuated = words.filter((x) => endsSentence(x.w)).length >= Math.max(2, words.length / 60);
    const chunks = [];
    let cur = [];
    words.forEach((x, i) => {
      cur.push(x);
      const next = words[i + 1];
      const brk = !next || endsSentence(x.w) && (cur.length >= minW || (next.gap || 0) > 0.8) || !punctuated && (next.gap >= 0.5 && cur.length >= five || next.gap >= 0.7 && cur.length >= minW || next.gap >= 1.2 && cur.length >= 2);
      if (brk) {
        chunks.push(cur);
        cur = [];
      }
    });
    const split = (c) => {
      const dur = c.at(-1).t - c[0].t;
      if (c.length <= maxW && dur <= maxSec) return [c];
      let best = -1, bestScore = -Infinity;
      for (let i = minW; i <= c.length - minW; i++) {
        const prev = c[i - 1].w, nx = c[i];
        const score = (nx.gap || 0) * 2 + (COMMA.test(prev) ? 0.9 : 0) + (BOUNDARY.has(bare(nx.w)) ? 0.5 : 0) - Math.abs(i - c.length / 2) * 0.03;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best < 0) best = Math.floor(c.length / 2);
      return [...split(c.slice(0, best)), ...split(c.slice(best))];
    };
    let parts = chunks.flatMap(split);
    const fits = (a, b) => a.length + b.length <= maxW && b.at(-1).t - a[0].t <= maxSec;
    for (let i = 0; i < parts.length; ) {
      const c = parts[i];
      if (c.length >= minW || parts.length === 1) {
        i++;
        continue;
      }
      const prev = parts[i - 1], next = parts[i + 1];
      const gp = prev ? c[0].gap || 0 : Infinity, gn = next ? next[0].gap || 0 : Infinity;
      if (prev && gp <= gn && fits(prev, c)) {
        parts[i - 1] = [...prev, ...c];
        parts.splice(i, 1);
      } else if (next && fits(c, next)) {
        parts[i] = [...c, ...next];
        parts.splice(i + 1, 1);
      } else i++;
    }
    return parts.map((c, i) => {
      const nextStart = parts[i + 1]?.[0].t;
      const last = c.at(-1);
      let end = last.t + wordDur(last.w) + 0.25;
      if (nextStart != null) end = Math.min(end, nextStart);
      const start = c[0].t;
      end = Math.max(end, start + 0.6);
      return { start, end, text: finish(c.map((x) => x.w), cjk, lang) };
    });
  }
  function finish(ws, cjk, lang) {
    let t = cjk ? ws.join("") : ws.join(" ");
    t = t.replace(/\s+([,.;:!?…])/g, "$1").replace(/\s{2,}/g, " ").trim();
    if (lang === "fr") t = t.replace(new RegExp("(\\p{L})\\s*([?!])", "gu"), "$1 $2");
    if (!cjk) t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!TERMINAL.test(t)) t += cjk ? "\u3002" : ".";
    return t;
  }
  var cuesToSentences = (cues, lang, opts) => segmentSentences(cuesToWords(cues, lang), { lang, ...opts });

  // ../extension/src/core/langs.js
  var LANGS = { zh: "\u4E2D\u6587", en: "\u82F1\u8BED", fr: "\u6CD5\u8BED" };
  var SOURCE_OPTIONS = { auto: "\u81EA\u52A8\u5224\u65AD", ...LANGS };
  var FR = new Set(`le la les un une des du de au aux et est sont pas ne que qui quoi dans pour avec sur mais ou o\xF9 donc car ce cet cette ces je tu il elle nous vous ils elles on mon ma mes ton ta tes son sa ses notre votre leur leurs oui non tr\xE8s bien \xEAtre avoir fait faire suis es \xEAtes sommes ai as avons avez ont merci bonjour bonsoir salut monsieur madame mademoiselle alors comme aussi encore toujours jamais rien tout tous toute plus moins peu beaucoup d\xE9j\xE0 jusqu aujourd hui chez sans sous entre vers depuis pendant \xE7a ici l\xE0 voil\xE0 allez viens vas veux peux dois faut puis parce quand comment pourquoi quel quelle quels`.split(/\s+/));
  var EN = new Set(`the a an and is are was were not no that this these those with for you i he she we they it my your his her our their yes very be been being have has had do does did of to in on at but or so if what who how why when where can could will would just there here from by as about up out get got go going know think want like see say okay hello thanks thank please sorry don't doesn't didn't can't won't isn't aren't it's i'm you're we're they're that's what's let's gonna wanna gotta yeah nope`.split(/\s+/));
  var ELISION = /^(l|d|j|n|qu|c|m|t|s|jusqu|lorsqu|puisqu)['’]/i;
  function detectLang(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
    const letters = (s.match(new RegExp("\\p{L}", "gu")) || []).length;
    if (!letters) return null;
    if (han / letters > 0.3) return "zh";
    let fr = 0, en = 0;
    for (const raw of s.toLowerCase().split(/[^\p{L}'’]+/u)) {
      if (!raw) continue;
      if (ELISION.test(raw)) fr += 1;
      const w = raw.replace(/^['’]+|['’]+$/g, "");
      if (FR.has(w)) fr += 1;
      if (EN.has(raw) || EN.has(w)) en += 1;
    }
    fr += (s.match(/[éèêàùûçœîïôâë]/gi) || []).length * 0.7;
    if (fr === 0 && en === 0) return null;
    return fr > en ? "fr" : en > fr ? "en" : null;
  }

  // ../extension/src/core/yt.js
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function askPlayerData(win, videoId, timeout = 1500) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (v) => {
        win.removeEventListener("message", on);
        clearTimeout(timer);
        resolve(v);
      };
      const on = (e) => {
        if (e.source === win && e.data?.type === "lectureloop:yt-data" && e.data.id === id) done(e.data.payload);
      };
      const timer = setTimeout(() => done(null), timeout);
      win.addEventListener("message", on);
      win.postMessage({ type: "lectureloop:yt-request", id, videoId }, "*");
    });
  }
  async function fetchCues(baseUrl, fetchFn) {
    for (const fmt of ["json3", null]) {
      let text = "";
      try {
        const r = await fetchFn(withFormat(baseUrl, fmt), { credentials: "include" });
        if (!r.ok) continue;
        text = await r.text();
      } catch {
        continue;
      }
      if (!text.trim()) continue;
      let cues = [];
      try {
        cues = parseJson3(JSON.parse(text));
      } catch {
        cues = parseXml(text);
      }
      if (cues.length) return cues;
    }
    return [];
  }
  function observedTimedtextUrl(win, videoId) {
    try {
      const e = win.performance.getEntriesByType("resource").filter((x) => x.name.includes("timedtext") && x.name.includes(`v=${videoId}`) && isYouTubeUrl(x.name));
      return e.length ? e[e.length - 1].name : "";
    } catch {
      return "";
    }
  }
  var SEG = "ytd-transcript-segment-renderer, transcript-segment-view-model";
  var TS = '.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp, [class*="TranscriptSegmentViewModelTimestamp"]';
  var TX = '.segment-text, .yt-core-attributed-string, [class*="TranscriptSegmentViewModelText"]';
  var TX_BTN = /transcript|transcription|转写|转录|文字记录|transcripción/i;
  async function scrapePanel(doc, { wait = 6e3 } = {}) {
    let opened = false;
    if (!doc.querySelector(SEG)) {
      let btn = doc.querySelector("ytd-video-description-transcript-section-renderer button");
      if (!btn) btn = [...doc.querySelectorAll("#description button, ytd-watch-metadata button, #above-the-fold button")].find((b) => TX_BTN.test(b.getAttribute("aria-label") || "") || TX_BTN.test(b.textContent || ""));
      if (!btn) return [];
      btn.click();
      opened = true;
      for (let t = 0; t < wait && !doc.querySelector(SEG); t += 200) await sleep(200);
    }
    const rows = [...doc.querySelectorAll(SEG)].map((el) => ({
      t: parseTimestamp(el.querySelector(TS)?.textContent),
      text: el.querySelector(TX)?.textContent || ""
    }));
    if (opened) doc.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button, [target-id="engagement-panel-searchable-transcript"] [aria-label="Close"], [target-id="engagement-panel-searchable-transcript"] #visibility-button button')?.click();
    return cuesFromPanel(rows);
  }
  async function loadYouTubeTranscript({ win, doc, videoId, settings = {}, fetchFn = (u, i) => win.fetch(u, i) }) {
    const origin = win.location.origin;
    let tracks = [];
    const data = await askPlayerData(win, videoId);
    if (data?.videoId === videoId && data.tracks?.length) tracks = data.tracks;
    if (!tracks.length) {
      try {
        const r = await fetchFn(`${origin}/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
        if (r.ok) tracks = extractCaptionTracksFromHtml(await r.text());
      } catch {
      }
    }
    tracks = tracks.map((t) => ({ ...t, baseUrl: t.baseUrl && new URL(t.baseUrl, origin).toString() })).filter((t) => isYouTubeUrl(t.baseUrl));
    const choice = pickTrack(tracks, { source: settings.source || "auto" });
    let cues = [], kind = choice?.kind, lang = choice?.lang, name = choice?.name || "";
    if (choice) cues = await fetchCues(choice.track.baseUrl, fetchFn);
    if (!cues.length) {
      const seen = observedTimedtextUrl(win, videoId);
      if (seen) {
        cues = await fetchCues(seen, fetchFn);
        if (cues.length) {
          const l = new URL(seen).searchParams.get("lang") || "";
          kind ||= new URL(seen).searchParams.get("kind") === "asr" ? "asr" : "manual";
          lang ||= l.slice(0, 2).toLowerCase() || void 0;
          name = "\u64AD\u653E\u5668\u8BF7\u6C42\u8FC7\u7684\u5B57\u5E55";
        }
      }
    }
    if (!cues.length) {
      cues = await scrapePanel(doc);
      if (cues.length) {
        kind = "panel";
        name = "\u8F6C\u5199\u6587\u5B57\u9762\u677F";
        lang = settings.source && settings.source !== "auto" ? settings.source : null;
      }
    }
    if (!cues.length) throw new Error(tracks.length ? "\u5B57\u5E55\u6570\u636E\u53D6\u4E0D\u5230\uFF08YouTube \u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF09" : "\u8FD9\u4E2A\u89C6\u9891\u6CA1\u6709\u53EF\u7528\u7684\u8F6C\u5199\u6216\u5B57\u5E55");
    lang ||= detectLang(cues.slice(0, 40).map((c) => c.text).join(" ")) || "en";
    const sentences = cuesToSentences(cues, lang);
    if (!sentences.length) throw new Error("\u8F6C\u5199\u91CC\u6CA1\u6709\u53EF\u7528\u7684\u6587\u5B57");
    const lines = sentences.map((s) => ({ id: `t${Math.round(s.start * 1e3)}`, start: s.start, end: s.end, text: s.text, lang }));
    return { lines, lang, kind, name, words: cues.reduce((n, c) => n + (c.words?.length || c.text.split(/\s+/).length), 0) };
  }

  // ../extension/src/core/pcm.js
  var Resampler = class {
    constructor(inRate, outRate = 16e3) {
      this.ratio = inRate / outRate;
      this.tail = new Float32Array(0);
      this.pos = 0;
    }
    process(input) {
      const buf = new Float32Array(this.tail.length + input.length);
      buf.set(this.tail);
      buf.set(input, this.tail.length);
      const out = [];
      let pos = this.pos;
      while (pos + this.ratio <= buf.length) {
        const a = Math.floor(pos), b = Math.max(a + 1, Math.floor(pos + this.ratio));
        let s = 0;
        for (let i = a; i < b; i++) s += buf[i];
        out.push(s / (b - a));
        pos += this.ratio;
      }
      const used = Math.floor(pos);
      this.tail = buf.slice(used);
      this.pos = pos - used;
      return Float32Array.from(out);
    }
  };
  var rms = (f) => {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    return Math.sqrt(s / (f.length || 1));
  };
  var Chunker = class {
    constructor({ sr = 16e3, frame = 0.02, minSec = 2.2, maxSec = 12, silenceSec = 0.45, shortSilence = 1.1, preRoll = 0.25, minSpeech = 0.45, onChunk }) {
      Object.assign(this, { sr, minSec, maxSec, silenceSec, shortSilence, preRoll, minSpeech, onChunk });
      this.fs = Math.round(sr * frame);
      this.frameSec = this.fs / sr;
      this.rest = new Float32Array(0);
      this.restStart = 0;
      this.noise = 4e-3;
      this.pre = [];
      this.cur = null;
    }
    reset() {
      this.rest = new Float32Array(0);
      this.pre = [];
      this.cur = null;
    }
    push(samples, mediaStart, rate = 1) {
      const buf = new Float32Array(this.rest.length + samples.length);
      buf.set(this.rest);
      buf.set(samples, this.rest.length);
      const t0 = this.rest.length ? this.restStart : mediaStart;
      let i = 0;
      for (; i + this.fs <= buf.length; i += this.fs) this._frame(buf.subarray(i, i + this.fs), t0 + i / this.sr * rate, rate);
      this.rest = buf.slice(i);
      this.restStart = t0 + i / this.sr * rate;
    }
    _frame(f, t, rate) {
      const e = rms(f);
      const speech = e > Math.max(0.012, this.noise * 2.6);
      if (!speech) this.noise = e < this.noise ? this.noise * 0.9 + e * 0.1 : this.noise * 1.0006 + e * 4e-4;
      if (!this.cur) {
        if (!speech) {
          this.pre.push(f);
          if (this.pre.length > Math.ceil(this.preRoll / this.frameSec)) this.pre.shift();
          return;
        }
        const frames = [...this.pre, f];
        this.cur = { frames, start: t - this.pre.length * this.frameSec * rate, speechFrames: 1, silentRun: 0, rate };
        this.pre = [];
        return;
      }
      const c = this.cur;
      c.frames.push(f);
      if (speech) {
        c.speechFrames++;
        c.silentRun = 0;
      } else c.silentRun += this.frameSec;
      const dur = c.frames.length * this.frameSec;
      if (dur >= this.maxSec || dur >= this.minSec && c.silentRun >= this.silenceSec || c.silentRun >= this.shortSilence) this._cut();
    }
    _cut() {
      const c = this.cur;
      this.cur = null;
      if (!c) return;
      const speechSec = c.speechFrames * this.frameSec;
      let n = c.frames.length;
      const keep = Math.ceil(0.2 / this.frameSec), trail = Math.floor(c.silentRun / this.frameSec);
      if (trail > keep) n -= trail - keep;
      if (speechSec < this.minSpeech) return;
      const pcm = new Float32Array(n * this.fs);
      for (let k = 0; k < n; k++) pcm.set(c.frames[k], k * this.fs);
      this.onChunk({ pcm, start: c.start, end: c.start + pcm.length / this.sr * c.rate, speechSec, rate: c.rate });
    }
    /** 视频跳转 / 暂停 / 结束：把已经攒下的这一块吐出去 */
    flush() {
      this._cut();
      this.pre = [];
      this.rest = new Float32Array(0);
    }
  };
  function encodeWav(f32, sr = 16e3) {
    const n = f32.length, out = new Uint8Array(44 + n * 2), dv = new DataView(out.buffer);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
    };
    w(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    w(8, "WAVEfmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    w(36, "data");
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      dv.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return out;
  }
  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  }

  // ../extension/src/core/asr.js
  var AsrSession = class {
    constructor({ video, win, onChunk, onProblem = () => {
    } }) {
      this.video = video;
      this.win = win;
      this.onChunk = onChunk;
      this.onProblem = onProblem;
      this.lastEnd = null;
      this.silentMs = 0;
      this.heard = false;
      this.running = false;
      this.problem = "";
    }
    async start() {
      const v = this.video;
      const stream = v.captureStream ? v.captureStream() : v.mozCaptureStream ? v.mozCaptureStream() : null;
      const tracks = stream?.getAudioTracks?.() || [];
      if (!tracks.length) throw new Error("\u8FD9\u4E2A\u89C6\u9891\u62FF\u4E0D\u5230\u97F3\u9891\u8F68\u9053");
      const AC = this.win.AudioContext || this.win.webkitAudioContext;
      this.ctx = new AC();
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {
      });
      this.src = this.ctx.createMediaStreamSource(new this.win.MediaStream(tracks));
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      this.res = new Resampler(this.ctx.sampleRate, 16e3);
      this.chunker = new Chunker({ onChunk: (c) => this.onChunk(c) });
      this.proc.onaudioprocess = (e) => this._process(e.inputBuffer.getChannelData(0));
      this.src.connect(this.proc);
      this.proc.connect(this.ctx.destination);
      this.running = true;
    }
    _process(data) {
      const v = this.video, rate = v.playbackRate || 1;
      const dur = data.length / this.ctx.sampleRate * rate;
      const mediaStart = v.currentTime - dur;
      if (this.lastEnd != null && Math.abs(mediaStart - this.lastEnd) > 1) {
        this.chunker.flush();
      }
      this.lastEnd = v.currentTime;
      let peak = 0;
      for (let i = 0; i < data.length; i += 16) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (peak > 1e-4) {
        this.heard = true;
        this.silentMs = 0;
      } else if (!v.paused) {
        this.silentMs += data.length / this.ctx.sampleRate * 1e3;
        if (!this.heard && this.silentMs > 12e3 && !this.problem) {
          this.problem = "drm";
          this.onProblem("drm");
        }
      }
      this.chunker.push(this.res.process(data), Math.max(0, mediaStart), rate);
    }
    stop() {
      this.running = false;
      try {
        this.chunker?.flush();
      } catch {
      }
      try {
        this.proc && (this.proc.onaudioprocess = null);
        this.src?.disconnect();
        this.proc?.disconnect();
        this.ctx?.close();
      } catch {
      }
    }
  };

  // ../extension/src/core/stabilizer.js
  var Stabilizer = class {
    constructor({ onSettle, quickMs = 90, rollingMs = 550, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } }) {
      this.onSettle = onSettle;
      this.quickMs = quickMs;
      this.rollingMs = rollingMs;
      this.t = timers;
      this.text = "";
      this.timer = null;
      this.settled = "";
    }
    /** rollingHint：来源已知是滚动字幕（如 YouTube 自动字幕）时为 true */
    push(text, rollingHint = false) {
      text = String(text || "").trim();
      if (text === this.text) return this.text;
      const prev = this.text;
      this.text = text;
      this.t.clear(this.timer);
      this.timer = null;
      if (!text) return text;
      const rolling = rollingHint || !!prev && (text.startsWith(prev) || prev.startsWith(text) || sharedPrefix(prev, text) >= Math.min(prev.length, text.length) * 0.6);
      this.timer = this.t.set(() => {
        this.timer = null;
        this.settled = this.text;
        this.onSettle(this.text);
      }, rolling ? this.rollingMs : this.quickMs);
      return text;
    }
    clear() {
      this.t.clear(this.timer);
      this.timer = null;
      this.text = "";
      this.settled = "";
    }
  };
  function sharedPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  // ../extension/src/core/translator.js
  var TranslateQueue = class {
    /** send({source,targets,items:[{i,t}],context}) → Promise<{provider?,note?,results:{zh:[{i,t}]}}> */
    constructor({ send, maxBatch = 8, bgBatch = 12, cap = 3e3, onError, onOk, onResult, now = () => Date.now() }) {
      this.onResult = onResult || (() => {
      });
      this.send = send;
      this.maxBatch = maxBatch;
      this.bgBatch = bgBatch;
      this.cap = cap;
      this.onError = onError || (() => {
      });
      this.onOk = onOk || (() => {
      });
      this.now = now;
      this.cache = /* @__PURE__ */ new Map();
      this.pendingByKey = /* @__PURE__ */ new Map();
      this.q = { live: [], bg: [] };
      this.running = { live: false, bg: false };
      this.bgPausedUntil = 0;
      this.stats = { ok: 0, failed: 0 };
    }
    key(text, source, targets) {
      return `${source}|${[...targets].sort().join(",")}|${text}`;
    }
    peek(text, source, targets) {
      return this.cache.get(this.key(text, source, targets));
    }
    clear() {
      this.cache.clear();
    }
    /** 直接放入一条已知的译文（来自已保存的转录）：这句再出现时立即命中，不请求翻译 */
    seed(text, source, targets, tr) {
      this._store(this.key(text, source, targets), tr);
    }
    /** → Promise<{[target]: string}>；失败时得到 {} */
    translate(text, { source = "auto", targets, context = [], prio = "live" }) {
      const key = this.key(text, source, targets);
      const hit = this.cache.get(key);
      if (hit) return Promise.resolve(hit);
      const inflight = this.pendingByKey.get(key);
      if (inflight) {
        if (prio === "live") this._promote(key);
        return inflight.promise;
      }
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      const entry = { key, text, source, targets: [...targets], context, resolve, prio, promise };
      this.pendingByKey.set(key, entry);
      this.q[prio].push(entry);
      this._pump();
      return promise;
    }
    _promote(key) {
      const e = this.pendingByKey.get(key);
      if (!e || e.prio === "live" || e.sent) return;
      const i = this.q.bg.indexOf(e);
      if (i >= 0) {
        this.q.bg.splice(i, 1);
        e.prio = "live";
        this.q.live.push(e);
        this._pump();
      }
    }
    _pump() {
      for (const prio of ["live", "bg"]) {
        if (this.running[prio] || !this.q[prio].length) continue;
        if (prio === "bg" && this.now() < this.bgPausedUntil) continue;
        const first = this.q[prio][0];
        const sig = `${first.source}|${first.targets.join(",")}`;
        const max = prio === "live" ? this.maxBatch : this.bgBatch;
        const batch = [];
        for (let i = 0; i < this.q[prio].length && batch.length < max; ) {
          const e = this.q[prio][i];
          if (`${e.source}|${e.targets.join(",")}` === sig) {
            batch.push(e);
            this.q[prio].splice(i, 1);
          } else i++;
        }
        this._run(prio, batch);
      }
    }
    async _run(prio, batch) {
      this.running[prio] = true;
      batch.forEach((e) => {
        e.sent = true;
      });
      const items = batch.map((e, i) => ({ i, t: e.text }));
      const first = batch[0];
      try {
        const r = await this.send({ source: first.source, targets: first.targets, items, context: first.context });
        const per = batch.map(() => ({}));
        for (const [target, arr] of Object.entries(r?.results || {})) for (const { i, t } of arr || []) if (per[i] && t) per[i][target] = t;
        batch.forEach((e, n) => {
          const out = per[n];
          if (Object.keys(out).length) {
            this._store(e.key, out);
            this.stats.ok++;
            this.onResult({ text: e.text, source: e.source, targets: e.targets, tr: out });
          }
          this.pendingByKey.delete(e.key);
          e.resolve(out);
        });
        this.onOk(r);
      } catch (err) {
        this.stats.failed += batch.length;
        batch.forEach((e) => {
          this.pendingByKey.delete(e.key);
          e.resolve({});
        });
        if (prio === "bg") this.bgPausedUntil = this.now() + 1e4;
        this.onError(err);
      } finally {
        this.running[prio] = false;
        this._pump();
      }
    }
    _store(key, val) {
      this.cache.set(key, val);
      if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value);
    }
  };

  // ../extension/src/core/overlay.js
  var CSS2 = `
:host{all:initial}
.stage{position:fixed;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.box{position:absolute;transform:translate(-50%,-100%);width:max-content;max-width:82%;min-width:20px;text-align:center;color:#fff;border-radius:10px;padding:.3em .7em .35em;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;line-height:1.35;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 6px rgba(0,0,0,.6)}
.box.drag{cursor:grabbing}
.o{font-size:.78em;opacity:.82;margin-bottom:.12em}
.t{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}
.t.t2{color:#ffe08a;font-size:.92em;font-weight:500}
.ctl{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);display:none;gap:2px;padding:2px;border-radius:8px;background:rgba(20,22,28,.92);font-size:13px;white-space:nowrap;text-shadow:none}
.box:hover .ctl,.box:focus-within .ctl{display:flex}
.ctl button{all:unset;cursor:pointer;color:#fff;padding:3px 8px;border-radius:6px;font:600 12px/1.2 system-ui,sans-serif}
.ctl button:hover,.ctl button:focus-visible{background:rgba(255,255,255,.2)}
.ctl button.on{background:#3b5bdb}
.warn{position:absolute;right:-6px;top:-6px;width:16px;height:16px;border-radius:50%;background:#e03131;color:#fff;font:700 11px/16px system-ui;text-align:center;display:none;cursor:help}
.box.err .warn{display:block}
`;
  var Overlay = class {
    /** onChange(patch)：用户在悬浮层上的操作（拖动 / 字号 / 显示原文 / 关闭）；patch 为设置补丁，或 { off: true } */
    constructor({ doc = document, onChange = () => {
    } } = {}) {
      this.doc = doc;
      this.onChange = onChange;
      this.host = doc.createElement("lectureloop-subtitles");
      this.host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;";
      this.root = this.host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = CSS2;
      this.stage = doc.createElement("div");
      this.stage.className = "stage";
      this.box = doc.createElement("div");
      this.box.className = "box";
      this.box.hidden = true;
      this.ctl = doc.createElement("div");
      this.ctl.className = "ctl";
      this.btn = {};
      for (const [k, label, title] of [["dec", "A\u2212", "\u7F29\u5C0F\u5B57\u53F7"], ["inc", "A\uFF0B", "\u653E\u5927\u5B57\u53F7"], ["orig", "\u539F", "\u540C\u65F6\u663E\u793A\u539F\u6587"], ["off", "\u2715", "\u5173\u95ED\u5B57\u5E55\u7FFB\u8BD1\uFF08Alt+T \u518D\u6B21\u5F00\u542F\uFF09"]]) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.dataset.k = k;
        this.btn[k] = b;
        this.ctl.append(b);
      }
      this.warn = doc.createElement("div");
      this.warn.className = "warn";
      this.warn.textContent = "!";
      this.o = doc.createElement("div");
      this.o.className = "o";
      this.t1 = doc.createElement("div");
      this.t1.className = "t t1";
      this.t2 = doc.createElement("div");
      this.t2.className = "t t2";
      this.box.append(this.ctl, this.warn, this.o, this.t1, this.t2);
      this.stage.append(this.box);
      this.root.append(style, this.stage);
      this.opts = { fontScale: 1, bg: 0.55, showOrig: false, hideSite: false, pos: null };
      this.anchor = null;
      this.rect = { left: 0, top: 0, width: 800, height: 450 };
      this._bind();
      this.mount();
      this._fs = () => this.mount();
      doc.addEventListener("fullscreenchange", this._fs);
      doc.addEventListener("webkitfullscreenchange", this._fs);
    }
    /** 挂载点：全屏时必须在全屏元素里，否则看不见 */
    mount() {
      const fs = this.doc.fullscreenElement || this.doc.webkitFullscreenElement;
      const parent = fs && fs.tagName !== "VIDEO" ? fs : this.doc.documentElement;
      if (this.host.parentNode !== parent) parent.append(this.host);
      this.layout();
    }
    _bind() {
      this.ctl.addEventListener("click", (e) => {
        const k = e.target?.dataset?.k;
        if (!k) return;
        e.stopPropagation();
        if (k === "dec") this.onChange({ fontScale: Math.max(0.5, +(this.opts.fontScale - 0.1).toFixed(2)) });
        else if (k === "inc") this.onChange({ fontScale: Math.min(2.5, +(this.opts.fontScale + 0.1).toFixed(2)) });
        else if (k === "orig") this.onChange({ showOrig: !this.opts.showOrig });
        else if (k === "off") this.onChange({ off: true });
      });
      let drag = null;
      this.box.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".ctl") || e.button !== 0) return;
        const r = this.box.getBoundingClientRect();
        drag = { dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - r.bottom };
        this.box.setPointerCapture(e.pointerId);
        this.box.classList.add("drag");
      });
      this.box.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const cx = (e.clientX - drag.dx - this.rect.left) / this.rect.width, by = (e.clientY - drag.dy - this.rect.top) / this.rect.height;
        this.opts.pos = { cx: Math.min(1, Math.max(0, cx)), by: Math.min(1, Math.max(0.05, by)) };
        this._place();
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        this.box.classList.remove("drag");
        if (this.opts.pos) this.onChange({ pos: this.opts.pos });
      };
      this.box.addEventListener("pointerup", end);
      this.box.addEventListener("pointercancel", end);
    }
    setOptions(o) {
      this.opts = { ...this.opts, ...o };
      this.btn.orig.classList.toggle("on", !!this.opts.showOrig || !!this.opts.hideSite);
      this._style();
      this._place();
    }
    setAnchor(video) {
      this.anchor = video || null;
      this.layout();
    }
    /** 跟随视频的位置与大小 */
    layout() {
      const w = this.doc.defaultView;
      const r = this.anchor?.isConnected ? this.anchor.getBoundingClientRect() : { left: 0, top: 0, width: w.innerWidth, height: w.innerHeight };
      const next = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
      const same = ["left", "top", "width", "height"].every((k) => Math.abs(next[k] - this.rect[k]) < 0.5);
      this.rect = next;
      if (!same || !this.stage.style.width) {
        Object.assign(this.stage.style, { left: next.left + "px", top: next.top + "px", width: next.width + "px", height: next.height + "px" });
        this._style();
        this._place();
      }
    }
    _style() {
      const fs = Math.max(13, this.rect.height * 0.045 * this.opts.fontScale);
      this.box.style.fontSize = fs + "px";
      this.box.style.background = `rgba(0,0,0,${this.opts.bg})`;
    }
    _place() {
      const p = this.opts.pos || { cx: 0.5, by: this.opts.hideSite ? 0.93 : 0.8 };
      this.box.style.left = p.cx * 100 + "%";
      this.box.style.top = p.by * 100 + "%";
    }
    /** orig：原文；tr：{ [lang]: 译文 }；targets：显示顺序；error：翻译出错时的提示 */
    show({ orig = "", tr = {}, targets = [], error = "", forceOrig = false }) {
      const texts = targets.map((t) => tr[t]).filter(Boolean);
      const showO = (this.opts.showOrig || this.opts.hideSite || forceOrig || !!error && !texts.length) && !!orig;
      this.o.textContent = showO ? orig : "";
      this.o.hidden = !showO;
      this.t1.textContent = texts[0] || "";
      this.t1.hidden = !texts[0];
      this.t2.textContent = texts[1] || "";
      this.t2.hidden = !texts[1];
      this.box.hidden = !(showO || texts.length > 0);
      this.box.classList.toggle("err", !!error);
      this.warn.title = error || "";
    }
    hide() {
      this.box.hidden = true;
    }
    get visible() {
      return !this.box.hidden;
    }
    destroy() {
      this.doc.removeEventListener("fullscreenchange", this._fs);
      this.doc.removeEventListener("webkitfullscreenchange", this._fs);
      this.host.remove();
    }
  };

  // ../extension/src/core/controller.js
  var TICK_MS = 150;
  var PREFETCH_MS = 1500;
  var Controller = class {
    /**
     * @param o.send       (req) => Promise<result>   翻译请求（发给 background，或在页面里用 Chrome 内置翻译）
     * @param o.saveSettings (patch) => void           悬浮层里的操作要写回设置
     * @param o.report     (status) => void            把状态报告给弹窗
     * @param o.rpc        (type, payload) => Promise  向后台读写转录（tx-get / tx-upsert）
     */
    constructor({ doc = globalThis.document, site, settings, send, saveSettings: saveSettings2, report = () => {
    }, rpc = async () => ({}), timers = void 0 }) {
      this.doc = doc;
      this.site = site;
      this.settings = settings;
      this.saveSettings = saveSettings2;
      this.report = report;
      this.rpc = rpc;
      this.tx = { state: "idle", info: null, error: "" };
      this.replaceNext = false;
      this.asr = null;
      this.asrBlocked = false;
      this.asrInflight = 0;
      this.asrRecent = null;
      this.noSourceMs = 0;
      this.asrState = { state: "idle", note: "", chunks: 0, lines: 0 };
      this.rec = new Recorder();
      this.vk = null;
      this.ready = false;
      this.curLineId = "";
      this.flushTimer = 0;
      this.loop = null;
      this.cachedHits = 0;
      this.on = false;
      this.cur = "";
      this.src = null;
      this.lastSeen = 0;
      this.error = "";
      this.note = "";
      this.recent = [];
      this.queue = new TranslateQueue({
        send,
        onError: (e) => {
          this.error = e.message || "\u7FFB\u8BD1\u5931\u8D25";
          this._render();
        },
        onOk: (r) => {
          this.error = "";
          this.note = r?.note || "";
          if (r?.provider && r.provider !== "cache") this.provider = r.provider;
          this.cachedHits += r?.cached || 0;
        },
        onResult: ({ text, tr }) => {
          this.rec.attach(text, tr);
          this._flushSoon();
        }
      });
      this.stab = new Stabilizer({ onSettle: (t) => this._translate(t), ...timers ? { timers } : {} });
      this.overlay = null;
      this.styleEl = null;
      this.sources = null;
      this.prefetched = /* @__PURE__ */ new Set();
      this.lastStatus = "";
    }
    start() {
      if (this.on) return;
      this.on = true;
      this.overlay = new Overlay({ doc: this.doc, onChange: (p) => this._onOverlay(p) });
      this._rebuild();
      this.timer = setInterval(() => this._tick(), TICK_MS);
      this.pf = setInterval(() => this._prefetch(), PREFETCH_MS);
      this._tick();
    }
    stop() {
      if (!this.on) return;
      this.on = false;
      clearInterval(this.timer);
      clearInterval(this.pf);
      this.clearLoop();
      this._stopAsr();
      this._flush();
      this.vk = null;
      this.ready = false;
      this.stab.clear();
      this.sources?.textTrack.restore();
      this.styleEl?.remove();
      this.styleEl = null;
      this.overlay?.destroy();
      this.overlay = null;
      this.cur = "";
      this.src = null;
      this._status();
    }
    setSettings(s) {
      const prev = this.settings;
      this.settings = s;
      if (!this.on) return;
      const srcChanged = prev.source !== s.source || prev.hideSite !== s.hideSite || JSON.stringify(prev.pickers) !== JSON.stringify(s.pickers) || prev.targets.join() !== s.targets.join();
      if (srcChanged) {
        this.sources?.textTrack.restore();
        this._rebuild();
        this.prefetched.clear();
      }
      this.overlay.setOptions(this._ov());
      if (prev.targets.join() !== s.targets.join() || prev.source !== s.source || prev.engine !== s.engine) {
        this.queue.clear();
        if (this.cur) this._translate(this.cur);
      }
      if (prev.asr !== s.asr) {
        if (s.asr === "off") this._stopAsr();
        else this.asrBlocked = false;
      }
      if (prev.ytTranscript !== s.ytTranscript || prev.source !== s.source) {
        this.tx = { state: "idle", info: null, error: "" };
        if (this._wantTranscript()) this._loadTranscript();
      }
      if (prev.targets.join() !== s.targets.join()) this._seedFromLines();
      this._render();
    }
    _ov() {
      const s = this.settings;
      return { fontScale: s.fontScale, bg: s.bg, showOrig: s.showOrig, hideSite: s.hideSite, pos: s.pos };
    }
    _rebuild() {
      this.sources = buildSources(this.doc, this.settings, this.site, () => this._tx());
      this.overlay.setOptions(this._ov());
      this.styleEl?.remove();
      this.styleEl = null;
      if (this.settings.hideSite && this.sources.hideSelectors.length) {
        this.styleEl = this.doc.createElement("style");
        this.styleEl.textContent = `${this.sources.hideSelectors.join(",")}{visibility:hidden!important}`;
        (this.doc.head || this.doc.documentElement).append(this.styleEl);
      }
    }
    _onOverlay(p) {
      if (p.off) {
        this.stop();
        this.report({ on: false, closedByUser: true });
        return;
      }
      this.saveSettings(p);
      this.settings = { ...this.settings, ...p };
      this.overlay.setOptions(this._ov());
    }
    /**
     * 这一句的翻译参数：{ source, targets }。
     *  · 用户指定了字幕语言 → 用它；
     *  · 自动：中文可以靠文字本身可靠判断；其它优先用来源给出的语言（字幕轨道的 srclang），没有再用逐句判断。
     *  · 明显已经是目标语言的句子（自动模式下的逐句判断）不再翻译成该语言。
     */
    _lineInfo(text) {
      const set = this.settings.source, det = detectLang(text);
      const hint = ["zh", "en", "fr"].includes(this.src?.lang) ? this.src.lang : null;
      const source = set !== "auto" ? set : det === "zh" ? "zh" : hint || det || "auto";
      let targets = this.settings.targets.filter((t) => t !== source);
      if (set === "auto" && det) targets = targets.filter((t) => t !== det);
      return { source, targets };
    }
    _tick() {
      if (!this.on || this.doc.hidden) return;
      this._checkVideo();
      const found = readFirst(this.sources);
      if (found) {
        this.src = found;
        this.lastSeen = Date.now();
        this.curVideo = found.video || this.curVideo;
      } else if (Date.now() - this.lastSeen > 8e3) this.src = null;
      this.overlay.setAnchor(found?.video || this.src?.video || null);
      this.overlay.layout();
      const vid = found?.video || pickVideo(this.doc);
      if (!found && vid && !vid.paused && !vid.ended) this.noSourceMs += TICK_MS;
      else if (found) this.noSourceMs = 0;
      this._maybeAsr(vid);
      const raw = found?.text || "";
      if (!raw && this.cur) {
        this.emptySince ||= Date.now();
        if (Date.now() - this.emptySince < 250) {
          this._status();
          return;
        }
      } else this.emptySince = 0;
      const text = this.stab.push(raw, found?.rolling);
      if (text !== this.cur) {
        this.cur = text;
        this.curLineId = "";
        this._render();
      }
      if (found?.lineId) this.curLineId = found.lineId;
      if (this.ready) {
        if (this.tx.state !== "ready") this._loadTrack();
        if (this.curLineId && found?.id !== "transcript") this.rec.touch(this.curLineId, this._now());
      }
      this._status();
    }
    _translate(text) {
      if (!text) return;
      this._record(text);
      const { source, targets } = this._lineInfo(text);
      if (!targets.length) return;
      this.queue.translate(text, { source, targets, context: this.recent.slice(-3), prio: "live" }).then(() => {
        if (this.cur === text) this._render();
      });
      if (this.recent.at(-1) !== text) {
        this.recent.push(text);
        if (this.recent.length > 6) this.recent.shift();
      }
    }
    _render() {
      if (!this.overlay) return;
      const text = this.cur;
      if (!text) {
        this.overlay.hide();
        return;
      }
      const { source, targets } = this._lineInfo(text);
      const tr = targets.length ? this.queue.peek(text, source, targets) || {} : {};
      const forceOrig = this.src?.id === "transcript" && !this.doc.querySelector(".ytp-caption-window-container .ytp-caption-segment, .player-timedtext-text-container");
      this.overlay.show({ orig: text, tr, targets: this.settings.targets, error: this.error, forceOrig });
    }
    /** 视频字幕轨道整条载入时，提前翻译接下来约 90 秒的字幕，播放到时译文已经在缓存里 */
    _prefetch() {
      if (!this.on || this.doc.hidden || this.src?.id !== "texttrack" && this.src?.id !== "transcript") return;
      const up = (this.src.id === "transcript" ? this.sources.transcript : this.sources.textTrack).upcoming(24, 90);
      for (const c of up) {
        const { source, targets } = this._lineInfo(c.text);
        if (!targets.length) continue;
        const k = this.queue.key(c.text, source, targets);
        if (this.prefetched.has(k) || this.queue.peek(c.text, source, targets)) continue;
        this.prefetched.add(k);
        this.queue.translate(c.text, { source, targets, context: c.prev ? [c.prev] : [], prio: "bg" });
      }
    }
    // ---------- 转录记录 ----------
    _now() {
      const v = this.curVideo?.isConnected ? this.curVideo : pickVideo(this.doc);
      return v ? v.currentTime : 0;
    }
    /** 视频换了（地址变化：YouTube 自动播放下一个、Netflix 换集）→ 换一份转录，并读出之前保存的 */
    _checkVideo() {
      const loc = this.doc.defaultView?.location;
      if (!loc) return;
      const k = videoKeyOf(loc);
      if (this.vk?.key === k.key) return;
      this._stopAsr();
      this.vk = { ...k, title: (this.doc.title || "").trim() };
      this.ready = false;
      this.curLineId = "";
      this.recent = [];
      this.rec.reset(this.vk);
      const key = k.key;
      this.rpc("tx-get", { key }).then((r) => {
        if (this.vk?.key !== key) return;
        const v = r?.video;
        if (v?.lines?.length) this.rec.load(v.lines);
        if (v?.src === "asr" && v.lines?.length) this.tx = { state: "ready", info: { ...v.srcInfo || {}, kind: "asr-audio", lang: v.srcInfo?.lang || v.lang }, error: "" };
        else if (v?.src === "yt-transcript" && v.lines?.length && this.settings.ytTranscript !== false) this.tx = { state: "ready", info: v.srcInfo || null, error: "" };
        else this.tx = { state: "idle", info: null, error: "" };
        this._seedFromLines();
        this.ready = true;
        if (this._wantTranscript() && this.tx.state !== "ready") this._loadTranscript();
      }).catch(() => {
        this.ready = true;
      });
    }
    /** 已保存的转录里有译文的句子，直接放进翻译缓存：同一个视频再看 / 循环播放时立即显示，不用请求 */
    _seedFromLines() {
      for (const l of this.rec.lines) {
        const { source, targets } = this._lineInfo(l.text);
        if (!targets.length || !targets.every((t) => l.tr?.[t])) continue;
        this.queue.seed(l.text, source, targets, Object.fromEntries(targets.map((t) => [t, l.tr[t]])));
      }
      this._render();
    }
    /** 字幕轨道整条载入：一次性把全部句子放进转录（侧边栏立刻能看到整部剧） */
    _loadTrack() {
      const all = this.sources?.textTrack.allCues?.();
      if (!all || all.sig === this.rec.loadedTrack) return;
      this.rec.loadedTrack = all.sig;
      this.rec.loadAll(all.cues, all.lang);
      this._seedFromLines();
      this._flushSoon();
    }
    /** 一句稳定下来：记进转录，并记下它的 id（侧边栏据此高亮当前句） */
    _record(text) {
      if (!this.vk || this.tx.state === "ready") return;
      const lang = this.src?.lang || this._lineInfo(text).source;
      this.curLineId = this.rec.observe(text, Math.max(0, this._now() - 0.15), lang);
      this._flushSoon();
    }
    _flushSoon() {
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flush(), 2e3);
    }
    _flush() {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
      if (!this.vk || !this.rec.hasDirty) return;
      const lines = this.rec.take();
      const meta = { key: this.vk.key, site: this.vk.site, url: this.vk.url, title: (this.doc.title || "").trim() || this.vk.title, lang: this.tx.info?.lang || this.src?.lang || lines[0]?.lang || null };
      if (this.tx.state === "ready") {
        meta.src = this.tx.info?.kind === "asr-audio" ? "asr" : "yt-transcript";
        meta.srcInfo = this.tx.info;
      }
      const replace = this.replaceNext;
      this.replaceNext = false;
      this.rpc("tx-upsert", { video: meta, lines, replace }).catch(() => {
      });
    }
    // ---------- YouTube 转写 ----------
    _wantTranscript() {
      return /^yt:/.test(this.vk?.key || "") && this.settings.ytTranscript !== false;
    }
    _tx() {
      const i = this.tx.info || {};
      const asr = i.kind === "asr-audio";
      if (this.tx.state !== "ready" || !asr && this.settings.ytTranscript === false || !this.rec.lines.length) return null;
      if (asr) return { lines: this.rec.lines, lang: i.lang, recent: this.asrRecent, label: `\u8BED\u97F3\u8BC6\u522B${i.lang ? "\uFF08" + (LANGS[i.lang] || i.lang) + "\uFF09" : ""}` };
      return { lines: this.rec.lines, lang: i.lang, label: `YouTube \u8F6C\u5199${i.lang ? "\uFF08" + (LANGS[i.lang] || i.lang) + (i.kind === "asr" ? " \xB7 \u81EA\u52A8\u751F\u6210" : i.kind === "manual" ? " \xB7 \u4EBA\u5DE5\u5B57\u5E55" : "") + "\uFF09" : ""}` };
    }
    /** 取视频自带的转写，整理成句子，替换掉之前记录的屏幕字幕。失败不影响使用：退回读取屏幕字幕 */
    _loadTranscript() {
      const key = this.vk.key;
      this.tx = { state: "loading", info: null, error: "" };
      loadYouTubeTranscript({ win: this.doc.defaultView, doc: this.doc, videoId: key.slice(3), settings: this.settings }).then((r) => {
        if (this.vk?.key !== key) return;
        this.rec.replaceAll(r.lines);
        this.replaceNext = true;
        this.tx = { state: "ready", info: { lang: r.lang, kind: r.kind, name: r.name, words: r.words }, error: "" };
        this._seedFromLines();
        this._flush();
      }).catch((e) => {
        if (this.vk?.key === key) this.tx = { state: "failed", info: null, error: e.message || "\u53D6\u4E0D\u5230\u8F6C\u5199" };
      });
    }
    /** 侧边栏的"重新整理"：忽略已保存的，重新取一遍 */
    reloadTranscript() {
      if (!this._wantTranscript()) return false;
      this._loadTranscript();
      return true;
    }
    // ---------- 语音识别（没有任何字幕时的兜底）----------
    /** 条件：设置没关；没有转写/字幕（YouTube 要先等转写失败）；视频连续播放了几秒什么字幕都没读到——或者这个视频以前识别过（继续识别没覆盖的部分） */
    _maybeAsr(vid) {
      if (this.asr || this.asrBlocked || this.settings.asr === "off" || !this.ready || !this.vk || !vid) return;
      if (this.tx.state === "loading" || this.tx.state === "ready" && this.tx.info?.kind !== "asr-audio") return;
      if (this._wantTranscript() && this.tx.state !== "failed") return;
      const before = this.tx.info?.kind === "asr-audio";
      if (before ? vid.paused : this.noSourceMs < 4e3) return;
      this._startAsr(vid);
    }
    _startAsr(vid) {
      this.asrState = { state: "starting", note: "", chunks: 0, lines: this.asrState.lines };
      this.rpc("asr-config", {}).then(async (cfg) => {
        if (!this.on || !this.vk) return;
        if (!cfg?.available) {
          this.asrBlocked = true;
          this.asrState = { state: "nokey", note: "", chunks: 0, lines: 0 };
          return;
        }
        const s = new AsrSession({ video: vid, win: this.doc.defaultView, onChunk: (c) => this._asrChunk(c), onProblem: (p) => {
          this.asrState = { ...this.asrState, state: "error", note: p === "drm" ? "\u62FF\u5230\u7684\u662F\u9759\u97F3\uFF1A\u8FD9\u4E2A\u89C6\u9891\u53EF\u80FD\u53D7\u7248\u6743\u4FDD\u62A4\uFF08DRM\uFF09\uFF0C\u7F51\u9875\u65E0\u6CD5\u83B7\u53D6\u5B83\u7684\u58F0\u97F3" : "\u6CA1\u6709\u58F0\u97F3" };
        } });
        try {
          await s.start();
          this.asr = s;
          this.asrState = { ...this.asrState, state: "running", note: `${cfg.provider} \xB7 ${cfg.model}` };
        } catch (e) {
          this.asrBlocked = true;
          this.asrState = { state: "error", note: e.message || "\u65E0\u6CD5\u83B7\u53D6\u89C6\u9891\u58F0\u97F3", chunks: 0, lines: 0 };
        }
      }).catch(() => {
        this.asrBlocked = true;
      });
    }
    _stopAsr() {
      this.asr?.stop();
      this.asr = null;
      this.asrBlocked = false;
      this.asrInflight = 0;
      this.noSourceMs = 0;
      this.asrRecent = null;
      this.asrState = { state: "idle", note: "", chunks: 0, lines: 0 };
    }
    /** 这一块说话的时间段，已经有识别结果覆盖了吗（重看、循环播放时不重复识别） */
    _covered(start, end) {
      let cov = 0;
      for (const l of this.rec.lines) if (l.id.startsWith("a")) cov += Math.max(0, Math.min(end, l.end + 0.3) - Math.max(start, l.start - 0.3));
      return cov / Math.max(0.1, end - start) >= 0.6;
    }
    _asrChunk(c) {
      if (this._covered(c.start, c.end)) return;
      if (this.asrInflight >= 2) return;
      this.asrInflight++;
      this.rpc("asr", { wav: toBase64(encodeWav(c.pcm)), durSec: c.pcm.length / 16e3, language: this.settings.source !== "auto" ? this.settings.source : void 0 }).then((r) => {
        if (!r?.ok) throw new Error(r?.error?.message || "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25");
        this.asrState = { ...this.asrState, chunks: this.asrState.chunks + 1, error: "" };
        const lines = r.segments.map((s) => ({ id: `a${Math.round((c.start + s.start * c.rate) * 1e3)}`, start: c.start + s.start * c.rate, end: Math.max(c.start + s.end * c.rate, c.start + s.start * c.rate + 0.6), text: s.text, lang: r.language || void 0 }));
        if (lines.length) this._addAsr(lines, r.language);
      }).catch((e) => {
        this.asrState = { ...this.asrState, error: e.message || "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25" };
        this.error = e.message;
        this._render();
      }).finally(() => {
        this.asrInflight--;
      });
    }
    _addAsr(lines, lang) {
      this.rec.addLines(lines);
      if (this.tx.state !== "ready") this.tx = { state: "ready", info: { kind: "asr-audio", lang }, error: "" };
      else if (lang && this.tx.info?.kind === "asr-audio") this.tx.info.lang = lang;
      this.asrRecent = { line: lines.at(-1), at: Date.now() };
      this.asrState = { ...this.asrState, lines: this.rec.lines.filter((l) => l.id.startsWith("a")).length };
      this._flushSoon();
    }
    // ---------- 侧边栏的指令 ----------
    seek(t, play) {
      return seekTo(this.doc, t, play);
    }
    /** 循环播放 [start,end]：用 requestAnimationFrame 盯着播放位置（timeupdate 一秒才 4 次，会冲过头） */
    setLoop(start, end) {
      this.clearLoop();
      const v = pickVideo(this.doc);
      if (!v) return false;
      const s = Math.max(0, start), e = Math.max(end, s + 1.5);
      this.loop = { s, e, raf: 0 };
      const win = this.doc.defaultView;
      const step = () => {
        if (!this.loop) return;
        if (v.currentTime >= e - 0.03 || v.currentTime < s - 0.6) {
          v.currentTime = s;
          if (v.paused) v.play?.().catch(() => {
          });
        }
        this.loop.raf = win.requestAnimationFrame(step);
      };
      v.currentTime = s;
      v.play?.().catch(() => {
      });
      step();
      return true;
    }
    clearLoop() {
      if (this.loop) {
        this.doc.defaultView?.cancelAnimationFrame(this.loop.raf);
        this.loop = null;
      }
    }
    /** 把转录里还没有译文的句子全部排进翻译队列（低优先级，不挡当前这句）。返回排了多少句 */
    translateAll() {
      let n = 0;
      const lines = this.rec.lines;
      lines.forEach((l, i) => {
        const { source, targets } = this._lineInfo(l.text);
        if (!targets.length || targets.every((t) => l.tr?.[t])) return;
        n++;
        this.queue.translate(l.text, { source, targets, context: lines[i - 1] ? [lines[i - 1].text] : [], prio: "bg" });
      });
      return n;
    }
    _status() {
      const s = {
        on: this.on,
        site: this.site,
        source: this.src ? { id: this.src.id, label: this.src.label, lang: this.src.lang } : null,
        translated: this.queue.stats.ok,
        failed: this.queue.stats.failed,
        cached: this.cachedHits,
        error: this.error,
        note: this.note,
        provider: this.provider || "",
        video: this.vk ? { key: this.vk.key, title: this.vk.title, lineId: this.curLineId, n: this.rec.lines.length } : null,
        tx: { state: this.tx.state, error: this.tx.error, info: this.tx.info },
        asr: this.asrState
      };
      const j = JSON.stringify(s);
      if (j !== this.lastStatus) {
        this.lastStatus = j;
        this.report(s);
      }
    }
  };

  // ../extension/src/core/picker.js
  var stableClass = (c) => /^[a-zA-Z][a-zA-Z-]{2,}$/.test(c) && !/^(css|jss|sc|styled|emotion)-/i.test(c);
  var stableId = (id) => /^[a-zA-Z][a-zA-Z-]{2,}$/.test(id);
  function selectorFor(el, doc = el.ownerDocument) {
    let n = el, depth = 0;
    while (n && n !== doc.body && n.nodeType === 1 && depth < 4) {
      const tag = n.tagName.toLowerCase();
      const cands = [];
      if (n.id && stableId(n.id)) cands.push("#" + CSS.escape(n.id));
      const cls = [...n.classList].filter(stableClass);
      for (let k = 1; k <= Math.min(cls.length, 2); k++) cands.push("." + cls.slice(0, k).map((c) => CSS.escape(c)).join("."));
      for (let k = 1; k <= Math.min(cls.length, 2); k++) cands.push(tag + "." + cls.slice(0, k).map((c) => CSS.escape(c)).join("."));
      for (const sel of cands) {
        let hits;
        try {
          hits = doc.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (hits.length >= 1 && hits.length <= 4 && [...hits].includes(n)) return sel;
      }
      n = n.parentElement;
      depth++;
    }
    return null;
  }
  function startPicker({ doc = document, onPick, onCancel = () => {
  } }) {
    const host = doc.createElement("lectureloop-picker");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>.hl{position:fixed;border:2px solid #3b5bdb;background:rgba(59,91,219,.18);pointer-events:none;border-radius:4px}
  .tip{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#1c1f26;color:#fff;font:600 14px/1.5 system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none;max-width:80vw;text-align:center}</style>
  <div class="hl" hidden></div><div class="tip"></div>`;
    const hl = root.querySelector(".hl"), tip = root.querySelector(".tip");
    tip.textContent = "\u5148\u6682\u505C\u89C6\u9891\uFF0C\u8BA9\u5B57\u5E55\u505C\u5728\u5C4F\u5E55\u4E0A\uFF0C\u7136\u540E\u70B9\u51FB\u5B57\u5E55\u6587\u5B57\uFF08Esc \u53D6\u6D88\uFF09";
    doc.documentElement.append(host);
    const under = (x, y) => {
      host.style.pointerEvents = "none";
      const el = doc.elementFromPoint(x, y);
      host.style.pointerEvents = "";
      return el && el !== host ? el : null;
    };
    const move = (e) => {
      const el = under(e.clientX, e.clientY);
      if (!el) {
        hl.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      hl.hidden = false;
    };
    const cleanup = () => {
      host.remove();
      doc.removeEventListener("keydown", key, true);
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        onCancel();
      }
    };
    host.addEventListener("mousemove", move);
    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = under(e.clientX, e.clientY);
      const text = (el?.textContent || "").trim();
      if (!el || !text) {
        tip.textContent = "\u8FD9\u91CC\u6CA1\u6709\u6587\u5B57\uFF0C\u8BF7\u70B9\u51FB\u6B63\u5728\u663E\u793A\u7684\u5B57\u5E55\u6587\u5B57";
        return;
      }
      const sel = selectorFor(el, doc);
      if (!sel) {
        tip.textContent = "\u8FD9\u4E2A\u4F4D\u7F6E\u6CA1\u6CD5\u751F\u6210\u7A33\u5B9A\u7684\u9009\u62E9\u5668\uFF0C\u8BF7\u6362\u70B9\u5B57\u5E55\u91CC\u66F4\u9760\u5916\u7684\u4F4D\u7F6E\u518D\u8BD5";
        return;
      }
      cleanup();
      onPick(sel, text.slice(0, 80));
    });
    doc.addEventListener("keydown", key, true);
    return { cancel: () => {
      cleanup();
    } };
  }

  // ../extension/src/content.js
  if (!window.__lectureloopSubs) {
    window.__lectureloopSubs = true;
    main();
  }
  async function main() {
    const isTop = window === window.top;
    if (!isTop && (innerWidth < 200 || innerHeight < 120)) return;
    const site = siteOf();
    let settings = await loadSettings();
    let picker = null;
    const rt = chrome.runtime;
    const report = (status) => {
      try {
        rt.sendMessage({ type: "status", status }).catch(() => {
        });
      } catch {
      }
    };
    const hasLocal = () => "Translator" in self;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Chrome \u5185\u7F6E\u7FFB\u8BD1\u8D85\u65F6\uFF08\u8BED\u8A00\u5305\u53EF\u80FD\u8FD8\u6CA1\u4E0B\u8F7D\uFF09")), ms))]);
    const pairs = ({ source, targets, items }) => {
      const out = /* @__PURE__ */ new Set();
      for (const it of items) for (const target of targets) {
        const from = source !== "auto" ? source : detectLang(it.t);
        if (from && from !== target) out.add(`${from}>${target}`);
      }
      return [...out];
    };
    async function localReady(req) {
      if (!hasLocal()) return false;
      try {
        const ps = pairs(req);
        if (!ps.length) return false;
        for (const k of ps) {
          const [from, to] = k.split(">");
          if (await self.Translator.availability({ sourceLanguage: from, targetLanguage: to }) !== "available") return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    async function localTranslate({ source, targets, items }) {
      const results = {};
      localTranslate.cache ||= /* @__PURE__ */ new Map();
      for (const target of targets) {
        const out = [];
        for (const it of items) {
          const from = source !== "auto" ? source : detectLang(it.t);
          if (!from || from === target) {
            out.push({ i: it.i, t: "" });
            continue;
          }
          const key = `${from}>${target}`;
          let tr = localTranslate.cache.get(key);
          if (!tr) {
            tr = await withTimeout(self.Translator.create({ sourceLanguage: from, targetLanguage: target }), 15e3);
            localTranslate.cache.set(key, tr);
          }
          out.push({ i: it.i, t: await withTimeout(tr.translate(it.t), 15e3) });
        }
        results[target] = out;
      }
      return { provider: "chrome", results };
    }
    async function send(req) {
      if (settings.engine === "chrome") {
        if (!hasLocal()) throw new Error("\u8FD9\u4E2A Chrome \u7248\u672C\u6CA1\u6709\u5185\u7F6E\u7FFB\u8BD1\uFF08\u9700\u8981 Chrome 138 \u6216\u66F4\u65B0\uFF09");
        return localTranslate(req);
      }
      let r;
      try {
        r = await rt.sendMessage({ type: "translate", ...req, engine: settings.engine });
      } catch {
        throw new Error("\u63D2\u4EF6\u521A\u521A\u66F4\u65B0\u8FC7\uFF0C\u8BF7\u5237\u65B0\u8FD9\u4E2A\u9875\u9762");
      }
      if (r?.ok) return r.result;
      if (settings.engine === "auto" && await localReady(req)) {
        try {
          return await localTranslate(req);
        } catch {
        }
      }
      throw new Error(r?.error?.message || "\u7FFB\u8BD1\u5931\u8D25");
    }
    const rpc = (type, payload) => rt.sendMessage({ type, ...payload });
    const ctl = new Controller({
      site,
      settings,
      send,
      report,
      rpc,
      saveSettings: (p) => saveSettings(p)
    });
    const setOn = (on) => {
      on ? ctl.start() : ctl.stop();
      if (!on) report({ on: false });
    };
    watchSettings((s) => {
      const was = !!settings.sites[site];
      settings = s;
      ctl.setSettings(s);
      if (!was && s.sites[site] && !ctl.on) ctl.start();
    });
    if (settings.sites[site]) ctl.start();
    const shouldPick = () => !!pickVideo(document) || isTop && !document.querySelector("iframe");
    rt.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type === "setEnabled") setOn(!!msg.on);
      else if (msg?.type === "ping") reply({ on: ctl.on, site, top: isTop });
      else if (msg?.type === "seek") {
        if (ctl.seek(msg.t, msg.play)) reply({ ok: true });
      } else if (msg?.type === "loop") {
        if (ctl.setLoop(msg.start, msg.end)) reply({ ok: true });
      } else if (msg?.type === "loopClear") {
        ctl.clearLoop();
      } else if (msg?.type === "reloadTranscript") {
        if (ctl.on && ctl.reloadTranscript()) reply({ ok: true });
      } else if (msg?.type === "translateAll") {
        if (ctl.on && ctl.rec.lines.length) reply({ n: ctl.translateAll() });
      } else if (msg?.type === "pick") {
        if (!shouldPick()) return;
        if (!ctl.on) ctl.start();
        picker?.cancel();
        picker = startPicker({
          onPick: async (sel) => {
            picker = null;
            const s = await loadSettings();
            await saveSettings({ pickers: { ...s.pickers, [site]: [sel] } });
            rt.sendMessage({ type: "pickDone" }).catch(() => {
            });
          },
          onCancel: () => {
            picker = null;
            rt.sendMessage({ type: "pickDone" }).catch(() => {
            });
          }
        });
      } else if (msg?.type === "pickCancel") {
        picker?.cancel();
        picker = null;
      }
    });
  }
})();
