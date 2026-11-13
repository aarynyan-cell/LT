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
  function detectProvider(key) {
    const k = String(key || "").trim();
    const one = (id, confidence = "high") => [{ id, confidence }];
    if (!k) return [];
    if (/^sk-ant-/.test(k)) return one("anthropic");
    if (/^sk-or-/.test(k)) return one("openrouter");
    if (/^xai-/.test(k)) return one("xai");
    if (/^gsk_/.test(k)) return one("groq");
    if (/^AIza[\w-]{35}$/.test(k)) return one("gemini");
    if (/^sk-(proj|svcacct|admin)-/.test(k) || k.includes("T3BlbkFJ")) return one("openai");
    if (/^[0-9a-f]{32}\.[A-Za-z0-9]{8,32}$/.test(k)) return one("zhipu");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return one("volcengine", "medium");
    if (/^sk-[0-9a-f]{32}$/.test(k)) return [{ id: "deepseek", confidence: "medium" }, { id: "dashscope", confidence: "medium" }];
    if (/^sk-[a-z]{48}$/.test(k)) return [{ id: "siliconflow", confidence: "medium" }, { id: "moonshot", confidence: "low" }, { id: "openai", confidence: "low" }];
    if (/^sk-[A-Za-z0-9]{40,64}$/.test(k)) return [{ id: "moonshot", confidence: "medium" }, { id: "openai", confidence: "low" }, { id: "siliconflow", confidence: "low" }];
    if (/^sk-/.test(k)) return ["openai", "deepseek", "moonshot", "dashscope", "siliconflow"].map((id) => ({ id, confidence: "low" }));
    return [];
  }
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
  var maskKey = (k) => k ? `${k.slice(0, 6)}\u2026${k.slice(-4)}` : "";

  // ../extension/src/core/keys.js
  var loadKeys = async (c = globalThis.chrome) => {
    const { keys = {}, use = "" } = await c.storage.local.get(["keys", "use"]);
    return { keys, use: keys[use] ? use : Object.keys(keys)[0] || "" };
  };
  async function saveKey(id, entry, c = globalThis.chrome) {
    const { keys, use } = await loadKeys(c);
    keys[id] = { models: [], ...keys[id], ...entry };
    await c.storage.local.set({ keys, use: use || id });
  }
  async function removeKey(id, c = globalThis.chrome) {
    const { keys, use } = await loadKeys(c);
    delete keys[id];
    await c.storage.local.set({ keys, use: use === id ? Object.keys(keys)[0] || "" : use });
  }
  var setUse = (id, c = globalThis.chrome) => c.storage.local.set({ use: id });
  var loadAsr = async (c = globalThis.chrome) => (await c.storage.local.get("asr")).asr || {};
  var saveAsr = (asr, c = globalThis.chrome) => c.storage.local.set({ asr });
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

  // ../extension/src/core/asr-api.js
  var ASR_PROVIDERS = { openai: { model: "whisper-1" }, groq: { model: "whisper-large-v3-turbo" }, custom: { model: "" } };
  function asrSelection({ keys = {}, use = "" }, asr = {}) {
    const capable = Object.keys(keys).filter((id2) => ASR_PROVIDERS[id2]);
    const id = capable.includes(asr.use) ? asr.use : capable[0];
    if (!id) return null;
    const e = keys[id];
    const model = id === asr.use && asr.model || e.asrModel || ASR_PROVIDERS[id].model;
    if (!model) return null;
    return { id, key: e.key, model, base: e.base || PROVIDERS[id].base };
  }

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
    let msg2 = "";
    try {
      msg2 = (await r.text()).slice(0, 300);
    } catch {
    }
    if (r.status === 401 || r.status === 403) return new ApiError("auth", "\u5BC6\u94A5\u65E0\u6548\u6216\u6CA1\u6709\u6743\u9650", r.status);
    if (r.status === 429) return new ApiError("rate_limit", "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\u6216\u989D\u5EA6\u4E0D\u8DB3", 429);
    if (r.status >= 500) return new ApiError("upstream", `\u670D\u52A1\u5546\u9519\u8BEF ${r.status}`, r.status);
    return new ApiError("bad_request", `\u670D\u52A1\u5546\u62D2\u7EDD\u4E86\u8BF7\u6C42\uFF08${r.status}\uFF09${msg2 ? "\uFF1A" + msg2 : ""}`, r.status);
  }
  async function listModels(p, key, { fetchFn = fetch, base } = {}) {
    let r;
    try {
      r = await fetchFn(`${base || p.base}/models`, { headers: { authorization: `Bearer ${key}` } });
    } catch (e) {
      if (e instanceof TypeError) throw new ApiError("network", NET);
      throw e;
    }
    if (!r.ok) throw await statusError(r);
    let j;
    try {
      j = await r.json();
    } catch {
      throw new ApiError("bad_json", "\u670D\u52A1\u5546\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u6A21\u578B\u5217\u8868");
    }
    return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
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
    const msg2 = j?.error?.message || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) return new ApiError("auth", "Claude \u5BC6\u94A5\u65E0\u6548\u6216\u6CA1\u6709\u6743\u9650", r.status);
    if (r.status === 429) return new ApiError("rate_limit", "Claude \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\u6216\u989D\u5EA6\u4E0D\u8DB3", 429);
    if (r.status >= 500) return new ApiError("upstream", `Claude \u670D\u52A1\u9519\u8BEF ${r.status}`, r.status);
    return new ApiError("bad_request", msg2, r.status);
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
        const msg2 = await r.clone().json().then((j2) => j2?.error?.message || "").catch(() => "");
        if (/effort|output_config|format|schema/i.test(msg2)) {
          level = /effort/i.test(msg2) && level === 0 ? 1 : 2;
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
  async function anthropicModels(key, base, fetchFn) {
    const r = await withTimeout(fetchFn, `${base || PROVIDERS.anthropic.base}/v1/models?limit=100`, { headers: anthropicHeaders(key) });
    if (r.status === 401 || r.status === 403) throw new ApiError("auth", "\u5BC6\u94A5\u65E0\u6548\u6216\u6CA1\u6709\u6743\u9650", r.status);
    if (!r.ok) throw new ApiError("upstream", `HTTP ${r.status}`, r.status);
    return ((await r.json()).data || []).map((m) => m.id);
  }
  async function probeKey(key, { candidates, base, fetchFn = fetch } = {}) {
    const ids = candidates?.length ? candidates : detectProvider(key).map((c) => c.id);
    const tried = [];
    for (const id of ids) {
      const p = PROVIDERS[id];
      const b = base || p.base;
      try {
        const models = id === "anthropic" ? await anthropicModels(key, b, fetchFn) : await listModels(p, key, { fetchFn: (u, i) => withTimeout(fetchFn, u, i), base: b });
        return { ok: true, id, models, base: b, ...pickModels(p, models) };
      } catch (e) {
        tried.push({ id, code: e.code || "error", message: e.message });
      }
    }
    return { ok: false, tried };
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
  async function stats() {
    const [videos, tm, saved] = await Promise.all([run("videos", "readonly", (s) => s.count()), run("tm", "readonly", (s) => s.count()), run("saved", "readonly", (s) => s.count())]);
    return { videos, tm, saved };
  }
  var clearTranscripts = async () => {
    await run("videos", "readwrite", (s) => s.clear());
    await run("tm", "readwrite", (s) => s.clear());
  };

  // ../extension/src/options.js
  var app = document.getElementById("app");
  var state = { keys: {}, use: "" };
  var msg = null;
  var busy = false;
  var dbStats = null;
  var asrCfg = {};
  var refresh = async () => {
    asrCfg = await loadAsr();
    state = await loadKeys();
    dbStats = await stats().catch(() => null);
    render();
  };
  var say = (tone, text) => {
    msg = { tone, text };
    render();
  };
  async function addKey() {
    const key = document.getElementById("key").value.trim();
    const base = document.getElementById("base").value.trim().replace(/\/+$/, "");
    const prov = document.getElementById("prov").value;
    if (!key && !base) return say("err", "\u8BF7\u5148\u7C98\u8D34\u5BC6\u94A5\u3002");
    busy = true;
    say("", "\u6B63\u5728\u8BC6\u522B\u5E76\u9A8C\u8BC1\u5BC6\u94A5\u2026");
    try {
      let candidates;
      if (prov) candidates = [prov];
      else if (base) candidates = ["custom"];
      if (base) {
        const origin = new URL(base).origin + "/*";
        if (!await chrome.permissions.contains({ origins: [origin] }) && !await chrome.permissions.request({ origins: [origin] })) throw new Error("\u9700\u8981\u6388\u6743\u8BBF\u95EE\u8FD9\u4E2A\u5730\u5740\uFF0C\u624D\u80FD\u8C03\u7528\u5B83\u3002");
      }
      const r = await probeKey(key, { candidates, base });
      if (!r.ok) {
        const why = r.tried.length ? r.tried.map((t) => `${PROVIDERS[t.id]?.name || t.id}\uFF1A${t.message}`).join("\uFF1B") : "\u65E0\u6CD5\u4ECE\u683C\u5F0F\u5224\u65AD\u670D\u52A1\u5546\uFF0C\u8BF7\u5728\u201C\u670D\u52A1\u5546\u201D\u91CC\u624B\u52A8\u9009\u62E9\u3002";
        throw new Error(`\u6CA1\u80FD\u9A8C\u8BC1\u8FD9\u4E2A\u5BC6\u94A5\u3002${why}`);
      }
      const fast = r.fast || (r.models.length === 1 ? r.models[0] : "");
      await saveKey(r.id, { key, models: r.models, model: r.main || "", fastModel: fast, ...base ? { base } : {} });
      document.getElementById("key").value = "";
      busy = false;
      await refresh();
      say(fast || r.main ? "ok" : "err", fast || r.main ? `\u2714 \u5DF2\u4FDD\u5B58\uFF1A${PROVIDERS[r.id].name}\uFF08\u5B57\u5E55\u7FFB\u8BD1\u7528\u6A21\u578B\uFF1A${fast || r.main}\uFF09\u3002` : `\u5DF2\u4FDD\u5B58 ${PROVIDERS[r.id].name} \u7684\u5BC6\u94A5\uFF0C\u4F46\u9700\u8981\u5728\u4E0B\u9762\u7684\u5217\u8868\u91CC\u9009\u4E00\u4E2A\u6A21\u578B\u624D\u80FD\u4F7F\u7528\u3002`);
    } catch (e) {
      busy = false;
      say("err", e.message);
    }
  }
  async function testProvider(id) {
    const sel = selection({ keys: state.keys, use: id });
    busy = true;
    say("", "\u6B63\u5728\u7FFB\u8BD1\u4E00\u53E5\u8BDD\u6D4B\u8BD5\u2026");
    const t0 = performance.now();
    try {
      const r = await translateLLM({ sel, source: "en", targets: ["zh"], items: [{ i: 0, t: "Don't look at me like that. I told you it was a bad idea." }] });
      busy = false;
      say("ok", `\u2714 ${Math.round(performance.now() - t0)} \u6BEB\u79D2\uFF1A${r.results.zh?.[0]?.t || "(\u7A7A)"}`);
    } catch (e) {
      busy = false;
      say("err", `\u6D4B\u8BD5\u5931\u8D25\uFF1A${e.message}`);
    }
  }
  async function testFree() {
    busy = true;
    say("", "\u6B63\u5728\u6D4B\u8BD5 Google \u514D\u8D39\u7FFB\u8BD1\u2026");
    const t0 = performance.now();
    try {
      const s = await loadSettings();
      const r = await translateGtx({ source: "en", targets: ["zh"], items: [{ i: 0, t: "Don't look at me like that." }], endpoint: s.endpoints.gtx });
      busy = false;
      say("ok", `\u2714 ${Math.round(performance.now() - t0)} \u6BEB\u79D2\uFF1A${r.results.zh[0].t}`);
    } catch (e) {
      busy = false;
      say("err", `\u6D4B\u8BD5\u5931\u8D25\uFF1A${e.message}`);
    }
  }
  function render() {
    const ids = Object.keys(state.keys);
    const el = h(
      "div",
      {},
      h("h1", {}, "LectureLoop \u5B57\u5E55\u7FFB\u8BD1 \xB7 \u8BBE\u7F6E"),
      h("div", { class: "muted" }, "\u5B57\u5E55\u7FFB\u8BD1\u4E0D\u9700\u8981\u5BC6\u94A5\u4E5F\u80FD\u7528\uFF08\u514D\u8D39\u7684 Google \u7FFB\u8BD1\uFF09\u3002\u60F3\u8981\u66F4\u8D34\u5408\u8BED\u6C14\u3001\u4FDA\u8BED\u548C\u4E0A\u4E0B\u6587\u7684\u7FFB\u8BD1\uFF0C\u53EF\u4EE5\u586B\u4E00\u4E2A AI \u670D\u52A1\u7684\u5BC6\u94A5\u3002"),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "\u6DFB\u52A0 AI \u5BC6\u94A5"),
        h(
          "div",
          { class: "col" },
          h("input", { type: "password", id: "key", placeholder: "\u7C98\u8D34\u5BC6\u94A5\uFF08sk-ant-\u2026\u3001sk-\u2026\u3001AIza\u2026 \u7B49\uFF0C\u81EA\u52A8\u8BC6\u522B\u670D\u52A1\u5546\uFF09", autocomplete: "off", "aria-label": "API \u5BC6\u94A5" }),
          h(
            "details",
            {},
            h("summary", {}, "\u9AD8\u7EA7\uFF1A\u624B\u52A8\u9009\u62E9\u670D\u52A1\u5546 / \u81EA\u5B9A\u4E49\u5730\u5740"),
            h(
              "div",
              { class: "col", style: "margin-top:8px" },
              h("select", { id: "prov", "aria-label": "\u670D\u52A1\u5546" }, h("option", { value: "" }, "\u81EA\u52A8\u8BC6\u522B"), Object.entries(PROVIDERS).map(([k, p]) => h("option", { value: k }, p.name))),
              h("input", { type: "url", id: "base", placeholder: "\u81EA\u5B9A\u4E49 Base URL\uFF08\u4F8B\u5982\u672C\u673A Ollama\uFF1Ahttp://localhost:11434/v1\uFF09", "aria-label": "\u81EA\u5B9A\u4E49\u5730\u5740" })
            )
          ),
          h("div", { class: "row" }, h("button", { class: "btn primary", id: "add", disabled: busy, onClick: addKey }, "\u9A8C\u8BC1\u5E76\u4FDD\u5B58"), h("span", { class: "tiny muted" }, "\u5BC6\u94A5\u53EA\u4FDD\u5B58\u5728\u8FD9\u53F0\u7535\u8111\u7684\u6D4F\u89C8\u5668\u91CC\uFF0C\u53EA\u4F1A\u53D1\u7ED9\u4F60\u9009\u7684\u670D\u52A1\u5546\u3002"))
        ),
        msg ? h("div", { class: "msg " + msg.tone, id: "msg" }, msg.text) : null
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "\u5DF2\u4FDD\u5B58\u7684\u5BC6\u94A5"),
        ids.length ? ids.map((id) => {
          const e = state.keys[id], p = PROVIDERS[id];
          const picked = pickModels(p, e.models || []);
          const list = picked.list;
          const cur = e.fastModel || e.model || picked.fast || picked.main || "";
          return h(
            "div",
            { class: "prov" },
            h("input", { type: "radio", name: "use", id: "use-" + id, checked: state.use === id, "aria-label": `\u7528 ${p.name} \u7FFB\u8BD1\u5B57\u5E55`, onChange: async () => {
              await setUse(id);
              await refresh();
            } }),
            h("div", { class: "grow" }, h("div", { class: "name" }, p.name, state.use === id ? h("span", { class: "pill", style: "margin-left:6px" }, "\u6B63\u5728\u4F7F\u7528") : null), h("div", { class: "tiny muted mono" }, maskKey(e.key), e.base ? " \xB7 " + e.base : "")),
            list.length ? h("select", { "aria-label": "\u5B57\u5E55\u7FFB\u8BD1\u7528\u7684\u6A21\u578B", style: "width:200px", onChange: async (ev) => {
              await saveKey(id, { fastModel: ev.target.value });
              await refresh();
            } }, cur ? [] : [h("option", { value: "", selected: true, disabled: true }, "\u2014 \u8BF7\u9009\u62E9\u6A21\u578B \u2014")], list.map((m) => h("option", { value: m, selected: m === cur }, m))) : h("span", { class: "tiny muted" }, cur || "\uFF08\u672A\u9009\u62E9\u6A21\u578B\uFF09"),
            h("button", { class: "btn", disabled: busy, onClick: () => testProvider(id) }, "\u6D4B\u8BD5"),
            h("button", { class: "btn danger", onClick: async () => {
              await removeKey(id);
              await refresh();
            } }, "\u5220\u9664")
          );
        }) : h("div", { class: "muted" }, "\u8FD8\u6CA1\u6709\u3002")
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "\u8BED\u97F3\u8BC6\u522B\uFF08\u89C6\u9891\u6CA1\u6709\u5B57\u5E55\u65F6\uFF09"),
        (() => {
          const capable = Object.keys(state.keys).filter((id) => ASR_PROVIDERS[id]);
          const sel = asrSelection(state, asrCfg);
          if (!capable.length) return h("div", { class: "muted", id: "asr-none" }, "\u89C6\u9891\u6CA1\u6709\u4EFB\u4F55\u5B57\u5E55\u65F6\uFF0C\u63D2\u4EF6\u53EF\u4EE5\u542C\u89C6\u9891\u7684\u58F0\u97F3\u8BC6\u522B\u6210\u5B57\u5E55\u518D\u7FFB\u8BD1\u3002\u8FD9\u9700\u8981\u4E00\u4E2A\u652F\u6301\u201C\u8BED\u97F3\u8F6C\u5199\uFF08Whisper\uFF09\u201D\u7684\u670D\u52A1\uFF1A\u5728\u4E0A\u9762\u6DFB\u52A0 OpenAI \u6216 Groq \u7684\u5BC6\u94A5\uFF08\u6216\u586B\u5199\u81EA\u5B9A\u4E49\u7684 Whisper \u63A5\u53E3\u5730\u5740\uFF09\u5373\u53EF\u3002Anthropic / DeepSeek \u7B49\u6CA1\u6709\u8BED\u97F3\u8F6C\u5199\uFF0C\u4E0D\u80FD\u7528\u4E8E\u8FD9\u91CC\u3002");
          return h(
            "div",
            { class: "col" },
            h(
              "div",
              { class: "row" },
              h("select", { id: "asr-use", "aria-label": "\u8BED\u97F3\u8BC6\u522B\u670D\u52A1", onChange: async (e) => {
                await saveAsr({ ...asrCfg, use: e.target.value, model: "" });
                await refresh();
              } }, capable.map((id) => h("option", { value: id, selected: sel?.id === id }, PROVIDERS[id].name))),
              h("input", { type: "text", id: "asr-model", "aria-label": "\u8BED\u97F3\u8BC6\u522B\u6A21\u578B", placeholder: "\u6A21\u578B\uFF08" + (sel ? ASR_PROVIDERS[sel.id].model || "\u5FC5\u586B" : "") + "\uFF09", value: sel?.id === asrCfg.use && asrCfg.model || state.keys[sel?.id]?.asrModel || "", style: "max-width:220px", onChange: async (e) => {
                const v = e.target.value.trim();
                if (sel) {
                  await saveKey(sel.id, { asrModel: v });
                  await saveAsr({ ...asrCfg, use: sel.id, model: v });
                  await refresh();
                }
              } })
            ),
            h("div", { class: "tiny muted" }, sel ? `\u5F53\u524D\uFF1A${PROVIDERS[sel.id].name} \xB7 ${sel.model}\u3002\u8BC6\u522B\u6309\u201C\u4E00\u53E5\u8BDD\u4E00\u5757\u201D\u7684\u97F3\u9891\u53D1\u9001\uFF08\u53EA\u53D1\u9001\u6709\u4EBA\u8BF4\u8BDD\u7684\u90E8\u5206\uFF09\uFF0C\u58F0\u97F3\u53EA\u53D1\u7ED9\u8FD9\u4E2A\u670D\u52A1\u3002` : "\u81EA\u5B9A\u4E49\u5730\u5740\u9700\u8981\u586B\u5199\u6A21\u578B\u540D\u540E\u624D\u80FD\u4F7F\u7528\u3002")
          );
        })()
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "\u672C\u5730\u6570\u636E"),
        h("div", { class: "muted", id: "dbstats" }, dbStats ? `\u5DF2\u4FDD\u5B58 ${dbStats.videos} \u4E2A\u89C6\u9891\u7684\u5B57\u5E55\u3001${dbStats.tm} \u6761\u7FFB\u8BD1\u8BB0\u5FC6\u3001${dbStats.saved} \u4E2A\u6536\u85CF\u3002` : "\u2026"),
        h(
          "div",
          { class: "row", style: "margin-top:8px" },
          h("button", { class: "btn danger", id: "clear-tx", onClick: async () => {
            if (!confirm("\u6E05\u9664\u6240\u6709\u89C6\u9891\u7684\u5B57\u5E55\u8BB0\u5F55\u548C\u7FFB\u8BD1\u8BB0\u5FC6\uFF1F\uFF08\u4E0D\u5F71\u54CD\u6536\u85CF\u7684\u5355\u8BCD\u548C\u53E5\u5B50\uFF09")) return;
            await clearTranscripts();
            dbStats = await stats();
            say("ok", "\u5DF2\u6E05\u9664\u5B57\u5E55\u8BB0\u5F55\u4E0E\u7FFB\u8BD1\u8BB0\u5FC6\u3002");
          } }, "\u6E05\u9664\u5B57\u5E55\u8BB0\u5F55\u4E0E\u7FFB\u8BD1\u8BB0\u5FC6"),
          h("span", { class: "tiny muted" }, "\u8FD9\u4E9B\u6570\u636E\u53EA\u5728\u8FD9\u53F0\u7535\u8111\u7684\u6D4F\u89C8\u5668\u91CC\uFF1B\u6709\u4E86\u5B83\u4EEC\uFF0C\u540C\u4E00\u4E2A\u89C6\u9891\u518D\u770B\u4E00\u904D\u4E0D\u4F1A\u91CD\u590D\u7FFB\u8BD1\u3002")
        )
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "\u514D\u8D39\u7FFB\u8BD1"),
        h("div", { class: "row" }, h("button", { class: "btn", id: "free", disabled: busy, onClick: testFree }, "\u6D4B\u8BD5 Google \u514D\u8D39\u7FFB\u8BD1"), h("span", { class: "tiny muted" }, "\u975E\u5B98\u65B9\u7684\u7F51\u9875\u63A5\u53E3\uFF0C\u4E0D\u9700\u8981\u5BC6\u94A5\uFF1B\u7528\u5F97\u592A\u9891\u7E41\u53EF\u80FD\u88AB\u4E34\u65F6\u9650\u6D41\u3002")),
        h("div", { class: "tiny muted", style: "margin-top:8px" }, "\u5B57\u5E55\u7684\u7FFB\u8BD1\u8BF7\u6C42\u4F1A\u53D1\u7ED9\u4F60\u9009\u62E9\u7684\u7FFB\u8BD1\u670D\u52A1\uFF08Google \u6216\u4F60\u7684 AI \u670D\u52A1\u5546\uFF09\uFF1B\u6CA1\u6709\u5176\u4ED6\u6570\u636E\u79BB\u5F00\u4F60\u7684\u6D4F\u89C8\u5668\u3002")
      )
    );
    clear(app).append(el);
  }
  refresh().catch((e) => {
    app.textContent = "\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
  });
})();
