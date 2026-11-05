# LectureLoop 前端技术方案

| 项目 | 内容 |
|---|---|
| 版本 | v0.1，对应 [PRD](./01-PRD.md) 与 [产品设计](./02-product-design.md) |
| 现状 | `app/` 目录为按本方案实现的 MVP，可 `npm start` 本地运行 |
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
   ├─ package.json                依赖仅 @anthropic-ai/sdk；scripts: start / dev / test / mock
   ├─ server.js                   入口：静态托管 + API 路由
   ├─ server/
   │  ├─ env.js                   轻量 .env 加载
   │  ├─ claude.js                SDK 封装：结构化输出/流式/拒答/降级
   │  ├─ ai.js                    notes / language 任务：提示词 + JSON Schema + 校验
   │  └─ translate.js             Provider 链：Google → Claude
   ├─ tools/mock-api.mjs          本地模拟 Claude + Google（无密钥开发）
   ├─ tests/                      domain.test.mjs（node:test）、e2e.mjs（Playwright，可选）
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
         │  ├─ asr.js             Web Speech + MediaRecorder + 演示课堂
         │  ├─ api.js             后端客户端（含浏览器内置 Translator 降级）
         │  └─ seed.js            示例课程
         ├─ components/           ui.js timeline.js transcript.js playerbar.js importer.js
         └─ views/                home live library course lesson notes language clips drill vocab settings
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

### 7.4 Live 管线

```
getUserMedia ─┬─▶ MediaRecorder（dataavailable 每 5s 累积 chunks）   t0 = recorder.start 时刻
              └─▶ SpeechRecognition(lang, continuous, interim)
                     │ onresult: interim → 更新舞台；final → 生成 Cue
                     ▼
        Cue{ start = max(0, utterStartMs - t0), end = nowMs - t0 }   // utterStart = 本句第一次 interim 的时间
                     ▼
        translateQueue（debounce 800ms 批量，带前 3 句上下文）→ cue.tr[lang] 异步回填
  onend（浏览器自动停止）→ 若会话仍在进行则 300ms 后重启
  stuck(Space)  → clip{ start = cues[-2].start, end = now, kind:'stuck', source:'live' }
  stop → 组装 Lesson（真实时间轴）+ Blob + clips，自动分 Part，写库
```

- **演示课堂**：`DemoSource` 以 `setInterval` 逐词吐出示例 Cue（模拟 interim → final），与真实源共用同一管线，便于测试。
- 草稿每 30 秒写入 `kv:liveDraft`（cues + clips，不含音频块则只保存文本）。

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
| 译文 | Google | Claude | 浏览器内置 Translator → 不翻译 |
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

---

## 10. 浏览器插件演进（V2）

```
Manifest V3 (WXT)
├─ side_panel         复用本应用 UI（同一 bundle，路由改为 memory/hash）
├─ offscreen document 持有 MediaStream：chrome.tabCapture.getMediaStreamId → 捕获标签页音频
│                     → AudioWorklet 重采样 16k PCM → WebSocket → 云 ASR（经后端签发临时凭证）
├─ content script     在会议/录播页面叠加字幕条（可选）；监听 <video> 时间
├─ service worker     消息路由、alarms（SRS 到期通知）
└─ storage            IndexedDB 在插件源下独立；提供与 Web 版互导 JSON
```

可直接复用：`lib/domain/*`、`store`、`db`、全部视图。需新增：`AsrProvider` 云实现、`TabCaptureSource`、消息通道。

---

## 11. 测试与质量

| 层 | 工具 | 覆盖 |
|---|---|---|
| 领域 | `node:test` | 断句、合并/拆分、时间轴估算与锚点插值、docx 解析、纠错应用/撤销、diff、SRS、话语标记 |
| 服务端 | `node:test` + mock | 参数校验、JSON 解析、拒答/截断处理、翻译对齐校验 |
| E2E | Playwright | 导入 docx → Studio 播放/循环 → 标记 → 训练 → 演示课堂 → 归档 |
| 手工清单 | 产品设计 §8 | — |

---

## 12. 安全与隐私

- **密钥只在服务端**：浏览器永不接触 `ANTHROPIC_API_KEY` / `GOOGLE_TRANSLATE_API_KEY`；服务默认只监听 `127.0.0.1`。
- **接口收敛**：前端只能调用固定任务端点，提示词在服务端，不提供"任意 prompt 透传"。
- **输入限制**：请求体上限 8 MB；`cues` 数量/字符数上限；简单速率限制。
- **XSS**：htm 默认转义文本；高亮用节点拼装而非 `innerHTML`。
- **隐私**：只向外发送文本；音频不出设备；设置页明示识别服务（Web Speech）可能由浏览器厂商处理语音。

---

## 13. 迁移路径与里程碑

| 阶段 | 前端动作 |
|---|---|
| **MVP（本仓库）** | Preact+htm 无构建；全部 P0 功能 |
| **V1** | Vite + React + TS；`lib/` 加类型；波形（Web Audio）；云 ASR Provider；Worker 化导入；Playwright CI |
| **V2** | WXT 插件；账号与同步层（在 `db.js` 前加 Repository 抽象）；PWA 离线 |


---

## 14. 在线静态版（Cloudflare Pages）与"自带密钥"

| 关注点 | 做法 |
|---|---|
| 部署 | Cloudflare Workers & Pages 的 Git 集成（支持私有仓库、免费）：根目录 `wrangler.jsonc` 声明纯静态资源目录 `lectureloop/app/public`，部署命令 `npx wrangler deploy`，无构建步骤（旧式 Pages 项目则填输出目录）；`.github/workflows/test.yml` 只负责推送时跑单元测试 |
| 安全头 | `public/_headers`：CSP（`connect-src 'self' https://api.anthropic.com`）、`Permissions-Policy: microphone=(self)` 等，与本地服务一致 |
| 子路径 | 所有静态资源与 API 均用**相对路径**（`css/app.css`、`js/main.js`、`api/config`），根路径或 `/LT/` 这类子路径都能部署 |
| 模式判断 | 启动时请求 `api/config`：返回带 `version` 的配置 = 本地版；404 或被托管平台回退成 `index.html`（Cloudflare 的 SPA 行为，状态 200）= 在线静态版（`config.server=false`） |
| AI 路由 | `lib/api.js`：本地服务端密钥 → 浏览器自带密钥（`lib/claude-browser.js`）→ 离线启发式 |
| 共享逻辑 | `lib/ai-tasks.js` 同时被 `server/ai.js` 与浏览器端引用：提示词、JSON Schema、结果校验（防幻觉、索引裁剪）两端完全一致 |
| SDK | 官方 `@anthropic-ai/sdk` 经 esbuild 打包为 `vendor/anthropic-sdk.mjs`（约 360KB），仅在使用浏览器密钥时动态加载；`dangerouslyAllowBrowser: true` 仅用于用户本人的密钥 |
| 密钥存储 | `lib/byok.js` → `localStorage`；不进 IndexedDB、不进备份；设置页提供保存 / 测试连接 / 清除 |
| 本地 CSP | `connect-src 'self' https://api.anthropic.com`，本地版也可使用浏览器密钥 |
| 一键运行 | `start-mac.command` / `start-windows.bat` / `start.sh`：检查 Node ≥ 20 → 首次 `npm install --omit=dev` → `node server.js --open`；端口被占用时若已是 LectureLoop 则直接打开（浏览器数据按端口隔离，避免"课程消失"） |
