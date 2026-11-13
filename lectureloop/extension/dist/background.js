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
  var NOT_CHAT = /embed|whisper|tts|dall|moderation|image|audio|realtime|transcribe|rerank|guard|speech/i;
  function pickModels(p, ids = []) {
    const list = [...new Set(ids.map((x) => String(x).replace(/^models\//, "")).filter((x) => !NOT_CHAT.test(x)))];
    const find = (res) => {
      for (const re of res || []) {
        const hit = list.filter((m) => re.test(m)).sort().reverse()[0];
        if (hit) return hit;
      }
      return null;
    };
    const main = find(p.pref?.main) || p.defaults?.main || null;
    const fast = find(p.pref?.fast) || p.defaults?.fast || main;
    return { main, fast, list };
  }

  // ../extension/src/core/keys.js
  var loadKeys = async (c = globalThis.chrome) => {
    const { keys = {}, use = "" } = await c.storage.local.get(["keys", "use"]);
    return { keys, use: keys[use] ? use : Object.keys(keys)[0] || "" };
  };
  function selection({ keys, use }) {
    const e = keys?.[use];
    const provider = PROVIDERS[use];
    if (!e || !provider) return null;
    const picked = pickModels(provider, e.models || []);
    return { id: use, provider, key: e.key, model: e.fastModel || e.model || picked.fast || picked.main, base: e.base || provider.base };
  }

  // public/js/lib/errors.js
  var ApiError = class extends Error {
    constructor(code, message, status = 0) {
      super(message);
      this.code = code;
      this.status = status;
    }
  };

  // public/js/lib/ai-tasks.js
  function parseLooseJson(text) {
    const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      return JSON.parse(t);
    } catch {
    }
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("no json");
  }
  var str = { type: "string" };
  var int = { type: "integer" };
  var obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  var arr = (items) => ({ type: "array", items });
  var withCue = (props) => obj({ ...props, cue: int });
  var NOTES_SCHEMA = obj({
    overview: str,
    parts: arr(obj({ start_cue: int, title: str, summary: str })),
    key_points: arr(withCue({ text: str })),
    concepts: arr(withCue({ term: str, definition: str })),
    formulas: arr(withCue({ expression: str, spoken: str, explanation: str })),
    emphasized: arr(withCue({ text: str })),
    questions: arr(withCue({ text: str }))
  });
  var PATTERN_FN = ["introduce", "define", "emphasize", "contrast", "cause_effect", "example", "transition", "check", "summarize", "condition"];
  var LANGUAGE_SCHEMA = obj({
    corrections: arr(obj({ wrong: str, right: str, reason: str })),
    vocab: arr(
      obj({
        term: str,
        pos: str,
        kind: { type: "string", enum: ["term", "phrase", "collocation"] },
        cue: int,
        def: obj({ zh: str, en: str, fr: str }),
        heard_as: arr(str)
      })
    ),
    patterns: arr(
      obj({
        fn: { type: "string", enum: PATTERN_FN },
        template: str,
        explain: str,
        cue: int,
        extensions: arr(obj({ en: str, zh: str }))
      })
    )
  });
  var TR_LANG = { zh: "Simplified Chinese", en: "English", fr: "French" };
  var TRANSLATE_SCHEMA = {
    type: "object",
    properties: { items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, t: { type: "string" } }, required: ["i", "t"], additionalProperties: false } } },
    required: ["items"],
    additionalProperties: false
  };
  function subtitleTask({ items, source, target, context = [], glossary = [] }) {
    const from = source && source !== "auto" ? TR_LANG[source] || source : "the language of each line (French, English or Chinese; detect it per line)";
    const system = `You translate subtitles of TV shows, films and online videos from ${from} to ${TR_LANG[target] || target}.
Each input line is "index|text" and is one subtitle cue (it may hold two speakers, marked with "-").
Rules: natural spoken ${TR_LANG[target] || target} that keeps the speaker's tone, register, slang, jokes and swearing; short enough to read in 2-3 seconds; keep names and song lyrics marks (\u266A) as they are; if a line is already in the target language return it unchanged; never explain, never add information; use the previous lines only as context${glossary.length ? `; glossary: ${glossary.slice(0, 80).join("; ")}` : ""}; return exactly one item per input line with the same index; do not merge or split lines.`;
    const ctx = context.length ? `Previous lines (context only, do NOT translate):
${context.slice(-3).join("\n")}

` : "";
    const user = `${ctx}Translate these lines:
${items.map((c) => `${c.i}|${c.t.replace(/\s+/g, " ").trim()}`).join("\n")}`;
    return { system, user, schema: TRANSLATE_SCHEMA, effort: "low", maxTokens: 4e3 };
  }
  function alignTranslation(items, data) {
    const byI = new Map((data?.items || []).map((x) => [x.i, String(x.t || "")]));
    if (byI.size === 0) return null;
    return items.map((c) => ({ i: c.i, t: byI.get(c.i) ?? "" }));
  }

  // public/js/lib/llm-openai.js
  var NET = "\u65E0\u6CD5\u8FDE\u63A5\u670D\u52A1\u5546\uFF08\u7F51\u7EDC\u95EE\u9898\u3001\u6D4F\u89C8\u5668\u8DE8\u57DF\u9650\u5236\uFF0C\u6216\u9700\u8981\u4F7F\u7528\u4E2D\u7EE7\uFF09";
  async function statusError(r) {
    let msg = "";
    try {
      msg = (await r.text()).slice(0, 300);
    } catch {
    }
    if (r.status === 401 || r.status === 403) return new ApiError("auth", "\u5BC6\u94A5\u65E0\u6548\u6216\u6CA1\u6709\u6743\u9650", r.status);
    if (r.status === 429) return new ApiError("rate_limit", "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\u6216\u989D\u5EA6\u4E0D\u8DB3", 429);
    if (r.status >= 500) return new ApiError("upstream", `\u670D\u52A1\u5546\u9519\u8BEF ${r.status}`, r.status);
    return new ApiError("bad_request", `\u670D\u52A1\u5546\u62D2\u7EDD\u4E86\u8BF7\u6C42\uFF08${r.status}\uFF09${msg ? "\uFF1A" + msg : ""}`, r.status);
  }
  async function askJsonOpenAI({ p, key, model, system, user, schema, maxTokens = 8e3, fetchFn = fetch, base, signal }) {
    const build = (mode2) => {
      const sys = mode2 === "schema" ? system : `${system}

Return ONLY one JSON object (no markdown, no commentary) that matches this JSON Schema:
${JSON.stringify(schema)}`;
      const body = {
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        [p.tokenParam || "max_tokens"]: Math.min(maxTokens, p.maxOut || maxTokens),
        response_format: mode2 === "schema" ? { type: "json_schema", json_schema: { name: "result", strict: true, schema } } : { type: "json_object" }
      };
      return body;
    };
    const send = async (mode2) => {
      let r2;
      try {
        r2 = await fetchFn(`${base || p.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(build(mode2)), signal });
      } catch (e) {
        if (e instanceof TypeError) throw new ApiError("network", NET);
        throw e;
      }
      return r2;
    };
    let mode = p.json === "schema" ? "schema" : "object";
    let r = await send(mode);
    if (!r.ok && mode === "schema" && r.status === 400) {
      const txt = await r.clone().text().catch(() => "");
      if (/response_format|json_schema|schema|unsupported/i.test(txt)) {
        mode = "object";
        r = await send(mode);
      }
    }
    if (!r.ok) throw await statusError(r);
    const j = await r.json().catch(() => null);
    const choice = j?.choices?.[0];
    if (!choice) throw new ApiError("bad_json", "\u670D\u52A1\u5546\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9");
    if (choice.message?.refusal || choice.finish_reason === "content_filter") throw new ApiError("refusal", `\u6A21\u578B\u62D2\u7EDD\u4E86\u8BE5\u8BF7\u6C42${choice.message?.refusal ? "\uFF1A" + choice.message.refusal : "\uFF08\u5185\u5BB9\u8FC7\u6EE4\uFF09"}`, 422);
    if (choice.finish_reason === "length") throw new ApiError("max_tokens", "\u8F93\u51FA\u88AB\u622A\u65AD\uFF08\u8D85\u8FC7\u8BE5\u6A21\u578B\u7684\u8F93\u51FA\u4E0A\u9650\uFF09\uFF0C\u8BF7\u6362\u4E00\u4E2A\u8F93\u51FA\u66F4\u957F\u7684\u6A21\u578B\u6216\u7F29\u77ED\u8F93\u5165", 422);
    try {
      return { data: parseLooseJson(choice.message?.content ?? ""), model: j.model || model };
    } catch {
      throw new ApiError("bad_json", "\u6A21\u578B\u8FD4\u56DE\u7684\u5185\u5BB9\u4E0D\u662F\u6709\u6548 JSON");
    }
  }

  // ../extension/src/core/llm.js
  var ANTHROPIC_VERSION = "2023-06-01";
  var TIMEOUT = 2e4;
  var anthropicHeaders = (key) => ({ "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" });
  async function withTimeout(fetchFn, url, init, ms = TIMEOUT) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetchFn(url, { ...init, signal: ctl.signal });
    } catch (e) {
      throw new ApiError(e.name === "AbortError" ? "timeout" : "network", e.name === "AbortError" ? "\u7FFB\u8BD1\u8BF7\u6C42\u8D85\u65F6" : "\u65E0\u6CD5\u8FDE\u63A5\u7FFB\u8BD1\u670D\u52A1\uFF08\u7F51\u7EDC\u95EE\u9898\uFF09");
    } finally {
      clearTimeout(timer);
    }
  }
  async function anthropicError(r) {
    const j = await r.json().catch(() => ({}));
    const msg = j?.error?.message || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) return new ApiError("auth", "Claude \u5BC6\u94A5\u65E0\u6548\u6216\u6CA1\u6709\u6743\u9650", r.status);
    if (r.status === 429) return new ApiError("rate_limit", "Claude \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\u6216\u989D\u5EA6\u4E0D\u8DB3", 429);
    if (r.status >= 500) return new ApiError("upstream", `Claude \u670D\u52A1\u9519\u8BEF ${r.status}`, r.status);
    return new ApiError("bad_request", msg, r.status);
  }
  async function askAnthropicRaw({ key, model, base = PROVIDERS.anthropic.base, fetchFn = fetch }, { system, user, schema, effort, maxTokens }) {
    const build = (level2) => {
      const sys = level2 < 2 ? system : `${system}

Return ONLY one JSON object (no markdown) that matches this JSON Schema:
${JSON.stringify(schema)}`;
      const body = { model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: user }] };
      if (level2 < 2) body.output_config = { ...level2 === 0 && effort ? { effort } : {}, format: { type: "json_schema", schema } };
      return body;
    };
    let level = 0, r;
    for (; ; ) {
      r = await withTimeout(fetchFn, `${base}/v1/messages`, { method: "POST", headers: anthropicHeaders(key), body: JSON.stringify(build(level)) });
      if (r.ok) break;
      if (r.status === 400 && level < 2) {
        const msg = await r.clone().json().then((j2) => j2?.error?.message || "").catch(() => "");
        if (/effort|output_config|format|schema/i.test(msg)) {
          level = /effort/i.test(msg) && level === 0 ? 1 : 2;
          continue;
        }
      }
      throw await anthropicError(r);
    }
    const j = await r.json().catch(() => null);
    if (j?.stop_reason === "refusal") throw new ApiError("refusal", "\u6A21\u578B\u62D2\u7EDD\u4E86\u8FD9\u6BB5\u5B57\u5E55", 422);
    const text = (j?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    try {
      return { data: parseLooseJson(text), model: j.model || model };
    } catch {
      throw new ApiError("bad_json", "\u6A21\u578B\u8FD4\u56DE\u7684\u5185\u5BB9\u4E0D\u662F\u6709\u6548 JSON");
    }
  }
  async function translateLLM({ sel, source, targets, items, context = [], glossary = [], fetchFn = fetch }) {
    if (!sel) throw new ApiError("no_key", "\u672A\u8BBE\u7F6E AI \u5BC6\u94A5");
    if (!sel.model) throw new ApiError("no_model", `\u8BF7\u5148\u4E3A ${sel.provider.name} \u9009\u62E9\u6A21\u578B`);
    const results = {};
    await Promise.all(targets.filter((t) => t !== source).map(async (target) => {
      const task = subtitleTask({ items, source, target, context, glossary });
      const { data } = sel.provider.kind === "anthropic" ? await askAnthropicRaw({ key: sel.key, model: sel.model, base: sel.base, fetchFn }, task) : await askJsonOpenAI({ p: sel.provider, key: sel.key, model: sel.model, base: sel.base, fetchFn: (u, i) => withTimeout(fetchFn, u, i), ...task });
      const out = alignTranslation(items, data);
      if (!out) throw new ApiError("bad_json", "\u7FFB\u8BD1\u7ED3\u679C\u4E3A\u7A7A");
      results[target] = out;
    }));
    return { provider: `ai:${sel.id}`, results };
  }

  // ../extension/src/core/engines.js
  var GTX = "https://translate.googleapis.com/translate_a/single";
  var GCODE = { zh: "zh-CN", en: "en", fr: "fr", auto: "auto" };
  async function mapLimit(arr2, n, fn) {
    const out = new Array(arr2.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, arr2.length) }, async () => {
      while (next < arr2.length) {
        const i = next++;
        out[i] = await fn(arr2[i], i);
      }
    }));
    return out;
  }
  async function translateGtx({ source, targets, items, fetchFn = fetch, endpoint = GTX }) {
    const results = {};
    for (const target of targets.filter((t) => t !== source)) {
      results[target] = await mapLimit(items, 4, async (it) => {
        const url = `${endpoint}?client=gtx&sl=${GCODE[source] || "auto"}&tl=${GCODE[target]}&dt=t&q=${encodeURIComponent(it.t)}`;
        let r;
        try {
          r = await fetchFn(url);
        } catch {
          throw new ApiError("network", "\u65E0\u6CD5\u8FDE\u63A5 Google \u7FFB\u8BD1\uFF08\u7F51\u7EDC\u95EE\u9898\uFF09");
        }
        if (r.status === 429) throw new ApiError("rate_limit", "Google \u514D\u8D39\u7FFB\u8BD1\u88AB\u9650\u6D41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u6362\u7528 AI \u5BC6\u94A5", 429);
        if (!r.ok) throw new ApiError("upstream", `Google \u7FFB\u8BD1\u9519\u8BEF ${r.status}`, r.status);
        const j = await r.json().catch(() => null);
        if (!Array.isArray(j?.[0])) throw new ApiError("bad_json", "Google \u7FFB\u8BD1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u5185\u5BB9");
        return { i: it.i, t: j[0].map((x) => x?.[0] || "").join("").trim() };
      });
    }
    return { provider: "gtx", results };
  }
  async function translateBatch(req, { keys, endpoints = {}, fetchFn = fetch }) {
    const { source = "auto", targets, items, context = [], engine = "auto" } = req;
    const order = engine === "llm" ? ["llm"] : engine === "gtx" ? ["gtx"] : engine === "auto" ? ["llm", "gtx"] : [];
    let note = "", last = null;
    for (const name of order) {
      try {
        if (name === "llm") {
          const sel = selection(keys);
          if (!sel) {
            last = new ApiError("no_key", "\u8FD8\u6CA1\u6709\u8BBE\u7F6E AI \u5BC6\u94A5");
            continue;
          }
          return { ...await translateLLM({ sel, source, targets, items, context, fetchFn }), note };
        }
        return { ...await translateGtx({ source, targets, items, fetchFn, endpoint: endpoints.gtx }), note };
      } catch (e) {
        last = e;
        if (name === "llm" && e.code !== "no_key") note = `AI \u7FFB\u8BD1\u5931\u8D25\uFF08${e.message}\uFF09\uFF0C\u5DF2\u6539\u7528 Google \u514D\u8D39\u7FFB\u8BD1`;
      }
    }
    throw last || new ApiError("no_provider", "\u6CA1\u6709\u53EF\u7528\u7684\u7FFB\u8BD1\u5F15\u64CE");
  }

  // ../extension/src/core/tm.js
  var tmKey = (source, target, text) => `${source}|${target}|${text}`;
  async function translateWithTM(req, { getMany, putMany, run: run2, wantAI = false }) {
    const { source = "auto", targets, items } = req;
    const found = await getMany(items.flatMap((it) => targets.map((t) => tmKey(source, t, it.t))));
    const results = Object.fromEntries(targets.map((t) => [t, []]));
    const miss = [];
    let hits = 0;
    for (const it of items) {
      const per = {};
      let ok = true;
      for (const t of targets) {
        const e = found.get(tmKey(source, t, it.t));
        if (!e || !e.t || wantAI && e.p === "gtx") {
          ok = false;
          break;
        }
        per[t] = e.t;
      }
      if (ok) {
        hits++;
        for (const t of targets) results[t].push({ i: it.i, t: per[t] });
      } else miss.push(it);
    }
    let provider = "cache", note = "";
    if (miss.length) {
      const r = await run2({ ...req, items: miss });
      provider = r.provider;
      note = r.note || "";
      const entries = [];
      for (const t of targets) for (const x of r.results?.[t] || []) {
        results[t].push(x);
        const src = miss.find((m) => m.i === x.i);
        if (src && x.t) entries.push({ k: tmKey(source, t, src.t), t: x.t, p: provider.startsWith("ai:") ? "ai" : provider, ts: Date.now() });
      }
      if (entries.length) await putMany(entries).catch(() => {
      });
    }
    for (const t of targets) results[t].sort((a, b) => a.i - b.i);
    return { provider, results, note, cached: hits };
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
      if (!cur && !inc.id.startsWith("t")) {
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

  // ../extension/src/core/store.js
  var NAME = "lectureloop-subs";
  var TM_MAX = 4e4;
  var TM_PRUNE = 8e3;
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
  async function upsertVideo(meta, lines, { replace = false } = {}) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("videos", "readwrite");
      const s = t.objectStore("videos");
      const g = s.get(meta.key);
      g.onsuccess = () => {
        const cur = g.result || { key: meta.key, lines: [] };
        const next = { ...cur, ...meta, lines: mergeLines(replace ? [] : cur.lines, lines), updated: Date.now() };
        s.put(next);
      };
      t.oncomplete = () => res(true);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  async function tmGetMany(keys) {
    const out = /* @__PURE__ */ new Map();
    if (!keys.length) return out;
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("tm", "readonly");
      const s = t.objectStore("tm");
      for (const k of keys) s.get(k).onsuccess = (e) => {
        if (e.target.result) out.set(k, e.target.result);
      };
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  async function tmPutMany(entries) {
    await run("tm", "readwrite", (s) => {
      for (const e of entries) s.put(e);
    });
    const n = await run("tm", "readonly", (s) => s.count());
    if (n > TM_MAX) await tmPrune(n - TM_MAX + TM_PRUNE);
  }
  async function tmPrune(count) {
    await run("tm", "readwrite", (s) => {
      let left = count;
      s.index("ts").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c && left-- > 0) {
          c.delete();
          c.continue();
        }
      };
    });
  }

  // ../extension/src/background.js
  try {
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
  }
  var err = (e) => ({ ok: false, error: { code: e.code || "error", message: e.message || String(e) } });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === "translate") {
      (async () => {
        try {
          const [keys, settings] = await Promise.all([loadKeys(), loadSettings()]);
          const run2 = (r) => translateBatch(r, { keys, endpoints: settings.endpoints });
          const wantAI = !!selection(keys) && msg.engine !== "gtx";
          reply({ ok: true, result: await translateWithTM(msg, { getMany: tmGetMany, putMany: tmPutMany, run: run2, wantAI }) });
        } catch (e) {
          reply(err(e));
        }
      })();
      return true;
    }
    if (msg?.type === "tx-get") {
      getVideo(msg.key).then((video) => reply({ ok: true, video })).catch((e) => reply(err(e)));
      return true;
    }
    if (msg?.type === "tx-upsert") {
      upsertVideo(msg.video, msg.lines, { replace: !!msg.replace }).then(() => {
        reply({ ok: true });
        chrome.runtime.sendMessage({ type: "tx-updated", key: msg.video.key }).catch(() => {
        });
      }).catch((e) => reply(err(e)));
      return true;
    }
    if (msg?.type === "status" && sender.tab) {
      const k = `st:${sender.tab.id}:${sender.frameId}`;
      if (msg.status?.on === false) chrome.storage.session.remove(k);
      else chrome.storage.session.set({ [k]: { ...msg.status, t: Date.now() } });
      if (msg.status?.closedByUser) chrome.storage.session.remove(k);
    }
    if (msg?.type === "pickDone" && sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: "pickCancel" }).catch(() => {
    });
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const all = await chrome.storage.session.get(null);
    const dead = Object.keys(all).filter((k) => k.startsWith(`st:${tabId}:`));
    if (dead.length) chrome.storage.session.remove(dead);
  });
  chrome.commands.onCommand.addListener(async (cmd) => {
    if (cmd === "panel") {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t?.id) chrome.sidePanel.open({ tabId: t.id }).catch(() => {
      });
      return;
    }
    if (cmd !== "toggle") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const all = await chrome.storage.session.get(null);
    const isOn = Object.entries(all).some(([k, v]) => k.startsWith(`st:${tab.id}:`) && v.on);
    chrome.tabs.sendMessage(tab.id, { type: "setEnabled", on: !isOn }).catch(() => {
    });
  });
})();
