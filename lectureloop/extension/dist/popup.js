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

  // ../extension/src/core/langs.js
  var LANGS = { zh: "\u4E2D\u6587", en: "\u82F1\u8BED", fr: "\u6CD5\u8BED" };
  var SOURCE_OPTIONS = { auto: "\u81EA\u52A8\u5224\u65AD", ...LANGS };
  var FR = new Set(`le la les un une des du de au aux et est sont pas ne que qui quoi dans pour avec sur mais ou o\xF9 donc car ce cet cette ces je tu il elle nous vous ils elles on mon ma mes ton ta tes son sa ses notre votre leur leurs oui non tr\xE8s bien \xEAtre avoir fait faire suis es \xEAtes sommes ai as avons avez ont merci bonjour bonsoir salut monsieur madame mademoiselle alors comme aussi encore toujours jamais rien tout tous toute plus moins peu beaucoup d\xE9j\xE0 jusqu aujourd hui chez sans sous entre vers depuis pendant \xE7a ici l\xE0 voil\xE0 allez viens vas veux peux dois faut puis parce quand comment pourquoi quel quelle quels`.split(/\s+/));
  var EN = new Set(`the a an and is are was were not no that this these those with for you i he she we they it my your his her our their yes very be been being have has had do does did of to in on at but or so if what who how why when where can could will would just there here from by as about up out get got go going know think want like see say okay hello thanks thank please sorry don't doesn't didn't can't won't isn't aren't it's i'm you're we're they're that's what's let's gonna wanna gotta yeah nope`.split(/\s+/));

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

  // public/js/lib/providers.js
  var PROVIDERS = {
    anthropic: {
      name: "Anthropic Claude",
      kind: "anthropic",
      base: "https://api.anthropic.com",
      cors: "yes",
      pref: { main: [/^claude-opus-5-5$/, /^claude-opus-5/, /opus/], fast: [/^claude-haiku-5-5$/, /haiku/] },
      defaults: { main: "claude-opus-5-5", fast: "claude-opus-5-5" }
    },
    openai: {
      name: "OpenAI",
      kind: "openai",
      base: "https://api.openai.com/v1",
      cors: "yes",
      json: "schema",
      tokenParam: "max_completion_tokens",
      maxOut: 32e3,
      pref: { main: [/^gpt-5(\.\d+)?$/, /^gpt-4\.1$/, /^gpt-4o$/], fast: [/^gpt-5(\.\d+)?-mini$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/] }
    },
    gemini: {
      name: "Google Gemini",
      kind: "openai",
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
      cors: "yes",
      json: "schema",
      maxOut: 16e3,
      pref: { main: [/^gemini-[\d.]+-pro$/], fast: [/^gemini-[\d.]+-flash$/] },
      note: "AIza\u2026 \u683C\u5F0F\u540C\u65F6\u4E5F\u662F Google Translate \u7684\u5BC6\u94A5\u683C\u5F0F\uFF0C\u8FD9\u91CC\u6309 Gemini \u9A8C\u8BC1"
    },
    deepseek: { name: "DeepSeek\uFF08\u6DF1\u5EA6\u6C42\u7D22\uFF09", kind: "openai", base: "https://api.deepseek.com", cors: "unknown", json: "object", maxOut: 8e3, defaults: { main: "deepseek-chat", fast: "deepseek-chat" } },
    moonshot: {
      name: "Moonshot Kimi\uFF08\u6708\u4E4B\u6697\u9762\uFF09",
      kind: "openai",
      base: "https://api.moonshot.cn/v1",
      cors: "unknown",
      json: "object",
      maxOut: 8e3,
      pref: { main: [/^kimi-k2-0905/, /^kimi-k2/], fast: [/^moonshot-v1-8k$/] },
      defaults: { main: "moonshot-v1-32k", fast: "moonshot-v1-8k" }
    },
    zhipu: {
      name: "\u667A\u8C31 GLM",
      kind: "openai",
      base: "https://open.bigmodel.cn/api/paas/v4",
      cors: "unknown",
      json: "object",
      maxOut: 8e3,
      pref: { main: [/^glm-4\.5$/, /^glm-4-plus$/], fast: [/^glm-4(\.5)?-flash$/, /^glm-4-flash$/] },
      defaults: { main: "glm-4-plus", fast: "glm-4-flash" }
    },
    dashscope: {
      name: "\u963F\u91CC\u4E91\u767E\u70BC\uFF08\u901A\u4E49\u5343\u95EE\uFF09",
      kind: "openai",
      base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      cors: "unknown",
      json: "object",
      maxOut: 8e3,
      pref: { main: [/^qwen-plus$/, /^qwen3-max$/], fast: [/^qwen-turbo$/, /^qwen-flash$/] },
      defaults: { main: "qwen-plus", fast: "qwen-turbo" }
    },
    siliconflow: {
      name: "\u7845\u57FA\u6D41\u52A8 SiliconFlow",
      kind: "openai",
      base: "https://api.siliconflow.cn/v1",
      cors: "unknown",
      json: "object",
      maxOut: 8e3,
      defaults: { main: "Qwen/Qwen2.5-72B-Instruct", fast: "Qwen/Qwen2.5-7B-Instruct" }
    },
    volcengine: {
      name: "\u706B\u5C71\u65B9\u821F\uFF08\u8C46\u5305\uFF09",
      kind: "openai",
      base: "https://ark.cn-beijing.volces.com/api/v3",
      cors: "unknown",
      json: "object",
      maxOut: 8e3,
      needsModel: true,
      note: "\u9700\u8981\u586B\u5199\u201C\u63A5\u5165\u70B9 ID\u201D\uFF08ep- \u5F00\u5934\uFF09\u6216\u6A21\u578B\u540D\u4F5C\u4E3A\u6A21\u578B"
    },
    openrouter: { name: "OpenRouter", kind: "openai", base: "https://openrouter.ai/api/v1", cors: "yes", json: "object", maxOut: 16e3, needsModel: true, note: "\u9700\u8981\u81EA\u5DF1\u9009\u62E9\u6A21\u578B\uFF0C\u4F8B\u5982 anthropic/claude-sonnet-4.5" },
    groq: { name: "Groq", kind: "openai", base: "https://api.groq.com/openai/v1", cors: "yes", json: "object", maxOut: 8e3, defaults: { main: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant" } },
    xai: { name: "xAI Grok", kind: "openai", base: "https://api.x.ai/v1", cors: "unknown", json: "object", maxOut: 16e3, pref: { main: [/^grok-4$/, /^grok-3$/], fast: [/mini/] } },
    custom: { name: "\u81EA\u5B9A\u4E49\uFF08OpenAI \u517C\u5BB9\uFF09", kind: "openai", base: "", cors: "direct", json: "object", maxOut: 8e3, needsModel: true, needsBase: true, note: "\u586B\u5199 Base URL\uFF08\u4F8B\u5982\u672C\u5730 Ollama\uFF1Ahttp://localhost:11434/v1\uFF09\u3002\u53EA\u80FD\u4ECE\u6D4F\u89C8\u5668\u76F4\u8FDE\uFF0C\u4E0D\u8D70\u4E2D\u7EE7" }
  };

  // ../extension/src/core/keys.js
  var loadKeys = async (c = globalThis.chrome) => {
    const { keys: keys2 = {}, use = "" } = await c.storage.local.get(["keys", "use"]);
    return { keys: keys2, use: keys2[use] ? use : Object.keys(keys2)[0] || "" };
  };

  // ../extension/src/popup.js
  var q = new URLSearchParams(location.search);
  var app = document.getElementById("app");
  var tab = null;
  var settings = null;
  var keys = null;
  var statuses = [];
  async function init() {
    if (q.get("tabId")) tab = { id: +q.get("tabId"), url: q.get("url") || "" };
    else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    settings = await loadSettings();
    keys = await loadKeys();
    await readStatus();
    watchSettings((s) => {
      settings = s;
      render();
    });
    chrome.storage.onChanged.addListener((ch, area2) => {
      if (area2 === "session" || area2 === "local" && ch.keys) {
        Promise.all([readStatus(), loadKeys().then((k) => {
          keys = k;
        })]).then(render);
      }
    });
    render();
  }
  async function readStatus() {
    const all = await chrome.storage.session.get(null);
    statuses = Object.entries(all).filter(([k]) => k.startsWith(`st:${tab?.id}:`)).map(([, v]) => v);
  }
  var siteOfTab = () => {
    try {
      return new URL(tab.url).hostname;
    } catch {
      return "";
    }
  };
  var supported = () => /^https?:/i.test(tab?.url || "");
  var isOn = () => statuses.some((s) => s.on);
  async function setEnabled(on) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "setEnabled", on });
    } catch {
    }
    if (!on) statuses = [];
    setTimeout(async () => {
      await readStatus();
      render();
    }, 400);
  }
  var set = (patch) => {
    settings = { ...settings, ...patch };
    saveSettings(patch);
    render();
  };
  function statusBox() {
    const best = statuses.filter((s) => s.on).sort((a, b) => (b.source ? 1 : 0) - (a.source ? 1 : 0))[0];
    if (!supported()) return h("div", { class: "status warn" }, "\u8FD9\u4E2A\u9875\u9762\u4E0D\u652F\u6301\uFF08\u6D4F\u89C8\u5668\u5185\u90E8\u9875\u9762\u6216\u5E94\u7528\u5546\u5E97\u9875\u9762\u65E0\u6CD5\u4F7F\u7528\u6269\u5C55\uFF09\u3002");
    if (!best) return h("div", { class: "status muted" }, "\u672A\u5F00\u542F\u3002\u6253\u5F00\u4E0A\u9762\u7684\u5F00\u5173\uFF0C\u6216\u6309 Alt+T\u3002");
    const lines = [];
    let tone = "ok";
    if (best.source) lines.push(h("div", {}, "\u2714 \u5B57\u5E55\u6765\u6E90\uFF1A", best.source.label, best.source.lang ? `\uFF08${best.source.lang}\uFF09` : ""));
    else {
      tone = "warn";
      lines.push(h("div", {}, "\u2026 \u8FD8\u6CA1\u627E\u5230\u5B57\u5E55\u3002\u8BF7\u5148\u5728\u64AD\u653E\u5668\u91CC\u6253\u5F00\u5B57\u5E55\uFF1B\u6CA1\u6709\u53CD\u5E94\u5C31\u70B9\u201C\u9009\u53D6\u5B57\u5E55\u4F4D\u7F6E\u201D\u3002"));
    }
    const eng = best.provider === "gtx" ? "Google \u514D\u8D39\u7FFB\u8BD1" : best.provider?.startsWith("ai:") ? `AI\uFF08${PROVIDERS[best.provider.slice(3)]?.name || best.provider}\uFF09` : best.provider === "chrome" ? "Chrome \u5185\u7F6E\u7FFB\u8BD1" : "";
    if (best.translated || eng) lines.push(h("div", { class: "tiny muted" }, `\u5DF2\u7FFB\u8BD1 ${best.translated} \u53E5${eng ? " \xB7 \u5F15\u64CE\uFF1A" + eng : ""}`));
    if (best.note) {
      tone = "warn";
      lines.push(h("div", { class: "tiny" }, best.note));
    }
    if (best.error) {
      tone = "err";
      lines.push(h("div", { class: "tiny" }, "\u26A0 ", best.error));
    }
    return h("div", { class: "status " + tone }, lines);
  }
  function sel(id, options, value, onChange, labelText) {
    const s = h("select", { id, onChange: (e) => onChange(e.target.value) }, Object.entries(options).map(([k, v]) => h("option", { value: k, selected: k === value }, v)));
    return h("div", { class: "grow" }, h("label", { class: "f", for: id }, labelText), s);
  }
  function render() {
    if (document.activeElement?.type === "range") return;
    const site = siteOfTab();
    const hasKey = !!keys?.use;
    const t1 = settings.targets[0], t2 = settings.targets[1] || "";
    const targetOpts = LANGS;
    const root = h(
      "div",
      {},
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("h1", {}, "LectureLoop \u5B57\u5E55\u7FFB\u8BD1"), h("div", { class: "tiny muted" }, site || "\u5F53\u524D\u9875\u9762")),
        h("label", { class: "switch", title: "\u5F00 / \u5173\uFF08Alt+T\uFF09" }, h("input", { type: "checkbox", id: "on", "aria-label": "\u5728\u8FD9\u4E2A\u6807\u7B7E\u9875\u7FFB\u8BD1\u5B57\u5E55", checked: isOn(), disabled: !supported(), onChange: (e) => setEnabled(e.target.checked) }), h("i"))
      ),
      h(
        "div",
        { class: "checks", style: "margin-top:6px" },
        h("label", {}, h("input", { type: "checkbox", id: "always", disabled: !site, checked: !!settings.sites[site], onChange: (e) => set({ sites: { ...settings.sites, [site]: e.target.checked } }) }), "\u4EE5\u540E\u6253\u5F00 ", site || "\u8FD9\u4E2A\u7F51\u7AD9", " \u81EA\u52A8\u5F00\u542F")
      ),
      h("div", { class: "sec" }, statusBox()),
      h(
        "div",
        { class: "sec" },
        h(
          "div",
          { class: "row" },
          sel("src", SOURCE_OPTIONS, settings.source, (v) => set({ source: v }), "\u5B57\u5E55\u8BED\u8A00"),
          h("div", { style: "padding-top:18px" }, "\u2192"),
          sel("t1", targetOpts, t1, (v) => set({ targets: [v, ...t2 && t2 !== v ? [t2] : []] }), "\u7FFB\u8BD1\u6210")
        ),
        h(
          "div",
          { class: "row", style: "margin-top:6px" },
          sel("t2", { "": "\uFF08\u65E0\uFF09", ...targetOpts }, t2, (v) => set({ targets: v ? [t1, v].filter((x, i, a) => a.indexOf(x) === i) : [t1] }), "\u518D\u52A0\u4E00\u79CD\u8BD1\u6587\uFF08\u53EF\u9009\uFF09")
        )
      ),
      h(
        "div",
        { class: "sec checks" },
        h("label", {}, h("input", { type: "checkbox", id: "orig", checked: settings.showOrig || settings.hideSite, disabled: settings.hideSite, onChange: (e) => set({ showOrig: e.target.checked }) }), "\u540C\u65F6\u663E\u793A\u539F\u6587"),
        h("label", {}, h("input", { type: "checkbox", id: "hide", checked: settings.hideSite, onChange: (e) => set({ hideSite: e.target.checked }) }), "\u9690\u85CF\u7F51\u7AD9\u81EA\u5E26\u5B57\u5E55\uFF08\u53EA\u770B\u60AC\u6D6E\u5B57\u5E55\uFF09")
      ),
      h(
        "div",
        { class: "sec" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, h("label", { class: "f", for: "fs" }, "\u5B57\u53F7"), h("input", { type: "range", id: "fs", min: 0.5, max: 2.5, step: 0.1, value: settings.fontScale, onInput: (e) => set({ fontScale: +e.target.value }) })),
          h("div", { class: "grow" }, h("label", { class: "f", for: "bg" }, "\u80CC\u666F\u6DF1\u6D45"), h("input", { type: "range", id: "bg", min: 0, max: 1, step: 0.05, value: settings.bg, onInput: (e) => set({ bg: +e.target.value }) }))
        ),
        h(
          "div",
          { class: "row", style: "margin-top:8px" },
          h("button", { class: "btn grow", id: "pick", disabled: !supported(), title: "\u7F51\u7AD9\u6CA1\u6709\u88AB\u81EA\u52A8\u8BC6\u522B\u65F6\uFF1A\u70B9\u4E00\u4E0B\u6B63\u5728\u663E\u793A\u7684\u5B57\u5E55\u6587\u5B57", onClick: async () => {
            await chrome.tabs.sendMessage(tab.id, { type: "setEnabled", on: true }).catch(() => {
            });
            chrome.tabs.sendMessage(tab.id, { type: "pick" }).catch(() => {
            });
            if (!q.get("tabId")) window.close();
          } }, "\u9009\u53D6\u5B57\u5E55\u4F4D\u7F6E"),
          h("button", { class: "btn grow", id: "reset", title: "\u6062\u590D\u9ED8\u8BA4\u4F4D\u7F6E\uFF0C\u5E76\u6E05\u9664\u8FD9\u4E2A\u7F51\u7AD9\u4E0A\u624B\u52A8\u9009\u53D6\u7684\u5B57\u5E55\u4F4D\u7F6E", onClick: () => set({ pos: null, pickers: Object.fromEntries(Object.entries(settings.pickers).filter(([k]) => k !== site)) }) }, "\u91CD\u7F6E\u4F4D\u7F6E")
        )
      ),
      h(
        "div",
        { class: "sec" },
        sel("eng", { auto: "\u81EA\u52A8\uFF08\u6709 AI \u5BC6\u94A5\u7528 AI\uFF0C\u5426\u5219\u7528 Google \u514D\u8D39\uFF09", llm: "\u53EA\u7528 AI \u5BC6\u94A5", gtx: "\u53EA\u7528 Google \u514D\u8D39\u7FFB\u8BD1", chrome: "\u53EA\u7528 Chrome \u5185\u7F6E\u7FFB\u8BD1" }, settings.engine, (v) => set({ engine: v }), "\u7FFB\u8BD1\u5F15\u64CE"),
        h(
          "div",
          { class: "tiny muted", style: "margin-top:6px" },
          hasKey ? `AI \u5BC6\u94A5\uFF1A${PROVIDERS[keys.use]?.name || keys.use}` : "\u8FD8\u6CA1\u6709 AI \u5BC6\u94A5\u2014\u2014\u73B0\u5728\u7528\u7684\u662F\u514D\u8D39\u7684 Google \u7FFB\u8BD1\uFF08\u8D28\u91CF\u591F\u770B\uFF0C\u4F46\u4E0D\u5982 AI \u8D34\u5408\u8BED\u6C14\uFF09\u3002",
          " ",
          h("a", { href: "#", id: "opts", onClick: (e) => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
          } }, "\u8BBE\u7F6E\u5BC6\u94A5")
        )
      )
    );
    clear(app).append(root);
  }
  init().catch((e) => {
    app.textContent = "\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
  });
})();
