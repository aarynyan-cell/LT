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
  function buildSources(doc, settings, site) {
    const saved = /* @__PURE__ */ new Map();
    const list = [];
    const picked = (settings.pickers?.[site] || []).filter(Boolean);
    if (picked.length) list.push(domCandidate({ id: "picker", label: "\u624B\u52A8\u9009\u53D6\u7684\u5B57\u5E55\u4F4D\u7F6E", sel: picked.join(", ") }, doc));
    for (const a of ADAPTERS) if (a.host.test(site)) list.push(domCandidate(a, doc));
    const tt = textTrackCandidate(doc, settings, saved);
    list.push(tt);
    return { list, textTrack: tt, hideSelectors: list.filter((c) => c.hide).map((c) => c.hide) };
  }
  function readFirst(sources) {
    for (const c of sources.list) {
      const r = c.read();
      if (r?.text) return { id: c.id, label: c.label, ...r };
    }
    return null;
  }

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
    constructor({ send, maxBatch = 8, bgBatch = 12, cap = 3e3, onError, onOk, now = () => Date.now() }) {
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
    show({ orig = "", tr = {}, targets = [], error = "" }) {
      const texts = targets.map((t) => tr[t]).filter(Boolean);
      const showO = (this.opts.showOrig || this.opts.hideSite || !!error && !texts.length) && !!orig;
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

  // ../extension/src/core/controller.js
  var TICK_MS = 150;
  var PREFETCH_MS = 1500;
  var Controller = class {
    /**
     * @param o.send       (req) => Promise<result>   翻译请求（发给 background，或在页面里用 Chrome 内置翻译）
     * @param o.saveSettings (patch) => void           悬浮层里的操作要写回设置
     * @param o.report     (status) => void            把状态报告给弹窗
     */
    constructor({ doc = globalThis.document, site, settings, send, saveSettings: saveSettings2, report = () => {
    }, timers = void 0 }) {
      this.doc = doc;
      this.site = site;
      this.settings = settings;
      this.saveSettings = saveSettings2;
      this.report = report;
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
          this.provider = r?.provider || this.provider;
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
      this._render();
    }
    _ov() {
      const s = this.settings;
      return { fontScale: s.fontScale, bg: s.bg, showOrig: s.showOrig, hideSite: s.hideSite, pos: s.pos };
    }
    _rebuild() {
      this.sources = buildSources(this.doc, this.settings, this.site);
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
      const found = readFirst(this.sources);
      if (found) {
        this.src = found;
        this.lastSeen = Date.now();
      } else if (Date.now() - this.lastSeen > 8e3) this.src = null;
      this.overlay.setAnchor(found?.video || this.src?.video || null);
      this.overlay.layout();
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
        this._render();
      }
      this._status();
    }
    _translate(text) {
      if (!text) return;
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
      this.overlay.show({ orig: text, tr, targets: this.settings.targets, error: this.error });
    }
    /** 视频字幕轨道整条载入时，提前翻译接下来约 90 秒的字幕，播放到时译文已经在缓存里 */
    _prefetch() {
      if (!this.on || this.doc.hidden || this.src?.id !== "texttrack") return;
      const up = this.sources.textTrack.upcoming(24, 90);
      for (const c of up) {
        const { source, targets } = this._lineInfo(c.text);
        if (!targets.length) continue;
        const k = this.queue.key(c.text, source, targets);
        if (this.prefetched.has(k) || this.queue.peek(c.text, source, targets)) continue;
        this.prefetched.add(k);
        this.queue.translate(c.text, { source, targets, context: c.prev ? [c.prev] : [], prio: "bg" });
      }
    }
    _status() {
      const s = {
        on: this.on,
        site: this.site,
        source: this.src ? { id: this.src.id, label: this.src.label, lang: this.src.lang } : null,
        translated: this.queue.stats.ok,
        failed: this.queue.stats.failed,
        error: this.error,
        note: this.note,
        provider: this.provider || ""
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
    const ctl = new Controller({
      site,
      settings,
      send,
      report,
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
      else if (msg?.type === "pick") {
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
