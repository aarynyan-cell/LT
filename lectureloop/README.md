# LectureLoop · 课堂回环

> 把每一堂外语专业课，变成可以反复精听的专业听力教材——**课上听懂，课后听会**。

面向留学生的课程听力辅助工具（Web 版），外加一个**Chrome 字幕翻译插件**（看剧 / 看网页视频时实时翻译字幕）。与普通实时字幕工具最大的不同：**实时字幕只是入口，核心是把课堂内容长期沉淀为精听素材，并把"没听懂的地方"变成定向训练**。支持英语 / 法语 / 中文。

| 文档 | 内容 |
|---|---|
| [docs/01-PRD.md](docs/01-PRD.md) | 产品需求：背景、真实样本研究、用户、目标与指标、用户故事、功能/非功能需求、优先级、ASR/翻译/Claude 选型与成本 |
| [docs/02-product-design.md](docs/02-product-design.md) | 产品设计：信息架构、核心流程、页面原型、交互细则、视觉规范 |
| [docs/03-frontend-plan.md](docs/03-frontend-plan.md) | 前端技术方案：选型对比、分层架构、目录、路由、数据模型、关键模块、插件演进 |
| [extension/README.md](extension/README.md) | Chrome 字幕翻译插件：安装、使用、隐私与局限 |
| [app/](app/) | 可运行的 Web 应用代码 |

![Studio：转录 + 笔记 + 时间轴](docs/screenshots/studio.jpg)

---

## 三种用法

| 用法 | 适合 | 怎么开始 |
|---|---|---|
| **在线版** | 直接打开、手机也能用 | 部署到 Cloudflare（免费，源码仓库可保持私有，见下文）后打开 `https://lt.<你的子域>.workers.dev` |
| **本地一键运行** | 日常使用，可在服务端配置密钥 | 双击 `start-mac.command`（Windows：`start-windows.bat`） |
| **开发** | 改代码、调试 | `npm install && npm start` |

两种版本功能相同。**数据都只保存在你自己的浏览器里**（按网址区分：在线版和本地版的课程互不相通，可用“设置 → 导出/导入备份”搬运）。

### 在线版（Cloudflare Workers & Pages，免费，仓库可保持私有）

在线版是纯静态网页，没有后端：实时字幕、导入、精听、卡点训练、离线笔记都能直接用；要用 Claude 生成笔记、词汇和实时翻译，在 **设置 → API 密钥** 里粘贴你**自己的**密钥即可（只保存在当前浏览器，由浏览器直接发送到对应服务商，不进备份文件）。

首次部署（只需一次，约 5 分钟）：

1. 注册 / 登录 [Cloudflare](https://dash.cloudflare.com/)，进入 **Workers & Pages → Create application**，选择从 GitHub 导入仓库（授权时选 **Only select repositories**，只勾选这个仓库；私有仓库也可以）。
2. 项目名填 **`lt`**（需与仓库根目录 `wrangler.jsonc` 里的 `name` 一致；想用别的名字就同时改这个文件）。
3. 构建设置保持默认即可：Build command 留空，**Deploy command** 为 `npx wrangler deploy`，Root directory 为 `/`。仓库里的 `wrangler.jsonc` 已指定只发布 `lectureloop/app/public`。
4. 部署完成后得到 `https://lt.<你的子域>.workers.dev`。之后每次推送到 `main` 都会自动更新。

（如果你创建的是旧式 **Pages** 项目：Framework preset 选 `None`，Build command 留空，Build output directory 填 `lectureloop/app/public`，效果相同。）

说明：网页的前端代码（`public/` 里的 JS/CSS）任何访问者都能在浏览器里看到，这是所有网站的共性；私有仓库保护的是文档、服务端代码、测试和提交历史。安全响应头（CSP、只允许本站使用麦克风）由 `public/_headers` 提供。仓库推送时 GitHub Actions 只跑单元测试，不负责部署。

### 本地一键运行

需要安装 [Node.js](https://nodejs.org/zh-cn/download) 20 或更新版本，推荐桌面版 Chrome / Edge（实时识别依赖浏览器的 Web Speech API）。

- **macOS**：在访达里双击 `lectureloop/start-mac.command`。首次如果提示“无法打开”，请**右键 → 打开**。
- **Windows**：双击 `lectureloop\start-windows.bat`。
- **Linux**：运行 `lectureloop/start.sh`。

首次运行会自动安装依赖，然后启动服务并打开浏览器（<http://127.0.0.1:8787>）。关闭那个窗口即可停止；重复双击会直接打开已在运行的页面。首次打开会自动加载两门**示例课程**（取自真实课堂转录的短摘录，保留了真实的 ASR 错误），没有麦克风时可用“上课 → 演示课堂”体验。

### 在本地服务里配置密钥（可选）

本地版也可以在网页“设置”里填自己的密钥；如果想让密钥只放在服务端，在 `lectureloop/app/` 下：

```bash
cp .env.example .env
```

填写 `ANTHROPIC_API_KEY`（以及可选的 `GOOGLE_TRANSLATE_API_KEY`），重新启动即可。都不填也能用：笔记、词汇会使用**离线版**（界面会明确标注）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude 密钥（只保存在服务端，浏览器拿不到） |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 笔记归纳、语言拆解使用的模型 |
| `CLAUDE_MODEL_FAST` | 同 `CLAUDE_MODEL` | 实时翻译（无 Google 时）使用的模型。**建议设为 `claude-haiku-5-5`**：更快，成本约为 Google 翻译的 1/70（见 PRD §9.3） |
| `CLAUDE_SERVER_FALLBACK` | 开启 | 已默认启用服务端 `fallbacks: "default"`：安全分类器误拒时由 API 自动换模型重试（Haiku 不支持，会自动不带）。设为 `off` 可关闭 |
| `GOOGLE_TRANSLATE_API_KEY` | — | Google Cloud Translation（Basic v2）。配置后实时翻译优先使用它 |
| `TRANSLATE_PROVIDER` | `auto` | `auto` / `google` / `claude` |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 默认只监听本机，避免他人通过局域网使用你的密钥 |

AI 的选择顺序：本地服务端密钥 → 浏览器里填写的密钥 → 离线版。浏览器密钥模式同样默认启用 `fallbacks: "default"`，模型可在设置页选择。

### 开发与测试

```bash
cd lectureloop/app
```

```bash
npm install
```

```bash
npm run dev:mock
```

`dev:mock` 用本地**模拟的** Claude 与 Google 接口启动（输出为占位内容），用于无密钥联调。`npm test` 运行领域层与插件的单元测试（含“插件构建产物没过期”检查）；改了 `extension/src` 后运行 `npm run build:ext` 重新打包（产物与下载用的 zip 都已提交）；`node tests/e2e/*.cjs` 是 Playwright 端到端测试（需 `playwright` 与 chromium；插件的那个会在真实 Chromium 里加载未打包的扩展）；设置 `SAMPLES_DIR=<存放 docx 的目录>` 可额外用你的真实转录跑一遍。升级 `@anthropic-ai/sdk` 后运行 `npm run build:sdk` 重新生成浏览器用的 SDK 打包文件（`public/vendor/anthropic-sdk.mjs`，已提交，平时无需构建）。

---

## 功能一览（MVP）

| 模块 | 你能做什么 | 位置 |
|---|---|---|
| **实时听课** | Web Speech 实时字幕 + 0–2 种译文（英/法/中互译）；同步录音，句子带真实时间戳；**整堂字幕可上滑回看**；老师**持续讲话不停顿**时稳定的前半句会提前出现并立即翻译；**原文淡出**（按住 H 才显示）；按 `Space` 一键标"没听懂"（最近约 15 秒）；结束即归档；30 秒自动存草稿 | 上课 |
| **课程素材库** | 学期 › 课程 › 课时 › 片段（Part）；**课程改名/换学期、课时改名/移动/批量移动、片段重命名/并入/拆分**（各处的 ✎）；导入 `.docx`（语音备忘录导出）/ `.txt` / `.srt` / `.vtt` + 可选录音；从文件名识别日期与课程；跨课程全文搜索并直达那一句 | 课程库 |
| **笔记归纳** | 摘要笔记 / 原文对照 / 我的笔记三视图；Claude 生成概览、Part 摘要、要点、概念、公式（含口述）、老师强调、待问问题，**每条都能 ▶ 回听原话**；导出 Markdown | 课时 › 笔记 |
| **精听素材** | 录音 / 朗读 / 静音计时三种播放引擎；0.5×–2× 变速不变调；A-B 循环、逐句重复 N 遍；时间轴显示 Part、卡点、片段、语速密度，**拖拽框选**即可标卡点或存为带标签的片段 | 课时 › 播放条 |
| **语言拆解** | 专业词汇（三语释义 + 例句回听 + "常被听成"）、讲者句式（定义/强调/对比/因果…）及扩展例句；导出 Anki（TSV） | 课时 › 语言、词汇 |
| **听力陷阱** | 把 ASR 听错的术语（如 `dog product → dot product`）列出来逐条确认；采纳后改写全文、保留原文、可撤销；**一键加入训练** | 课时 › 语言 › 听力陷阱 |
| **卡点训练** | 到期队列：① 盲听（循环 + 降速）→ ② 听写（词级对比）→ ③ 揭示（原文/译文/陷阱/前后文）→ ④ 自评；Leitner 间隔重复 | 训练 |
| **后台录制 + 悬浮字幕** | 录音在切换页面 / 标签页时不会中断（顶部有录音条，可随时标“没听懂”）；字幕可做成可拖动、可缩放、可调背景透明度的悬浮块，也能“弹出到桌面”（Chrome / Edge 的画中画窗口，浮在其他软件之上；浏览器窗口无法真正透明，桌面窗口只能调大小、字号、深浅） | 上课 |
| **朗读语音** | 没有录音时用朗读代替：自动避开 Whisper / Zarvox 等搞怪语音，只在有 Google / Premium 等自然语音时朗读，否则静音计时；设置页可手动选并试听 | 设置 |
| **多服务商 API 密钥（实验性）** | 一个输入框粘贴密钥，按格式自动识别并验证服务商（Claude、OpenAI、Gemini、DeepSeek、Kimi、智谱、通义、豆包、硅基流动、OpenRouter、Groq、xAI、自定义 OpenAI 兼容地址）；可保存多个并分别指定“笔记/词汇”和“实时翻译”。**除 Claude 外尚未用真实密钥验证**；个别服务商不允许浏览器直连时，会经同源中继（`/relay`）转发 | 设置 |
| **Chrome 字幕翻译插件** | 看网页视频时读取**已有的字幕**并实时翻译，法 / 英 / 中互译；悬浮在视频上（全屏也能看），可拖动、调字号；自动识别 YouTube / Netflix 等站点和标准字幕轨道，识别不了就“点一下字幕”手动选取；不填密钥也能用（免费 Google 翻译），填 AI 密钥更贴合语气，失败自动降级。**没有字幕的视频不支持**；真实站点未验证（见 [插件说明](extension/README.md)） | 设置 › 下载插件 |
| **识别日志** | 字幕丢句或时间对不上时，导出识别引擎的事件日志用于排查（只含文字与时间） | 设置 › 数据 |

快捷键在任意页面按 `?` 查看。Studio 常用：`Space` 播放、`← →` 换句、`L` 循环当前句、`[ ]` 变速、`M` 标卡点、`H` 盲听。

| 上课：实时字幕 + 中/法双译文 + 一键"没听懂" | 卡点训练：听写对比 → 揭示 → 自评 |
|---|---|
| ![上课](docs/screenshots/live.jpg) | ![卡点训练](docs/screenshots/drill.jpg) |

## 用你自己的语音备忘录转录

1. 课程库 → 导入 → 选择 `.docx`。文件名或首行（如 `1008-bioinfo & omics_ Porte d'Issy 5`）会自动识别为 课程 `bioinfo & omics`、日期 `10-08`。
2. 语音备忘录导出的转录**没有时间戳**，时间轴先按语速估算（页头显示"⚠ 估算时间轴"）。
3. 在课时页点这个徽标 → **绑定录音**；播放到某句时悬停该句点 **⚓**，把"当前播放位置"设为这句的起点。每 10–15 分钟加一个锚点即可，锚点之间按词数自动插值。
4. 点"课后整理"的三个按钮：确认术语纠错 → 生成笔记 → 提取词汇与句式。

## 目录结构

```
wrangler.jsonc                       Cloudflare 部署配置：只发布 lectureloop/app/public（静态资源）
.github/workflows/test.yml           推送 / PR 时跑单元测试（在线版由 Cloudflare 直接从仓库部署）
lectureloop/
├─ start-mac.command / start-windows.bat / start.sh   一键启动
├─ docs/                 PRD / 产品设计 / 前端方案 / 截图
├─ extension/            Chrome 字幕翻译插件（src/ 源码 · dist/ 打包产物 · popup/ options/ · README.md）
└─ app/
   ├─ server.js          静态托管 + /api/config /api/translate /api/ai/notes /api/ai/language（--open 自动打开浏览器）
   ├─ server/            claude.js（官方 SDK：结构化输出 + 流式 + 拒答处理）· ai.js · translate.js · env.js
   ├─ worker/            Cloudflare Worker：静态资源 + /relay 同源中继
   ├─ tools/             mock-api.mjs、dev-mock.mjs（无密钥联调）· build-sdk.mjs（打包浏览器版 SDK）· build-ext.mjs（打包插件 + 生成 zip）
   ├─ tests/             domain.test.mjs · ext.test.mjs（node:test）· e2e/*.cjs（Playwright）
   └─ public/            无构建前端：Preact + htm（vendored，离线可用）；_headers 为在线版安全响应头
      ├─ vendor/         htm-preact.js · anthropic-sdk.mjs（官方 SDK 浏览器打包，按需加载）
      └─ js/  lib/（领域逻辑，可在 Node 测试；ai-tasks.js 为服务端与浏览器共用的提示词/Schema/校验）· components/ · views/ · store.js · db.js
```

## 隐私与合规

- 录音、转录、卡点**只保存在本机浏览器**（IndexedDB）。调用 Claude / 翻译时只发送**文本**，从不发送音频。
- 本地版的密钥只在服务端；在线版用户自带的密钥只存在本人浏览器（localStorage），只发往你选的服务商（个别服务商经同源中继），不进备份文件。
- Chrome 插件默认休眠，只在你开启的标签页/网站读取字幕；只有字幕文字发给翻译服务；密钥存在插件自己的存储里，网页读不到。
- 浏览器的实时识别（Web Speech）可能由浏览器厂商的云服务处理语音；需要完全本地时请改用"导入转录"。
- 开始课堂录音前，请确认已获得授课教师 / 学校的许可（首次录音时应用会要求确认）。

## 已知限制（诚实清单）

- **真实 Claude 的验证范围**：在线版浏览器直连真实 Claude 已实测成功（设置页“测试连接”，即实时翻译这条路径）。服务端与浏览器两条路径的请求形状（流式、`output_config` 结构化输出、`fallbacks` beta 头、拒答处理）都已用本地模拟接口端到端验证；笔记归纳、语言拆解这类长输出任务在真实课堂内容上的质量，还需要实际使用来检验。
- Web Speech 对专业术语和口音的识别有限，且没有词级时间戳；这正是"听力陷阱 + 课程术语表"要弥补的。V1 计划接入云端流式 ASR，以及课后用 Whisper 类服务重转写拿到真实时间戳。
- 估算时间轴需要录音 + 锚点校准才精准；没有录音时"朗读 / 静音计时"引擎只用于对照阅读与演示，不是真实课堂声音。
- 浏览器内置翻译（Chrome Translator API）作为最后一级降级，属实验性。
- Firefox 不支持实时识别（可以导入与练习）；暂无真实波形、多端同步。
- **字幕翻译插件**：只读已有字幕（没有字幕的视频需要音频识别，尚未做）；没有在真实的 Netflix / YouTube / Prime / 哔哩哔哩上验证过（开发环境访问不了），只在照它们页面结构仿制的测试页上通过；Chrome 内置翻译与非 Anthropic 的 AI 服务商也没有真实验证。
- **多服务商密钥**除 Anthropic 外未用真实密钥验证；**同源中继**未真正请求过；**悬浮字幕“弹出到桌面”的真实 PiP 窗口、后台标签页被隐藏时的真实录音**只用模拟环境测过。

---

<sub>本项目的 PRD 基于产品负责人提供的两份真实课堂转录做了定量分析：约 2.9 万词、无时间戳；术语级 ASR 错误集中在核心概念上（例如 Gini 一词至少有 7 种误听写法）。</sub>
