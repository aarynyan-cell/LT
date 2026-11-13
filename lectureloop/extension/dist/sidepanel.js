(() => {
  // ../extension/src/dom.js
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "class") el.className = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  var clear = (el) => {
    while (el.firstChild) el.firstChild.remove();
    return el;
  };

  // ../extension/src/core/store.js
  var NAME = "lectureloop-subs";
  var dbp;
  var db = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("videos", { keyPath: "key" });
      d.createObjectStore("tm", { keyPath: "k" }).createIndex("ts", "ts");
      d.createObjectStore("saved", { keyPath: "id" }).createIndex("ts", "ts");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function run(stores, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      const out = fn(...[].concat(stores).map((s) => t.objectStore(s)), t);
      t.oncomplete = () => res(out && "result" in out ? out.result : out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  var getVideo = (key) => run("videos", "readonly", (s) => s.get(key));
  var savedAll = () => run("saved", "readonly", (s) => s.getAll());
  var savedPut = (item) => run("saved", "readwrite", (s) => s.put({ ...item, ts: item.ts || Date.now() }));
  var savedDelete = (id) => run("saved", "readwrite", (s) => s.delete(id));

  // ../extension/src/core/langs.js
  var LANGS = { zh: "\u4E2D\u6587", en: "\u82F1\u8BED", fr: "\u6CD5\u8BED" };
  var SOURCE_OPTIONS = { auto: "\u81EA\u52A8\u5224\u65AD", ...LANGS };
  var FR = new Set(`le la les un une des du de au aux et est sont pas ne que qui quoi dans pour avec sur mais ou o\xF9 donc car ce cet cette ces je tu il elle nous vous ils elles on mon ma mes ton ta tes son sa ses notre votre leur leurs oui non tr\xE8s bien \xEAtre avoir fait faire suis es \xEAtes sommes ai as avons avez ont merci bonjour bonsoir salut monsieur madame mademoiselle alors comme aussi encore toujours jamais rien tout tous toute plus moins peu beaucoup d\xE9j\xE0 jusqu aujourd hui chez sans sous entre vers depuis pendant \xE7a ici l\xE0 voil\xE0 allez viens vas veux peux dois faut puis parce quand comment pourquoi quel quelle quels`.split(/\s+/));
  var EN = new Set(`the a an and is are was were not no that this these those with for you i he she we they it my your his her our their yes very be been being have has had do does did of to in on at but or so if what who how why when where can could will would just there here from by as about up out get got go going know think want like see say okay hello thanks thank please sorry don't doesn't didn't can't won't isn't aren't it's i'm you're we're they're that's what's let's gonna wanna gotta yeah nope`.split(/\s+/));
  var STOPWORDS = { fr: FR, en: EN };
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

  // ../extension/src/core/words.js
  var COLORS = {
    red: { label: "\u4E0D\u4F1A", hex: "#ff6b6b" },
    yellow: { label: "\u6A21\u7CCA", hex: "#ffd43b" },
    green: { label: "\u4F1A\u4E86", hex: "#69db7c" },
    blue: { label: "\u597D\u53E5", hex: "#74c0fc" }
  };
  var WORD_COLORS = ["red", "yellow", "green"];
  function tokenize(text, lang = "en") {
    const out = [];
    try {
      const seg = new Intl.Segmenter(lang === "zh" ? "zh" : lang, { granularity: "word" });
      for (const s of seg.segment(text)) out.push({ t: s.segment, word: !!s.isWordLike });
      if (out.length) return mergeApostrophes(out);
    } catch {
    }
    for (const m of text.matchAll(new RegExp("(\\p{L}[\\p{L}\\p{M}'\u2019-]*)|([^\\p{L}]+)", "gu"))) out.push({ t: m[0], word: !!m[1] });
    return out;
  }
  function mergeApostrophes(tokens) {
    const out = [];
    for (const k of tokens) {
      const prev = out.at(-1);
      if (prev && !prev.word && /^['’]$/.test(prev.t) && k.word && out.length >= 2 && out.at(-2).word) {
        const a = out.pop();
        const b = out.pop();
        out.push({ t: b.t + a.t + k.t, word: true });
      } else out.push({ ...k });
    }
    return out;
  }
  var wordKey = (w) => String(w).trim().toLowerCase().normalize("NFC").replace(/^['’-]+|['’-]+$/g, "");
  var isStop = (w, lang) => {
    const k = wordKey(w);
    const set = STOPWORDS[lang];
    return k.length < 2 || /^\d+$/.test(k) || !!set?.has(k) || /^[ldjnmtsc]['’]/.test(k) && k.length <= 3;
  };
  function wordStats(lines, lang, { hideStop = true } = {}) {
    const map = /* @__PURE__ */ new Map();
    lines.forEach((l, idx) => {
      for (const k of tokenize(l.text, lang)) {
        if (!k.word) continue;
        const w = wordKey(k.t);
        if (!w || hideStop && isStop(w, lang)) continue;
        const e = map.get(w) || { word: w, count: 0, firstLine: idx };
        e.count++;
        map.set(w, e);
      }
    });
    return [...map.values()].sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));
  }

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
  function watchSettings(cb, c = globalThis.chrome) {
    const f = (changes, name) => {
      if (name === "sync" || name === "local") loadSettings(c).then(cb);
    };
    c.storage.onChanged.addListener(f);
    return () => c.storage.onChanged.removeListener(f);
  }

  // ../extension/src/sidepanel.js
  var q = new URLSearchParams(location.search);
  var app = document.getElementById("app");
  var tab = null;
  var video = null;
  var nowId = "";
  var settings = null;
  var saved = /* @__PURE__ */ new Map();
  var loopId = "";
  var card = null;
  var palFor = "";
  var toastTimer = 0;
  var prefs = (() => {
    try {
      return { tab: "lines", follow: true, showOrig: true, showTr: true, hideStop: true, wordFilter: "all", colorFilter: "all", kindFilter: "all", ...JSON.parse(localStorage.getItem("lsp") || "{}") };
    } catch {
      return { tab: "lines", follow: true, showOrig: true, showTr: true, hideStop: true, wordFilter: "all", colorFilter: "all", kindFilter: "all" };
    }
  })();
  var savePrefs = () => {
    try {
      localStorage.setItem("lsp", JSON.stringify(prefs));
    } catch {
    }
  };
  var setPref = (p) => {
    Object.assign(prefs, p);
    savePrefs();
    render();
  };
  var fmt = (t) => {
    t = Math.max(0, Math.floor(t));
    const h2 = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h2 ? h2 + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  var lineLang = (l) => {
    const d = detectLang(l.text);
    return d === "zh" ? "zh" : l.lang || video?.lang || d || "en";
  };
  var targets = () => settings?.targets || ["zh"];
  async function activeTab() {
    if (q.get("tabId")) return { id: +q.get("tabId") };
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  }
  async function statusOf() {
    const all = await chrome.storage.session.get(null);
    const list = Object.entries(all).filter(([k, v]) => k.startsWith(`st:${tab?.id}:`) && v.on).map(([, v]) => v);
    return list.find((s) => s.video?.key) || list[0] || null;
  }
  async function reload({ keepNow = false } = {}) {
    const st = tab ? await statusOf() : null;
    const key = st?.video?.key;
    if (!keepNow) nowId = st?.video?.lineId || nowId;
    if (!key) {
      video = null;
      render();
      return;
    }
    video = await getVideo(key) || { key, title: st.video.title, url: "", lang: st.source?.lang || null, lines: [] };
    if (st.video.title) video.title = st.video.title;
    render();
  }
  async function loadSaved() {
    saved = new Map((await savedAll()).map((s) => [s.id, s]));
  }
  var savedWords = () => {
    const m = /* @__PURE__ */ new Map();
    for (const s of saved.values()) if (s.kind === "word") m.set(wordKey(s.text), s);
    return m;
  };
  var sendToTab = (msg) => tab ? chrome.tabs.sendMessage(tab.id, msg).catch(() => null) : Promise.resolve(null);
  function toast(text) {
    document.querySelector(".toast")?.remove();
    const t = h("div", { class: "toast" }, text);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2200);
  }
  var seek = (t, play = true) => sendToTab({ type: "seek", t, play });
  async function toggleLoop(l) {
    if (loopId === l.id) {
      loopId = "";
      sendToTab({ type: "loopClear" });
    } else {
      loopId = l.id;
      await sendToTab({ type: "loop", start: l.start, end: l.end });
    }
    render();
  }
  async function saveSentence(l, color) {
    const id = `s:${video.key}:${l.id}`;
    if (!color) {
      await savedDelete(id);
      saved.delete(id);
    } else {
      const item = { id, kind: "sentence", text: l.text, tr: l.tr?.[targets()[0]] || Object.values(l.tr || {})[0] || "", color, videoKey: video.key, url: video.url, title: video.title, start: l.start, lang: lineLang(l), ts: Date.now() };
      await savedPut(item);
      saved.set(id, item);
    }
    palFor = "";
    render();
  }
  async function saveWord(color) {
    if (!card) return;
    const id = `w:${wordKey(card.word)}`;
    if (!color) {
      await savedDelete(id);
      saved.delete(id);
    } else {
      const item = { id, kind: "word", text: card.word, tr: card.tr || "", ctx: card.ctx, color, videoKey: video?.key || "", url: video?.url || "", title: video?.title || "", start: card.start || 0, lang: card.lang, ts: Date.now() };
      await savedPut(item);
      saved.set(id, item);
    }
    paintWord(wordKey(card.word));
    render();
  }
  async function openCard(word, line) {
    const lang = lineLang(line);
    const to = targets().find((t) => t !== lang) || "zh";
    const old = saved.get(`w:${wordKey(word)}`);
    card = { word, ctx: line.text, lineId: line.id, start: line.start, lang, tr: old?.tr || "", loading: !old?.tr };
    render();
    if (card.tr) return;
    const myWord = word;
    try {
      const r = await chrome.runtime.sendMessage({ type: "translate", source: lang, targets: [to], items: [{ i: 0, t: word }], context: [line.text], engine: settings.engine === "chrome" ? "auto" : settings.engine });
      const t = r?.ok ? r.result.results?.[to]?.[0]?.t : "";
      if (card?.word === myWord) {
        card.tr = t || "";
        card.loading = false;
        if (!t) card.err = r?.error?.message || "\u6CA1\u6709\u67E5\u5230\u8BD1\u6587";
        render();
      }
    } catch (e) {
      if (card?.word === myWord) {
        card.loading = false;
        card.err = e.message;
        render();
      }
    }
  }
  function paintWord(key) {
    const s = savedWords().get(key);
    for (const el of document.querySelectorAll(`.w[data-w="${CSS.escape(key)}"]`)) {
      el.classList.remove("c-red", "c-yellow", "c-green", "c-blue");
      if (s) el.classList.add("c-" + s.color);
    }
  }
  var dots = (cur, colors, onPick) => colors.map((c) => h("button", { class: `dot ${c}` + (cur === c ? " on" : ""), title: COLORS[c].label, "aria-label": COLORS[c].label, onClick: () => onPick(c) }));
  function lineRow(l, sw) {
    const sid = `s:${video.key}:${l.id}`;
    const sent = saved.get(sid);
    const lang = lineLang(l);
    const words = tokenize(l.text, lang).map((k) => {
      if (!k.word) return k.t;
      const key = wordKey(k.t);
      const s = sw.get(key);
      return h("span", { class: "w" + (s ? " c-" + s.color : ""), "data-w": key, onClick: (e) => {
        e.stopPropagation();
        openCard(k.t, l);
      } }, k.t);
    });
    const trs = prefs.showTr ? targets().filter((t) => t !== lang).map((t, n) => l.tr?.[t] ? h("div", { class: "tr" + (n ? " t2" : "") }, l.tr[t]) : n === 0 ? h("div", { class: "tr pending" }, "\u2026") : null) : [];
    return h(
      "div",
      { class: "ln" + (l.id === nowId ? " cur" : "") + (sent ? " sc-" + sent.color : "") + (l.id === loopId ? " looping" : ""), "data-id": l.id },
      h(
        "div",
        { class: "acts" },
        h("button", { title: "\u4ECE\u8FD9\u91CC\u64AD\u653E", "aria-label": "\u4ECE\u8FD9\u91CC\u64AD\u653E", onClick: () => seek(l.start) }, "\u25B6"),
        h("button", { class: l.id === loopId ? "on" : "", title: "\u5FAA\u73AF\u8FD9\u4E00\u53E5", "aria-label": "\u5FAA\u73AF\u8FD9\u4E00\u53E5", onClick: () => toggleLoop(l) }, "\u{1F501}"),
        h("button", { class: sent ? "on" : "", title: sent ? "\u6539\u989C\u8272 / \u53D6\u6D88\u6536\u85CF" : "\u6536\u85CF\u8FD9\u53E5", "aria-label": "\u6536\u85CF\u8FD9\u53E5", onClick: () => {
          palFor = palFor === l.id ? "" : l.id;
          render();
        } }, sent ? "\u2605" : "\u2606")
      ),
      h(
        "div",
        { class: "body", title: "\u70B9\u8FD9\u4E00\u53E5\u8DF3\u5230\u8FD9\u91CC\u64AD\u653E", onClick: () => seek(l.start) },
        h("span", { class: "t" }, fmt(l.start)),
        prefs.showOrig ? h("div", { class: "orig" }, words) : null,
        trs,
        palFor === l.id ? h("div", { class: "pal" }, "\u6536\u85CF\u4E3A\uFF1A", dots(sent?.color, Object.keys(COLORS), (c) => saveSentence(l, c)), sent ? h("button", { class: "btn", onClick: () => saveSentence(l, null) }, "\u53D6\u6D88\u6536\u85CF") : null) : null
      )
    );
  }
  function linesTab() {
    const lines = video?.lines || [];
    const to = targets();
    const missing = lines.filter((l) => to.filter((t) => t !== lineLang(l)).some((t) => !l.tr?.[t])).length;
    const sw = savedWords();
    const list = h("div", { class: "list", id: "list" }, lines.length ? lines.map((l) => lineRow(l, sw)) : h("div", { class: "empty" }, video ? "\u8FD8\u6CA1\u6709\u8BB0\u5F55\u5230\u5B57\u5E55\u3002\u5F00\u59CB\u64AD\u653E\uFF0C\u5B57\u5E55\u4F1A\u4E00\u53E5\u4E00\u53E5\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" : ""));
    return [
      h(
        "div",
        { class: "bar" },
        h("label", {}, h("input", { type: "checkbox", id: "f-orig", checked: prefs.showOrig, onChange: (e) => setPref({ showOrig: e.target.checked }) }), "\u539F\u6587"),
        h("label", {}, h("input", { type: "checkbox", id: "f-tr", checked: prefs.showTr, onChange: (e) => setPref({ showTr: e.target.checked }) }), "\u8BD1\u6587"),
        h("label", {}, h("input", { type: "checkbox", id: "f-follow", checked: prefs.follow, onChange: (e) => setPref({ follow: e.target.checked }) }), "\u8DDF\u968F\u64AD\u653E"),
        missing ? h("button", { class: "btn", id: "translate-all", title: "\u628A\u8FD8\u6CA1\u6709\u8BD1\u6587\u7684\u53E5\u5B50\u5168\u90E8\u7FFB\u8BD1\uFF08\u7528\u4F60\u9009\u7684\u7FFB\u8BD1\u5F15\u64CE\uFF09", onClick: async () => {
          const r = await sendToTab({ type: "translateAll" });
          toast(r ? `\u5DF2\u5F00\u59CB\u7FFB\u8BD1 ${r.n} \u53E5` : "\u8BF7\u5148\u5728\u89C6\u9891\u9875\u9762\u5F00\u542F\u5B57\u5E55\u7FFB\u8BD1");
        } }, `\u7FFB\u8BD1\u5168\u90E8\uFF08${missing}\uFF09`) : null,
        h("span", {}, `${lines.length} \u53E5`)
      ),
      list
    ];
  }
  function wordsTab() {
    const sw = savedWords();
    const lang = video?.lang || "en";
    let stats = video ? wordStats(video.lines, lang, { hideStop: prefs.hideStop }) : [];
    if (prefs.wordFilter === "saved") stats = stats.filter((s) => sw.has(s.word));
    else if (prefs.wordFilter === "new") stats = stats.filter((s) => !sw.has(s.word));
    return [
      h(
        "div",
        { class: "bar" },
        ...[["all", "\u5168\u90E8"], ["new", "\u672A\u6536\u85CF"], ["saved", "\u5DF2\u6536\u85CF"]].map(([k, t]) => h("button", { class: "chip" + (prefs.wordFilter === k ? " on" : ""), onClick: () => setPref({ wordFilter: k }) }, t)),
        h("label", {}, h("input", { type: "checkbox", id: "f-stop", checked: prefs.hideStop, onChange: (e) => setPref({ hideStop: e.target.checked }) }), "\u9690\u85CF\u5E38\u89C1\u8BCD"),
        h("span", {}, `${stats.length} \u4E2A`)
      ),
      h("div", { class: "list" }, stats.length ? stats.slice(0, 600).map((s) => {
        const it = sw.get(s.word);
        return h(
          "div",
          { class: "row clickable", "data-w": s.word, onClick: () => {
            const line = video.lines[s.firstLine];
            if (line) openCard(s.word, line);
          } },
          h("span", { class: "dotm" + (it ? " " + it.color : "") }),
          h("div", { class: "main" }, h("div", { class: "k" }, s.word), it?.tr ? h("div", { class: "m" }, it.tr) : null),
          h("span", { class: "cnt" }, "\xD7" + s.count)
        );
      }) : h("div", { class: "empty" }, video ? "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u5355\u8BCD\u3002" : ""))
    ];
  }
  function savedTab() {
    let items = [...saved.values()].sort((a, b) => b.ts - a.ts);
    if (prefs.kindFilter !== "all") items = items.filter((s) => s.kind === prefs.kindFilter);
    if (prefs.colorFilter !== "all") items = items.filter((s) => s.color === prefs.colorFilter);
    return [
      h(
        "div",
        { class: "bar" },
        ...[["all", "\u5168\u90E8"], ["word", "\u5355\u8BCD"], ["sentence", "\u53E5\u5B50"]].map(([k, t]) => h("button", { class: "chip" + (prefs.kindFilter === k ? " on" : ""), onClick: () => setPref({ kindFilter: k }) }, t)),
        h("span", {}, "\uFF5C"),
        h("button", { class: "chip" + (prefs.colorFilter === "all" ? " on" : ""), onClick: () => setPref({ colorFilter: "all" }) }, "\u5168\u90E8\u989C\u8272"),
        ...Object.entries(COLORS).map(([c, v]) => h("button", { class: "chip" + (prefs.colorFilter === c ? " on" : ""), style: `border-color:${v.hex}`, onClick: () => setPref({ colorFilter: c }) }, v.label)),
        h("button", { class: "btn", id: "export", title: "\u5BFC\u51FA\u4E3A TSV\uFF0C\u53EF\u5BFC\u5165 Anki", disabled: !saved.size, onClick: exportTsv }, "\u5BFC\u51FA TSV")
      ),
      h("div", { class: "list" }, items.length ? items.map((s) => h(
        "div",
        { class: "row", "data-id": s.id },
        h("span", { class: "dotm " + s.color, title: COLORS[s.color]?.label }),
        h("div", { class: "main" }, h("div", { class: "k" }, s.kind === "sentence" ? "\u201C" + s.text + "\u201D" : s.text), s.tr ? h("div", { class: "m" }, s.tr) : null, h("div", { class: "m" }, `${s.kind === "word" ? "\u5355\u8BCD" : "\u53E5\u5B50"} \xB7 ${s.title || s.videoKey || ""} \xB7 ${fmt(s.start || 0)}`)),
        h("button", { class: "x", title: "\u8DF3\u5230\u8FD9\u91CC", "aria-label": "\u8DF3\u5230\u8FD9\u91CC", onClick: () => jump(s) }, "\u25B6"),
        h("button", { class: "x", title: "\u5220\u9664", "aria-label": "\u5220\u9664", onClick: async () => {
          await savedDelete(s.id);
          saved.delete(s.id);
          paintWord(wordKey(s.text));
          render();
        } }, "\u{1F5D1}")
      )) : h("div", { class: "empty" }, "\u8FD8\u6CA1\u6709\u6536\u85CF\u3002\u5728\u201C\u5B57\u5E55\u201D\u91CC\u70B9 \u2606 \u6536\u85CF\u53E5\u5B50\uFF0C\u70B9\u5355\u8BCD\u6536\u85CF\u5355\u8BCD\u3002"))
    ];
  }
  function jump(s) {
    if (video && s.videoKey === video.key) {
      seek(s.start);
      return;
    }
    if (!s.url) return;
    const t = Math.floor(s.start || 0);
    const url = /^yt:/.test(s.videoKey) ? `${s.url}&t=${t}s` : s.url;
    chrome.tabs.create({ url });
  }
  function exportTsv() {
    const esc = (x) => String(x ?? "").replace(/[\t\r\n]+/g, " ");
    const rows = [...saved.values()].sort((a2, b) => a2.ts - b.ts).map((s) => [s.kind === "word" ? "\u5355\u8BCD" : "\u53E5\u5B50", s.text, s.tr, s.kind === "word" ? s.ctx : "", COLORS[s.color]?.label || s.color, s.title, s.url, fmt(s.start || 0)].map(esc).join("	"));
    const blob = new Blob(["\u7C7B\u578B	\u539F\u6587	\u8BD1\u6587	\u4F8B\u53E5	\u989C\u8272	\u89C6\u9891	\u94FE\u63A5	\u65F6\u95F4\n" + rows.join("\n")], { type: "text/tab-separated-values;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "lectureloop-saved.tsv" });
    document.body.append(a);
    a.click();
    a.remove();
  }
  function cardView() {
    if (!card) return null;
    const it = saved.get(`w:${wordKey(card.word)}`);
    const ctx = (() => {
      const i = card.ctx.toLowerCase().indexOf(card.word.toLowerCase());
      return i < 0 ? [card.ctx] : [card.ctx.slice(0, i), h("b", {}, card.ctx.slice(i, i + card.word.length)), card.ctx.slice(i + card.word.length)];
    })();
    return h(
      "div",
      { class: "card", id: "card" },
      h("button", { class: "close", "aria-label": "\u5173\u95ED", onClick: () => {
        card = null;
        render();
      } }, "\u2715"),
      h("div", { class: "w1" }, card.word),
      h("div", { class: "tr1" }, card.loading ? "\u7FFB\u8BD1\u4E2D\u2026" : card.tr || card.err || ""),
      h("div", { class: "ctx" }, ctx),
      h(
        "div",
        { class: "btns" },
        ...WORD_COLORS.map((c) => h("button", { class: `cbtn ${c}` + (it?.color === c ? " on" : ""), id: "wc-" + c, onClick: () => saveWord(c) }, COLORS[c].label)),
        it ? h("button", { class: "cbtn", onClick: () => saveWord(null) }, "\u53D6\u6D88\u6536\u85CF") : null
      )
    );
  }
  function render() {
    const keepScroll = document.getElementById("list")?.scrollTop;
    const body = prefs.tab === "words" ? wordsTab() : prefs.tab === "saved" ? savedTab() : linesTab();
    const root = h(
      "div",
      { class: "app" },
      h(
        "div",
        { class: "head" },
        h("div", { class: "tabs", role: "tablist" }, ...[["lines", "\u5B57\u5E55"], ["words", "\u5355\u8BCD"], ["saved", `\u6536\u85CF${saved.size ? " " + saved.size : ""}`]].map(([k, t]) => h("button", { class: "tab" + (prefs.tab === k ? " on" : ""), role: "tab", "data-tab": k, onClick: () => setPref({ tab: k }) }, t))),
        h("button", { class: "ico", title: "\u8BBE\u7F6E\uFF08\u7FFB\u8BD1\u5F15\u64CE\u4E0E\u5BC6\u94A5\uFF09", "aria-label": "\u8BBE\u7F6E", onClick: () => chrome.runtime.openOptionsPage() }, "\u2699")
      ),
      video ? h("div", { class: "sub", title: video.title }, video.title || video.key, video.src === "yt-transcript" ? h("span", { class: "srcb", title: "\u5B57\u5E55\u6765\u81EA YouTube \u81EA\u5E26\u7684\u8F6C\u5199\uFF0C\u5DF2\u6574\u7406\u6210\u4E0E\u64AD\u653E\u8FDB\u5EA6\u5BF9\u9F50\u7684\u53E5\u5B50" }, ` \xB7 YouTube \u8F6C\u5199${video.srcInfo?.lang ? "\uFF08" + (LANGS[video.srcInfo.lang] || video.srcInfo.lang) + (video.srcInfo.kind === "asr" ? " \xB7 \u81EA\u52A8\u751F\u6210" : "") + "\uFF09" : ""}`) : null, video.src === "yt-transcript" ? h("button", { class: "btn", id: "retx", style: "margin-left:8px", title: "\u91CD\u65B0\u53D6\u4E00\u904D YouTube \u8F6C\u5199\u5E76\u6574\u7406", onClick: async () => {
        const r = await sendToTab({ type: "reloadTranscript" });
        toast(r ? "\u6B63\u5728\u91CD\u65B0\u6574\u7406\u2026" : "\u8BF7\u5148\u5728\u89C6\u9891\u9875\u9762\u5F00\u542F\u5B57\u5E55\u7FFB\u8BD1");
      } }, "\u27F3 \u91CD\u65B0\u6574\u7406") : null) : h("div", { class: "sub" }, "\u6CA1\u6709\u6B63\u5728\u8BB0\u5F55\u7684\u89C6\u9891"),
      video || prefs.tab === "saved" ? body : h("div", { class: "list" }, h("div", { class: "empty" }, "\u8FD8\u6CA1\u6709\u5B57\u5E55\u3002\u6253\u5F00\u6709\u5B57\u5E55\u7684\u89C6\u9891\uFF0C\u70B9\u63D2\u4EF6\u56FE\u6807\u5F00\u542F\u201C\u5B57\u5E55\u7FFB\u8BD1\u201D\uFF0C\u8FD9\u91CC\u5C31\u4F1A\u5217\u51FA\u8BC6\u522B\u5230\u7684\u5168\u90E8\u5B57\u5E55\u3002")),
      cardView()
    );
    clear(app).append(root);
    const list = document.getElementById("list");
    if (list && keepScroll) list.scrollTop = keepScroll;
    if (prefs.tab === "lines") markCurrent(false);
  }
  function markCurrent(scroll) {
    const list = document.getElementById("list");
    if (!list) return;
    list.querySelector(".ln.cur")?.classList.remove("cur");
    const el = nowId ? list.querySelector(`.ln[data-id="${CSS.escape(nowId)}"]`) : null;
    el?.classList.add("cur");
    if (el && scroll && prefs.follow) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  var reloadTimer = 0;
  var reloadSoon = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload({ keepNow: true }), 250);
  };
  async function init() {
    settings = await loadSettings();
    watchSettings((s) => {
      settings = s;
      render();
    });
    await loadSaved();
    tab = await activeTab();
    await reload();
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === "tx-updated" && m.key === video?.key) reloadSoon();
    });
    chrome.storage.onChanged.addListener(async (ch, area2) => {
      if (area2 !== "session") return;
      const st = tab ? await statusOf() : null;
      if (st?.video?.key !== video?.key) {
        await reload();
        return;
      }
      if (st?.video && st.video.lineId !== nowId) {
        nowId = st.video.lineId;
        markCurrent(true);
      }
      if (st?.video && st.video.n !== video.lines.length) reloadSoon();
    });
    if (!q.get("tabId")) {
      chrome.tabs.onActivated.addListener(async () => {
        tab = await activeTab();
        loopId = "";
        card = null;
        await reload();
      });
      chrome.tabs.onUpdated.addListener((id, info) => {
        if (tab && id === tab.id && (info.status === "complete" || info.url)) reloadSoon();
      });
    }
  }
  init().catch((e) => {
    app.textContent = "\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
  });
})();
