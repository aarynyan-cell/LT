# LectureLoop 前端技术方案

| 项目 | 内容 |
|---|---|
| 版本 | v0.2（2026-11-12），对应 [PRD v0.2](./01-PRD.md) 与 [产品设计 v0.2](./02-product-design.md) |
| 现状 | `app/` 为按本方案实现的 Web 应用（已部署在 Cloudflare Workers，也可 `npm start` 本地运行）；`extension/` 为 Chrome 字幕翻译插件（§10）。两者共用 `app/public/js/lib/` 里的提示词、服务商表与 OpenAI 兼容客户端 |
| 主线 | **零构建、本地优先、领域逻辑与 UI 解耦**，为"V1 迁移 React+TS / V2 浏览器插件"留好接口 |

---

## 1. 约束与目标

| 约束 | 含义 | 对方案的影响 |
|---|---|---|
| **本地一条命令跑起来** | 产品负责人要能直接调试 | MVP 零构建、零前端依赖安装；后端仅 1 个 npm 依赖（Claude SDK） |
| **本地优先 / 可离线** | 录音与转录是私有数据 | IndexedDB 存储；库/Studio/训练不依赖网络 |
| **长列表 + 高频更新** | 2 小时课时 ≈ 2,000 句，播放时每帧更新高亮 | 折叠渲染 Part；高亮绕过 VDOM |
| **多后端能力会变** | ASR/翻译/LLM 都可能更换 | Provider 接口 + 能力探测 + 降级 |
| **将来要做插件** | 同一套代码跑在 Side Panel | UI / 领域 / 数据三层分离，不在组件里写业务 |
| **音频播放精度** | A-B 循环、逐句重复误差 < 100 ms | rAF 轮询而非 `timeupdate` |

---

## 2. 技术选型

### 2.1 UI 框架

| 方案 | 零构建 | 组件化 | 迁移到 React/插件 | 体积 | 评价 |
|---|---|---|---|---|---|
| 原生 JS + innerHTML | ✔ | ✘ | 重写 | 0 | 6 个以上视图后难以维护 |
| **Preact + htm（无构建）** | **✔** | **✔（Hooks）** | **机械迁移（htm→JSX）** | **~13 KB** | **MVP 采用** |
| React 18 + Vite + TS | ✘（需构建） | ✔ | 即目标 | ~45 KB | **V1 目标栈** |
| Vue 3 | 可 CDN | ✔ | 重写 | ~35 KB | 团队若偏 Vue 可选 |
| Svelte | ✘ | ✔ | 重写 | 小 | 编译期框架，插件生态略弱 |

**决策**：MVP 用 **Preact + htm**（单文件 vendoring 于 `public/vendor/htm-preact.js`，离线可用）。其 Hooks API 与 React 一致，V1 切到 `Vite + React + TypeScript` 时只需把 `` html`...` `` 模板改为 JSX，业务代码（`lib/`、`store`、`db`）原样复用。

### 2.2 其它选型

| 关注点 | MVP | V1/V2 | 理由 |
|---|---|---|---|
| 状态管理 | 自写 ~50 行 store（`subscribe` + `useStore`） | Zustand | 状态简单；避免引入概念 |
| 路由 | Hash 路由（零依赖） | React Router / TanStack Router | 静态托管/插件页都友好 |
| 本地存储 | 原生 IndexedDB 薄封装 | Dexie；大音频改 OPFS | 需存 Blob 与索引查询 |
| 样式 | 手写 CSS + 设计令牌（CSS 变量） | CSS Modules | 深浅色/主题切换靠变量 |
| 音频 | `HTMLAudioElement` + `preservesPitch` | + Web Audio 提取波形峰值 | 变速保音高最稳 |
| TTS 兜底 | `speechSynthesis` | — | 无录音也能演示/练习 |
| 实时 ASR | Web Speech API（`SpeechRecognition`） | Deepgram/Azure 流式（WebSocket，经后端签发临时凭证） | 见 PRD §9.2 |
| 录音 | `MediaRecorder`（webm/opus；Safari mp4） | — | 时间零点=录音起点 |
| docx 解析 | 自写迷你 ZIP 读取 + `DecompressionStream('deflate-raw')` | 同左 | 不引入 mammoth/JSZip，几十行即可 |
| 后端 | Node 22 原生 `http` + `@anthropic-ai/sdk` | Hono/Fastify，或 Cloudflare Workers/Vercel Edge | 无状态代理，仅保管密钥 |
| 测试 | `node:test`（领域层）+ Playwright（E2E，可选） | Vitest + Playwright | 领域模块可在 Node 中直接测试 |
| 插件 | — | **WXT**（MV3）：Side Panel + offscreen document + `tabCapture` | 复用同一套 UI 与 `lib/` |

---

## 3. 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│ views/        页面（Home Live Library Course Lesson Drill Vocab …） │  只做展示与事件
│ components/   通用 UI（Modal Toast Timeline Transcript Importer）   │
├─────────────────────────────────────────────────────────────────┤
│ store.js      应用状态 + 动作（actions）：所有写入的唯一入口           │  编排
├─────────────────────────────────────────────────────────────────┤
│ lib/services  player.js  asr.js  api.js          （有副作用、依赖浏览器）│
│ lib/domain    text.js  importers.js  zip.js  heuristics.js         │  纯函数，可在 Node 测试
│               glossary.js  srs.js  diff.js                         │
├─────────────────────────────────────────────────────────────────┤
│ db.js         IndexedDB（courses lessons transcripts audio clips …）│  持久化
└──────────────┬──────────────────────────────────────────────────┘
               │ fetch /api/*
┌──────────────▼──────────────────────────────────────────────────┐
│ server.js     /api/config  /api/translate  /api/ai/notes|language │  无状态代理
│               Claude（SDK） · Google Translate · 静态托管           │
└─────────────────────────────────────────────────────────────────┘
```

**依赖方向**：`views → store → (services, domain) → db`，反向禁止。`domain` 不得引用 DOM/IndexedDB，保证可测试、可搬进插件或 Worker。

---

## 4. 目录结构

```
lectureloop/
├─ README.md
├─ docs/                          PRD / 设计 / 前端方案
└─ app/
   ├─ package.json                依赖 @anthropic-ai/sdk（devDependency：esbuild）；scripts: start / dev / test / mock / build:sdk / build:ext
   ├─ server.js                   入口：静态托管 + API 路由 + /relay
   ├─ server/
   │  ├─ env.js                   轻量 .env 加载
   │  ├─ claude.js                SDK 封装：结构化输出/流式/拒答/降级
   │  ├─ ai.js                    notes / language 任务：提示词 + JSON Schema + 校验
   │  └─ translate.js             Provider 链：Google → Claude
   ├─ worker/                     Cloudflare Worker：index.js（静态资源 + /relay）、relay.js（同源中继，主机白名单）
   ├─ tools/mock-api.mjs          本地模拟 Claude（流式/非流式）+ Google v2 + OpenAI 兼容 + 免费 gtx（无密钥开发与测试）
   ├─ tools/build-sdk.mjs         把官方 SDK 打包成浏览器可 import 的单文件
   ├─ tools/build-ext.mjs         构建插件：esbuild 打包 → extension/dist、生成 manifest、打 zip（public/downloads/）
   ├─ tests/                      domain.test.mjs · ext.test.mjs（node:test）；e2e/*.cjs（Playwright：回归、后台录制、悬浮字幕、识别、语音、课程库编辑、插件）
   └─ public/
      ├─ index.html
      ├─ css/app.css              设计令牌 + 组件样式
      ├─ vendor/htm-preact.js     Preact + htm 单文件
      └─ js/
         ├─ main.js               启动：初始化 DB → store → 渲染
         ├─ app.js                壳：侧栏、路由、Toast、全局快捷键
         ├─ store.js              状态 + actions
         ├─ db.js                 IndexedDB 封装
         ├─ lib/
         │  ├─ util.js            id/时间格式化/防抖
         │  ├─ text.js            断句、估算时间轴、锚点插值、分 Part、高亮
         │  ├─ importers.js       txt/md/docx/srt/vtt → cues；文件名解析
         │  ├─ zip.js             迷你 ZIP 读取（docx）
         │  ├─ heuristics.js      离线摘要 / 词汇候选 / 话语标记句式
         │  ├─ glossary.js        课程术语表 + 内置 ML/统计"常被听错"起始词表 + 纠错应用/撤销
         │  ├─ diff.js            词级 diff（听写评分）
         │  ├─ srs.js             Leitner 调度
         │  ├─ player.js          三引擎播放器（Audio / TTS / Clock）
         │  ├─ asr.js             Web Speech + MediaRecorder + 演示课堂；接入话语跟踪器，识别日志
         │  ├─ utterance.js       话语跟踪器（纯逻辑）：丢字修复、时间校正、稳定前缀提前提交
         │  ├─ live.js            全局实时听课控制器（单例）+ useLive；翻译队列；Wake Lock；草稿
         │  ├─ parts.js           片段编辑纯函数：重命名 / 并入上段 / 从某句拆分 / 不变量校验
         │  ├─ voices.js          朗读语音分档与挑选（排除新奇语音）
         │  ├─ providers.js       服务商表 + 密钥格式识别 + 默认模型挑选（Web 应用与插件共用）
         │  ├─ llm-openai.js      OpenAI 兼容客户端（json_schema / json_object 降级；插件共用）
         │  ├─ llm-client.js      浏览器端统一 AI 客户端（Anthropic SDK 打包版 + OpenAI 兼容 + 中继）
         │  ├─ byok.js            自带密钥（多服务商，localStorage）
         │  ├─ ai-tasks.js        提示词 / Schema / 校验（服务端、浏览器、插件三处共用；含 translateTask 与 subtitleTask）
         │  ├─ api.js             后端客户端（含浏览器内置 Translator 降级）
         │  └─ seed.js            示例课程
         ├─ components/           ui.js timeline.js transcript.js playerbar.js importer.js dialogs.js（课程/课时/片段编辑对话框）floating.js（悬浮字幕 + 桌面 PiP）
         └─ views/                home live library course lesson notes language clips drill vocab settings
```

```
lectureloop/extension/              Chrome 字幕翻译插件（可直接"加载已解压的扩展程序"）
├─ manifest.json                    由 tools/build-ext.mjs 生成（MV3；host_permissions 来自服务商表）
├─ README.md ui.css icons/ popup/ options/
├─ src/                             源码（ES 模块）
│  ├─ content.js  background.js  popup.js  options.js  dom.js
│  └─ core/  langs · stabilizer · settings · sources · translator · overlay · picker · controller   （页面内）
│            engines · llm · keys                                                                    （后台；密钥只在这里）
└─ dist/                            esbuild 产物（不压缩，已提交）；public/downloads/lectureloop-subtitles.zip 是它的打包
```

---

## 5. 路由与页面结构

| 路由 | 视图 | 主要子组件 | 读取的状态 |
|---|---|---|---|
| `#/` | Home | DueCard · RecentLessons · DensityTrend · ReasonBars | clips（到期）· lessons |
| `#/live` | Live | LiveControls · CaptionStage · StuckButton | settings · 会话内状态 |
| `#/library` | Library | CourseGrid · SearchBox · SearchResults · ImportDialog | courses · lessons |
| `#/course/:cid` | Course | LessonTable · GlossaryEditor | course · lessons · clips 计数 |
| `#/lesson/:lid?t=` | Lesson（Studio） | TranscriptPane · PlayerBar · Timeline · SidePanel(Notes/Language/Clips) · PostClassBanner | lesson · cues · clips · audio |
| `#/drill` `#/drill/:cid` | Drill | DrillCard（Blind/Dictate/Reveal/Rate） | due clips |
| `#/vocab` | Vocab | VocabTable · ExportCSV | 全库词汇 |
| `#/settings` | Settings | ServiceStatus · Prefs · DataTools | config |

### 5.1 Lesson 页组件树

```
Lesson
├─ Header（面包屑 · 时间轴徽标 · 导出）
├─ PostClassBanner（纠错 / 笔记 / 词汇 三步）
├─ main
│  ├─ TranscriptPane
│  │   ├─ Toolbar（译文 · 隐藏语气词 · 盲听 · 搜索本课）
│  │   └─ PartSection × N（折叠） → CueRow × M
│  └─ SidePanel（Tabs）
│      ├─ NotesTab（摘要 · 原文对照 · 我的笔记）
│      ├─ LanguageTab（词汇 · 句式 · 听力陷阱）
│      └─ ClipsTab（卡点 · 片段 · 标签）
└─ PlayerBar（引擎 · 播放控制 · 速度 · 循环 · 重复 · Timeline）
```

---

## 6. 状态与数据层

### 6.1 Store

```js
state = {
  ready, courses[], lessons[], tags[], clips[],      // 轻量元数据常驻内存
  settings{}, config{},                               // 偏好 + 后端能力
  toasts[], route{name, params, query},
}
// 重数据按需加载：transcripts[lessonId]、audio Blob 仅在进入 Lesson 时读取
actions: createCourse, importLesson, saveLesson, updateCues, addClip, rateClip, runNotes, runLanguage, applyCorrections, …
```

所有写入走 `actions`：**先写 IndexedDB，成功后再更新内存状态并通知订阅者**。

### 6.2 IndexedDB Schema（库名 `lectureloop`，v1）

| Store | keyPath | 索引 | 内容 |
|---|---|---|---|
| `courses` | `id` | — | Course（含 glossary） |
| `lessons` | `id` | `courseId` | Lesson（含 parts、notes、language） |
| `transcripts` | `lessonId` | — | `{ lessonId, cues[] }` |
| `audio` | `lessonId` | — | `{ lessonId, blob, mime }` |
| `clips` | `id` | `lessonId` | Clip（含 srs） |
| `tags` | `id` | — | Tag |
| `kv` | `key` | — | 设置、草稿 |

数据规模估算：2 小时课时 ≈ 2,000 Cue ≈ 0.3 MB JSON；录音 ≈ 30–60 MB（opus 64 kbps≈ 57 MB/2h）。

---

## 7. 关键模块设计

### 7.1 导入管线

```
File ─▶ readText(by ext) ─▶ normalize(whitespace) ─▶ splitSentences ─▶ mergeShort / splitLong
      ─▶ estimateTimeline | useTimestamps ─▶ segmentParts ─▶ applyGlossaryAutocorrect(可选) ─▶ Lesson + Transcript
```

- `docx`：`zip.js` 读中央目录定位 `word/document.xml` → `DecompressionStream('deflate-raw')` → 提取 `<w:p>` 段落与 `<w:t>` 文本；段落边界被保留为"停顿"提示。
- `srt/vtt`：解析时间码，直接得到 `timeline='real'`。
- `txt/md`：段落按空行；单段超长文本只靠标点断句。

**断句规则**（`text.js: splitSentences`）：按 `(?<=[.?!])\s+` 切；< 4 词并入后一句（末句并入前一句）；> 40 词在 `, / ; / and / so / but / because` 处优先切开；保证每个 Cue 非空。

### 7.2 时间轴：估算与校准

```
估算:   wps = wpm/60 (默认 150 wpm = 2.5 词/秒)
        cue.dur   = max(1.2, words / wps)
        cue.start = 前一句 end + gap      gap = 0.25s；段落边界 + 0.8s
        有音频时:   整体缩放 k = audioDuration / estimatedDuration

锚点:   anchors = [{ i, t }] 按 i 排序（首尾自动补 0 与 duration）
        对相邻锚点 [a,b]：句 j 的 start = t_a + (cumWords_j - cumWords_a) / (cumWords_b - cumWords_a) × (t_b - t_a)
```

- `Lesson.timeline`：`real`（实录/字幕文件）｜`estimated`｜`calibrated`（≥ 1 个锚点）。
- 校准后重算所有非锚点 Cue 的 `start/end`，并保持 `end_j = start_{j+1} - gap`。

### 7.3 播放器引擎抽象

```ts
interface Engine {
  kind: 'audio' | 'tts' | 'clock'
  load(lesson, cues, blob?): Promise<void>
  play(): void;  pause(): void
  seek(t: number): void
  setRate(r: number): void
  readonly time: number;  readonly duration: number;  readonly playing: boolean
}
// Controller（引擎之上）：
//   loop {a,b,repeatLeft}  repeatCue(n)  prev/next  rAF 轮询 → emit('time') / 'cue' / 'end'
```

| 引擎 | 触发条件 | 实现要点 |
|---|---|---|
| `AudioEngine` | Lesson 有录音 | `<audio>` + `playbackRate` + `preservesPitch`；`objectURL` 离开页面时 revoke |
| `TtsEngine` | 无录音但浏览器有语音 | 逐句 `SpeechSynthesisUtterance`，句末推进；时间轴随 cue 起止同步；片段循环不向前留余量（否则会先念上一句），终点略过句尾等整句念完 |
| `ClockEngine` | 都不可用 | 静音，按速度推进时间；仍可跟读高亮、循环 |

**循环/重复**：rAF 每帧检查 `time >= loop.b - ε`，到点 `seek(loop.a)`；`repeatCue(n)` 即把当前句的 `[start,end]` 设为循环并计数，计数耗尽后跳到下一句。

**高亮**：Transcript 订阅 `cue` 事件，**直接对 DOM 加/去 class 并 `scrollIntoView({block:'center'})`**，不触发组件重渲染。

### 7.4 Live 管线（v0.2）

```
getUserMedia ─┬─▶ MediaRecorder（累积 chunks）                         t0 = recorder.start 时刻
              └─▶ SpeechRecognition(lang, continuous, interim)
                     │ onresult → items[{text, final}] ─▶ UtteranceTracker.feed(items, t)
                     ▼
   UtteranceTracker（纯逻辑，可用模拟事件测试）
     · 记录当前"假设"pending：全文 / 开始 / 最后更新 / 已提前提交的词数 off
     · 新临时结果不是对旧假设的修订 → 先保存旧的（解决"被下一句直接覆盖"丢字）
     · 稳定前缀提交：假设仍在增长时，剩余词数 ≥ 16（中文 ≥ 32 字）或停留 ≥ 6 s，
       就把"除最后 3 词（中文 6 字）以外"提交成一句，优先在 and/so/but/because/okay… 之前切；之后用 off 跳过已提交前缀
     · flush（识别结束 / 暂停 / 停止）保存当前假设
     · 保存时校正时间：结束 = max(最后更新, 定稿到达 - 1.2 s)；语速 < 1.2 词/s 说明开始时间陈旧→推迟；> 6 词/s 说明结束过早
     · provisional 句子被随后高度相似的定稿替换，避免重复
                     ▼
   onFinal(cue{start,end,text}) ─▶ live.js 的全局 state.lines ─▶ pending 队列 ─▶ pump()
   pump()：同一时刻只有一个翻译请求在途（保证顺序）；在途期间新来的句子合并成下一批；上下文 = 前 3 句
   onend（浏览器自动停止）→ 若会话仍在进行则**立即**重启（不用定时器：后台标签的定时器会被降频）
   stuck(Space / 悬浮层🚩) → marks.push({t})；归档时转成 clip
   stop → drain()（等最后一批译文，最多 3 s）→ 组装 Lesson（真实时间轴）+ Blob + clips，自动分 Part，写库，清草稿
```

- **全局单例**：`live.js` 持有会话、字幕与翻译队列；页面（上课页、悬浮字幕、顶部录音条）只订阅状态（`useLive(selector)`，选择器返回值变化才重渲染，避免逐词刷新整页）。
- **保持运行**：visibility 回来时重新申请 Wake Lock；`beforeunload` 提示 + 落草稿；每 30 s 写 `kv:liveDraft`；页面标题显示 `● 时间`。
- **字幕舞台**：渲染全部行（`content-visibility:auto`），`.stage` 记录"是否贴底"（`stick`）：贴底时新行到来自动滚动，`onScroll` 离开底部 > 阈值则 `stick=false` 并累计 `leftAt` 之后的新行数，显示"↓ 回到最新（N 条新字幕）"。
- **悬浮字幕**（`components/floating.js`）：页内块只在 `phase≠idle && settings.float.on` 时渲染；`setPointerCapture` 只在空白处启动（排除 `button,input,label,select`，否则会吞掉按钮的 click）；`ResizeObserver` 记住大小。**桌面窗口**用 `documentPictureInPicture.requestWindow`，复制同源样式表，把 Preact 树渲染进新窗口，`pagehide` 时清理；录音结束时自动关闭。
- **演示课堂**：`DemoSource` 以定时器逐词吐出示例 Cue（模拟 interim → final），与真实源共用同一管线，便于测试。
- **识别日志**：`asr.js` 记录每个原始事件（interim/final/restart/error），设置页可导出，用来对照"屏幕上看到的"与"引擎给过的"。

### 7.5 后端接口契约

**`GET /api/config`**
```json
{ "claude": true, "model": "claude-opus-5-5", "fastModel": "claude-opus-5-5",
  "translate": { "google": false, "claude": true }, "version": "0.1.0" }
```

**`POST /api/translate`**
```json
// req
{ "source": "en", "targets": ["zh", "fr"], "context": ["prev sentence 1", "…"],
  "items": [{ "i": 12, "t": "So you just look at the sign." }], "glossary": ["dot product"] }
// res
{ "provider": "google", "results": { "zh": [{ "i": 12, "t": "所以你只需要看符号。" }], "fr": [ … ] } }
```

**`POST /api/ai/notes`**
```json
// req
{ "course": "MLAI", "title": "SVM", "noteLang": "zh",
  "cues": [{ "i": 0, "t": "Okay so …" }] }
// res
{ "model": "claude-opus-5-5",
  "notes": { "overview": "…", "parts": [{ "startCue": 0, "title": "…", "summary": "…" }],
             "keyPoints": [{ "text": "…", "cue": 41 }], "concepts": [{ "term": "…", "definition": "…", "cue": 8 }],
             "formulas": [{ "expression": "…", "spoken": "…", "explanation": "…", "cue": 55 }],
             "emphasized": [{ "text": "…", "cue": 120 }], "questions": [{ "text": "…", "cue": 130 }] } }
```

**`POST /api/ai/language`**
```json
// res
{ "model": "…", "language": {
  "corrections": [{ "wrong": "dog product", "right": "dot product", "reason": "近音 /t/→/g/" }],
  "vocab": [{ "term": "Gini impurity", "pos": "n.", "kind": "term", "cue": 211,
              "def": { "zh": "基尼不纯度", "en": "…", "fr": "impureté de Gini" }, "heardAs": ["Ginny's score"] }],
  "patterns": [{ "fn": "emphasize", "template": "Keep in mind that …", "explain": "…", "cue": 88,
                 "extensions": [{ "en": "…", "zh": "…" }] }] } }
```

**错误约定**：`{ "error": { "code": "no_key|refusal|max_tokens|upstream|bad_request", "message": "…" } }`，HTTP 4xx/5xx；前端按 `code` 展示文案并降级。

### 7.6 降级矩阵

| 能力 | 首选 | 次选 | 兜底 |
|---|---|---|---|
| 实时识别 | Web Speech | （V1）云 ASR | 演示课堂 / 导入 |
| 译文（课堂） | Google | Claude / 用户自带密钥的任一服务商 | 浏览器内置 Translator → 不翻译 |
| 译文（插件·视频字幕） | 用户 AI 密钥（快速模型） | Google 免费网页接口 | Chrome 内置 Translator（语言包就绪时）→ 只显示原文 + 红点 |
| 笔记 | Claude 结构化输出 | — | 离线抽取式摘要（标注"离线粗略版"） |
| 词汇/句式 | Claude | — | 离线 n-gram 候选 + 话语标记正则 |
| 纠错 | Claude + 课程术语表 | — | 内置 ML/统计"常被听错"起始词表 + 用户术语表 |
| 播放 | 录音 | TTS | 静音计时器 |

### 7.7 SRS（`srs.js`）

`box ∈ {0..5}`，间隔 `[0, 1, 3, 7, 14, 30]` 天；自评 `没懂→box=1，10 分钟后可再练`、`勉强→box 不变（至少 1），due=按 box`、`听懂→box+1（新卡直接进盒 2）`；在盒 5 再次听懂→`status='mastered'`。队列排序：`due` 升序，新卡优先于同日到期。

**片段定位**：Clip 存 `startCue/endCue`（句索引），播放时由句子时间推导区间（`clipTimes`）。这样锚点校准、绑定录音重标定之后，卡点仍然指向同一段话，而不是一个已经失效的时间。

---

## 8. 性能策略

| 点 | 做法 |
|---|---|
| 2,000 句渲染 | Part 折叠，仅展开片段渲染 `CueRow`；"全部展开"超过 600 句时分批 `requestIdleCallback` 渲染 |
| 播放高亮 | 直接操作 DOM class，避免每帧重渲染 |
| 时间轴 | 密度条为一次性计算的 `div` 序列（≤ 400 个桶）；拖拽用 `pointer events` + `rAF` 节流 |
| 搜索 | 进入库页时对 Cue 建立小写文本数组；10 万词库线性扫描 < 100 ms；输入防抖 150 ms |
| 大文本导入 | 断句/估算在主线程分片（每 500 句 `await` 一个 microtask）或 Worker（V1） |
| 内存 | `transcripts` 与 `audio` 按需读取，离开 Lesson 释放 `objectURL` |

---

## 9. 兼容性

| 能力 | Chrome/Edge | Safari | Firefox | 备注 |
|---|---|---|---|---|
| IndexedDB / 录音 / 播放 | ✔ | ✔ | ✔ | Safari 录音为 mp4/aac |
| Web Speech 识别 | ✔ | 部分（`webkit` 前缀） | ✘ | 能力探测，不支持→演示/导入 |
| `speechSynthesis` | ✔ | ✔ | ✔ | 语音包因系统而异 |
| `DecompressionStream` | ✔ | ✔(16.4+) | ✔(113+) | docx 解析依赖；不支持则提示改用 txt |
| 浏览器内置 Translator | ✔(新版) | ✘ | ✘ | 实验性降级 |
| Document Picture-in-Picture | ✔(116+) | ✘ | ✘ | 悬浮字幕"弹出到桌面"；不支持时隐藏该按钮 |
| Wake Lock | ✔ | ✔(16.4+) | ✔(126+) | 录音期间保持屏幕常亮，失败则忽略 |
| 字幕翻译插件 | ✔(MV3, 116+) | ✘ | ✘ | 仅 Chromium 内核 |

---

## 10. 浏览器插件

### 10.1 已实现：Chrome 字幕翻译插件（`extension/`，v0.1）

**定位**：读取网页里**已有的字幕** → 翻译 → 悬浮显示。不做音频识别，不依赖 Web 应用的数据（IndexedDB）。

```
Manifest V3
├─ content script（<all_urls>，全帧，document_idle）   默认休眠：只监听消息与设置；开启后才创建 Controller
│    Controller：每 150 ms 轮询 → readFirst(sources) → Stabilizer → TranslateQueue → Overlay
├─ background service worker                           翻译请求的唯一出口：engines.translateBatch（密钥只在这里）
│    chrome.commands（Alt+T）· storage.session（各框架状态）· storage.local 限制为 TRUSTED_CONTEXTS
├─ action popup / options page                         设置、状态、密钥管理（页面脚本，直接用 chrome.* 与共享模块）
└─ 不需要 side panel / offscreen / tabCapture（那是"无字幕视频"的第二阶段，见 10.4）
```

**内容脚本模块（`src/core/`）**

| 模块 | 职责 |
|---|---|
| `sources.js` | 字幕来源。`buildSources(doc, settings, site)` 返回按优先级排列的候选：手动选取 > 已知站点（YouTube/Netflix/Prime/哔哩哔哩）> TextTrack。每个候选有 `read()`：返回 `{text, lang, video, rolling}`。`leafText()` 把叶子节点的文字用空格拼起来（Netflix 两行是并排 span）；`pickVideo()` 选面积最大且在播放的 `<video>`；TextTrack 来源还提供 `upcoming()`（预翻译）与 `restore()`（把被我们改成 hidden 的轨道恢复） |
| `stabilizer.js` | 整句出现 90 ms 后触发翻译；增长中（新文本以旧文本开头 / 共享前缀 ≥ 60%，或来源标记 `rolling`）等 550 ms；相同文本不重复触发 |
| `translator.js` | `TranslateQueue`：缓存（上限 3000）+ 去重 + 批量合并；**live 与 bg 两个独立的在途名额**；bg 句子被当前播放用到时提升为 live；失败不缓存，bg 失败暂停 10 s |
| `controller.js` | 总控。`_lineInfo(text)` 决定这一句的 `{source, targets}`：用户指定则用之；自动时中文靠文字判断，其它优先用来源语言（轨道 srclang），再用逐句判断；自动模式下检测到已是目标语言的不翻译。空白 > 250 ms 才隐藏悬浮层；设置变化时只在必要时重建来源/清缓存 |
| `overlay.js` | Shadow DOM 悬浮层：stage 跟随视频矩形，box 用百分比定位（中心 x、底边 y）；`width:max-content` 使宽度不随位置变化；`mount()` 在 `fullscreenchange` 时挂到全屏元素；全部文本用 `textContent` |
| `picker.js` | 选取器：全屏透明盾 + `elementFromPoint`；`selectorFor()` 从点击元素向外最多 4 层找"稳定类名/id 且匹配 1–4 个元素"的选择器（类名只接受字母和连字符，排除 `css-xxx` 这类构建哈希） |
| `langs.js` | `detectLang`：CJK 占比 / 法英停用词与变音符号 / 法语省音（l' d' j'…）打分；平局返回 null |
| `settings.js` | 默认值 + `normalize()`（任何存储内容都能读成合法设置）+ `siteOf()`（iframe 里取最顶层页面主机名） |

**后台模块**：`engines.js`（`translateGtx`：每句一个请求、最多 4 并发；`translateBatch`：auto = llm → gtx，带降级说明 `note`）· `llm.js`（Anthropic 原生 `fetch` 非流式 + 逐级降级；其它走共享的 `askJsonOpenAI`；`probeKey` 识别并验证密钥）· `keys.js`（`chrome.storage.local` 的多服务商密钥，`selection()` 优先用快速模型）。

**消息协议**

| 消息 | 方向 | 内容 |
|---|---|---|
| `translate` | 内容 → 后台 | `{source, targets, items:[{i,t}], context, engine}` → `{ok, result:{provider, results:{lang:[{i,t}]}, note?}}` 或 `{ok:false, error:{code,message}}` |
| `status` | 内容 → 后台 | 写入 `storage.session['st:<tab>:<frame>']`；`on:false` 时删除 |
| `setEnabled` / `pick` / `pickCancel` / `ping` | 弹窗/后台 → 内容 | 开关、进入/退出选取模式、探活 |
| `pickDone` | 内容 → 后台 | 选取结束，后台通知同一标签页的其他框架退出选取模式 |

**构建与发布**：`npm run build:ext` → esbuild（IIFE，不压缩）打包 4 个入口到 `extension/dist/`，从服务商表生成 `manifest.json`（`host_permissions`），再用内置的最小 ZIP 写入器（固定时间戳，内容不变字节不变）打成 `public/downloads/lectureloop-subtitles.zip`；设置页提供下载。产物与 zip 都提交，**测试会检查它们没有过期**。

### 10.2 测试

| 层 | 内容 |
|---|---|
| `node:test`（`tests/ext.test.mjs`） | 语言判断；稳定器（假定时器）；队列（合并/去重/缓存/失败重试/bg 暂停/提升）；`translateGtx`；Anthropic 降级链；`translateLLM` 两条路径；`translateBatch` 降级与说明；`probeKey`；设置归一化；`siteOf`；密钥存取；`Controller._lineInfo`；**构建产物与 zip 是否最新**；manifest 引用的文件都存在 |
| Playwright（`tests/e2e/extension.cjs`） | 用 `launchPersistentContext` 加载未打包的扩展；本地测试页（`ext-server.cjs`：60 秒静音 WAV + 由字幕表生成的 WebVTT + 仿制的 YouTube / Netflix / 自定义字幕层）+ 模拟翻译服务（`mock-api.mjs`）。用 `--host-resolver-rules` 把 `www.youtube.com` / `www.netflix.com` 映射到本机，让站点适配真正匹配。覆盖：字幕轨道自动开启与预翻译、中文句不翻译、隐藏网站字幕与恢复、YouTube/Netflix 结构、弹窗开关与手动选取并记住、设置页保存密钥→选模型→测试→改用 AI、AI 失败降级、限流提示、悬浮层字号/拖动/刷新保持/关闭、全屏挂载、不支持的页面、删除密钥、**内容脚本读不到密钥** |
| **未覆盖** | 真实的 Netflix / YouTube / Prime / 哔哩哔哩（开发环境访问不了）；真实的非 Anthropic 服务商；Chrome 内置 Translator 的真实模型；Alt+T 快捷键（浏览器级，Playwright 无法触发） |

### 10.3 已知局限与设计取舍

- 只读已有字幕：没有字幕的视频不支持。DOM 字幕无法提前翻译，AI 引擎下译文晚 1–2 s；字幕轨道整条载入时可提前翻译 90 s。
- YouTube 自动字幕滚动增长，靠稳定器等待，译文会慢约半秒。
- 播放器把 `<video>` 元素本身设为全屏时，悬浮层没法挂入（浏览器规则）。
- 轮询（150 ms）换来对站点内部实现零依赖；代价是后台标签页里定时器被降频（看视频时标签页是前台，不受影响）。
- 站点选择器会随网站改版失效——这是"手动选取"和"字幕轨道"两条路存在的原因。

### 10.4 第二阶段（未做）：无字幕视频的音频识别

```
offscreen document：chrome.tabCapture.getMediaStreamId → getUserMedia(chromeMediaSource:'tab')
   → AudioWorklet 重采样 16 kHz PCM → 云 ASR（Deepgram / Azure，经用户自带密钥）或 Chrome 本机识别
   → 句子（复用 Web 应用的 UtteranceTracker）→ 现有的 TranslateQueue / Overlay
```

可直接复用：`utterance.js`（稳定前缀提交）、翻译队列、悬浮层、引擎降级。需新增：`TabCaptureSource`、ASR Provider、`tabCapture` 权限与 offscreen document。**在确认需求（PRD 开放问题 6）前不做。**

### 10.5 与 Web 应用的关系（第三阶段设想）

把插件里的句子"收进课程库"：插件向 Web 应用（同源页面）发消息，或导出 JSON 由 Web 应用导入，生成一个"看剧"课时（Cue 带 `start/end`，来自 TextTrack 时间）。需要先定数据格式；暂不做。

---

## 11. 测试与质量

| 层 | 工具 | 覆盖 |
|---|---|---|
| 领域 | `node:test` | 断句、合并/拆分、时间轴估算与锚点插值、docx 解析、纠错应用/撤销、diff、SRS、话语标记；**话语跟踪器**（丢字、时间校正、连续讲课提前提交、中文判定）；**片段编辑**（重命名/并入/拆分/不变量）；朗读语音分档；AI 任务（提示词/校验） |
| 服务端 | `node:test` + mock | 参数校验、JSON 解析、拒答/截断处理、翻译对齐校验 |
| E2E | Playwright | 导入 docx → Studio 播放/循环 → 标记 → 训练 → 演示课堂 → 归档；**后台录制**（页面隐藏/切页）；**悬浮字幕**（拖动/缩放/锁定/PiP）；**识别事件脚本**（伪造 `SpeechRecognition`，验证丢字与时间）；**连续讲课**（首句延迟、译文同步、归档文本一致）；**字幕回看**；**课程库编辑**（改名/换学期/移动/批量/片段拆分并入/刷新保持）；**插件**（见 §10.2） |
| 注意 | — | 测试里的失败有时是测试脚本问题（选择器过宽、未点同意弹窗、Playwright `bringToFront` 不会让页面变 hidden），先判断再改代码 |
| 手工清单 | 产品设计 §8 | — |

---

## 12. 安全与隐私

- **密钥只在服务端**：浏览器永不接触 `ANTHROPIC_API_KEY` / `GOOGLE_TRANSLATE_API_KEY`；服务默认只监听 `127.0.0.1`。
- **接口收敛**：前端只能调用固定任务端点，提示词在服务端，不提供"任意 prompt 透传"。
- **输入限制**：请求体上限 8 MB；`cues` 数量/字符数上限；简单速率限制。
- **XSS**：htm 默认转义文本；高亮用节点拼装而非 `innerHTML`。
- **隐私**：只向外发送文本；音频不出设备；设置页明示识别服务（Web Speech）可能由浏览器厂商处理语音。
- **自带密钥（在线版）**：多服务商密钥只存 `localStorage`，不进 IndexedDB、不进备份；只发往用户选的服务商；浏览器跨域被拦截时走同源 `/relay`——Origin 校验、**主机白名单**（`custom` 不在内，防止被当开放代理）、只转发必要请求头、不记录密钥；CSP `connect-src` 列出各服务商来源。
- **插件**：默认休眠；只有字幕文字外发；密钥在 `storage.local` 且 `TRUSTED_CONTEXTS`（内容脚本读取被拒绝，已有端到端测试）；悬浮层与选取器在 Shadow DOM 中，页面文本一律 `textContent`；权限最小（`storage` + 明列的 API 域名 + localhost）；`<all_urls>` 内容脚本是为了在任意视频站读字幕，已在说明文档中解释。

---

## 13. 迁移路径与里程碑

| 阶段 | 前端动作 |
|---|---|
| **MVP / v0.2（本仓库）** | Preact+htm 无构建；全部 P0 功能 + 后台录制、悬浮字幕、课程库编辑、多服务商密钥；`extension/` 字幕翻译插件（esbuild 打包，不压缩） |
| **V1** | Vite + React + TS；`lib/` 加类型；波形（Web Audio）；云 ASR Provider；Worker 化导入；Playwright CI |
| **V2** | 插件第二阶段（标签页音频识别，§10.4）与 Web 应用打通（§10.5）；账号与同步层（在 `db.js` 前加 Repository 抽象）；PWA 离线 |


---

## 14. 在线静态版（Cloudflare Pages）与"自带密钥"

| 关注点 | 做法 |
|---|---|
| 部署 | **Cloudflare Workers**（Git 集成，`main` 分支推送即部署；支持私有仓库、免费）：根目录 `wrangler.jsonc` 声明 `main: lectureloop/app/worker/index.js`（静态资源 + 只对 `/relay` 先执行的 Worker），部署命令 `npx wrangler deploy`，无构建步骤（站点名保持 `lt`）。插件 zip 作为静态资源 `downloads/lectureloop-subtitles.zip` 一并发布；`.github/workflows/test.yml` 只负责推送时跑单元测试 |
| 安全头 | `public/_headers`：CSP（`connect-src` 列出各服务商来源，由 `providers.js` 的 `cspOrigins()` 生成）、`Permissions-Policy: microphone=(self)` 等，与本地服务一致 |
| 子路径 | 所有静态资源与 API 均用**相对路径**（`css/app.css`、`js/main.js`、`api/config`），根路径或 `/LT/` 这类子路径都能部署 |
| 模式判断 | 启动时请求 `api/config`：返回带 `version` 的配置 = 本地版；404 或被托管平台回退成 `index.html`（Cloudflare 的 SPA 行为，状态 200）= 在线静态版（`config.server=false`） |
| AI 路由 | `lib/api.js`：本地服务端密钥 → 浏览器自带密钥（`lib/llm-client.js`，按"笔记/词汇"与"实时翻译"各自选中的服务商）→ 离线启发式 |
| 共享逻辑 | `lib/ai-tasks.js` 同时被 `server/ai.js` 与浏览器端引用：提示词、JSON Schema、结果校验（防幻觉、索引裁剪）两端完全一致 |
| SDK | 官方 `@anthropic-ai/sdk` 经 esbuild 打包为 `vendor/anthropic-sdk.mjs`（约 360KB），仅在使用浏览器密钥时动态加载；`dangerouslyAllowBrowser: true` 仅用于用户本人的密钥 |
| 密钥存储 | `lib/byok.js` → `localStorage`（多服务商结构，旧版单个 Claude 密钥自动迁移）；不进 IndexedDB、不进备份；设置页提供一个框自动识别 / 验证 / 选模型 / 测试 / 删除 |
| 同源中继 | `worker/relay.js`（Worker 与 Node 服务共用）：对 CORS 情况未知的服务商先直连，网络层失败再走 `/relay`；Origin 校验、主机白名单、只转发必要头 |
| 本地 CSP | `connect-src 'self' https://api.anthropic.com`，本地版也可使用浏览器密钥 |
| 一键运行 | `start-mac.command` / `start-windows.bat` / `start.sh`：检查 Node ≥ 20 → 首次 `npm install --omit=dev` → `node server.js --open`；端口被占用时若已是 LectureLoop 则直接打开（浏览器数据按端口隔离，避免"课程消失"） |
