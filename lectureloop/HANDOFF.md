# 交接说明（云端 → 本地继续）

> 给接手的 Claude Code（或人）：这是一份自包含的交接文档。云端会话用量耗尽，剩余工作请在本地完成。
> 先读 `lectureloop/README.md` 了解项目；本文件只写**当前进度、未完成事项和设计决定**。

## 0. 项目与部署

- 项目：LectureLoop（课堂回环）——留学生专业课听力辅助工具。Preact + htm 无构建前端，`app/server.js` 是可选的本地后端。文档在 `lectureloop/docs/`。
- 仓库：`aarynyan-cell/LT`。**`main` 会自动部署**到 Cloudflare：<https://lt.multape.workers.dev/>（`wrangler.jsonc` 只发布 `lectureloop/app/public`）。**不要把没测完的代码推到 `main`。**
- 本分支 `handoff/local` 包含 `main` 上已发布的内容 **+ 一次未合并的 WIP 提交**（后台录制 + 悬浮字幕）。完成后测试通过再合并到 `main`。
- 用户在 Mac 上使用 Chrome，中文沟通。用户已用真实 Claude 密钥验证“测试连接”成功。
- 云端没有真实的非 Anthropic 服务商密钥，所以下面第 2 项**没有真实验证**，务必在本地用真实密钥或至少用模拟服务验证。

## 1. 用户本轮提出的 4 个需求（原话）

1. “我想加一个后台录制（切到其他页面或选项录音不会停），以及悬浮字幕（单独的字幕块，可悬浮在桌面上，调整透明度和大小，类似一些音乐软件的桌面悬浮歌词）”
2. “密钥不限于 Claude，设置成可以填写其他中外常见的 api 密钥（一个框，自动识别）”
3. “训练的语音好吓人啊，你能用点自然的语音包吗？我现在使用 google 浏览器打开的，你看能不能用 google 自带的，或者预下载自然语音包。实在解决不了的话你就先把这个功能关了”

## 2. 完成情况

| 需求 | 状态 |
|---|---|
| 3 自然语音 | ✅ **已完成并已发布到 main**（`lib/voices.js`；单元测试 + 浏览器测试通过）。原因：旧代码取“第一个英语语音”，在 Mac 上会选到 Whisper/Zarvox 等搞怪语音。现在搞怪语音永不自动选中；自动模式只在有 Google/Premium/Enhanced/Natural/Siri 语音时朗读，否则静音计时；设置页可手动选并试听 |
| 1 后台录制 | 🟡 **代码已写，已部分验证，在本分支的 WIP 提交里**（见 §3） |
| 1 悬浮字幕 | 🟡 同上；页内悬浮块 + “弹出到桌面”（Document PiP）已用模拟窗口验证；真实 PiP 窗口未测 |
| 2 多服务商密钥 | ❌ **未开始**，设计已定（见 §4） |
| 文档更新 | ❌ README / PRD / 设计 / 前端方案 里还没有写后台录制、悬浮字幕、语音、多服务商 |

## 3. 后台录制 + 悬浮字幕（WIP，已写好）

**设计**：录音会话原来在 `views/live.js` 组件里，一切换页面组件卸载就会停止。现在搬到全局单例 `lib/live.js`（`live.start/pause/resume/mark/stop`、`useLive(selector)`）；页面只订阅状态。

- `lib/live.js`：控制器。含翻译队列、30 秒草稿、`beforeunload` 提示、Wake Lock（设置里“录音时保持屏幕常亮”）、页面不可见时翻译立即发送（后台定时器会降频）、录音期间 `document.title` 显示 `● mm:ss`。
- `lib/asr.js`：识别被浏览器结束时**立即重启**（不用 setTimeout；短时间反复失败才退回 1 秒定时重试）。
- `views/live.js`：改成纯展示层；导出 `RecTimer`、`finishLive()`（上课页和全局录音条共用）。
- `app.js`：非上课页顶部显示全局录音条（计时、没听懂、回到字幕、结束并归档）；侧栏“上课”显示红点；挂载 `<FloatingCaptions/>`。
- `components/floating.js`：页内悬浮块（拖动、缩放、背景透明度、字号、原文/译文开关、锁定=鼠标穿透、位置大小记入 `settings.float`）；`openPip()` 用 `documentPictureInPicture` 弹出桌面窗口（复制样式表，用 Preact `render` 渲染到 PiP 文档）。
- CSS 在 `css/app.css` 末尾（`.fc*`、`.recbar`）。

**已知限制（要如实告诉用户）**：
- **浏览器桌面窗口无法真正透明**（系统限制）。透明度滑块只对页内悬浮块生效；桌面（PiP）窗口只能调大小、字号、深/浅主题。若用户坚持“真透明桌面歌词”，需要做 Electron/Tauri 桌面壳，可作为后续方案提出。
- 录音依赖该浏览器标签页保持打开；关闭标签页会停止。

**验证情况**（脚本在 `app/tests/e2e/`）：
- ✅ 切换到课程库/Studio/设置，录音条保留、字幕继续增加；在其他页面点“没听懂”计入卡点；悬浮块跨页显示、拖动、字号、透明度。
- ✅ 修了一个 bug：拖动用的 `setPointerCapture` 会吞掉顶栏按钮的 click（见 `floating.js` 的 `down`）。修复后锁定/解除、“弹出到桌面”（用 `window.open` 模拟 PiP 窗口）、桌面窗口内改字号、关闭桌面窗口后恢复页内块都通过。
- ⚠️ **没有真正验证“后台标签页被隐藏”**：Playwright 的 `bringToFront` 不会让页面变成 `visibilityState=hidden`。请在真实 Chrome 里手测：开始录音 → 切到别的标签页 5 分钟以上 → 回来看字幕是否连续（Chrome 对后台标签有“强降频”，这是识别重启不用定时器的原因）。
- ⚠️ 真实麦克风 + 真实 Web Speech 没法在云端测，只测了演示课堂。

**待做**：1) `npm test` 与 `tests/e2e/*.cjs` 全跑一遍（先 `npm start`）；2) 手测真实麦克风与真实 PiP 窗口；3) 在 Live 页和设置页里把“悬浮字幕/后台录制”的说明补完整；4) 更新文档（§5）。

## 4. 多服务商密钥（未开始，设计已定）

**目标**：设置页一个输入框，粘贴任意常见服务商的密钥，自动识别服务商并验证；可保存多个，分别指定“笔记/词汇用哪个”“实时翻译用哪个”。用途限于文本任务（笔记、语言拆解、翻译）。

**现状**：`lib/byok.js` 只存一个 Claude 密钥（localStorage `lectureloop.claudeKey` 等，要做迁移）；`lib/claude-browser.js` 用浏览器版官方 SDK；`lib/api.js` 路由：本地服务端 → 浏览器密钥 → 离线；提示词/Schema/校验在共享的 `lib/ai-tasks.js`。

**方案**：
1. `lib/providers.js`（纯函数，可在 Node 测）：服务商注册表 + `detectProvider(key)` 返回按置信度排序的候选。
   - 格式：`sk-ant-`→Anthropic；`sk-or-`→OpenRouter；`xai-`→xAI；`gsk_`→Groq；`pplx-`→Perplexity；`AIza`+35 位→Google Gemini（同格式也可能是 Google Translate 的 key）；含 `T3BlbkFJ` 或 `sk-proj-` 等→OpenAI；`id.secret`（32 位十六进制+点）→智谱 GLM；UUID→火山方舟（豆包，模型名要用 `ep-` 接入点 ID，需用户填）；`sk-`+32 位十六进制→**DeepSeek 或 阿里百炼（通义）**，格式相同无法区分；`sk-`+约 48 位→Moonshot（Kimi）/ SiliconFlow / OpenAI，也无法仅凭格式区分。
   - **所以必须“探测”**：对每个候选调用其 `GET {base}/models`（Bearer），返回 200 的就是；401/403 排除；网络错误=可能是 CORS，再走中继。
2. `lib/llm-openai.js`（fetch，浏览器和 Node 通用）：OpenAI 兼容 `chat/completions`。OpenAI 与 Gemini（OpenAI 兼容端点）用 `response_format: json_schema`（`strict:true`，我们的 Schema 已满足 `additionalProperties:false`+全 required）；其它服务商用 `json_object` + 把 Schema 写进提示词；OpenAI 新模型用 `max_completion_tokens` 且不要传 `temperature`；DeepSeek 等输出上限较小（约 8K），被截断时抛 `max_tokens` 错误让界面降级到离线版；容错解析（去掉 ```json 围栏）；拒答/`content_filter` 映射为 `refusal`。
3. 模型选择：**不要硬编码模型名**（容易过时）。探测时拿到 `/models` 列表，用正则偏好挑默认（主模型偏旗舰、快速模型偏 mini/flash/turbo/haiku），设置页给下拉并允许手填；预设后备：DeepSeek `deepseek-chat`、智谱 `glm-4-flash`（免费，适合翻译）、百炼 `qwen-plus`/`qwen-turbo`、Groq `llama-3.3-70b-versatile` 等，均需用户确认。
4. `sanitizeNotes/sanitizeLanguage`（`ai-tasks.js`）要同时接受 snake_case 与 camelCase 字段（`key_points/keyPoints`、`start_cue/startCue`、`heard_as/heardAs`），因为非 Anthropic 服务商的 `json_object` 模式不保证字段名；缺必需顶层字段时抛 `bad_json` 让界面降级。
5. 存储：`lectureloop.keys` = `{ [providerId]: { key, model, fastModel, base? } }` + `lectureloop.use` = `{ main, fast }`；迁移旧的 `lectureloop.claudeKey/Model/FastModel`。密钥仍只在 localStorage，不进备份。
6. 设置页 UI：一个密码框 → 防抖识别 → 显示“识别为：DeepSeek（高）/ 可能是：DeepSeek 或 通义千问（保存时逐个验证）” → 保存 = 探测 → 成功显示可用模型并保存。下方列出已保存的服务商，每行有“用于笔记/词汇”“用于实时翻译”两个单选 + 删除。高级折叠：手动指定服务商、自定义 Base URL（OpenAI 兼容，如本地 Ollama，**仅直连，不走中继**）、手填模型。
7. **CORS 与中继**：OpenAI/Anthropic/Gemini/Groq/OpenRouter 浏览器直连基本可用；DeepSeek/Moonshot/智谱/百炼/火山/xAI 等**是否允许浏览器跨域我没有验证**。方案：同源中继 `POST /relay`，请求体 `{url, method, headers, body}`，只允许白名单主机（从 `providers.js` 导出）、仅 https、校验 `Origin` 等于本站、不记录密钥、响应透传。中继逻辑写成只用 Web 标准 API 的 `handleRelay(request): Promise<Response>`（`worker/relay.js`），**同时**被 Cloudflare Worker（`wrangler.jsonc` 增加 `"main": "worker/relay.js"`、`"assets": {"directory": ..., "binding": "ASSETS", "run_worker_first": ["/relay"]}`，非 `/relay` 请求走 `env.ASSETS.fetch`）和 `app/server.js`（本地版，Node 22 的 Request/Response 转换）使用。客户端策略：已知支持 CORS 的直连；未知的先直连，失败（TypeError）再走中继；中继不可用（探测 `GET /relay`）就提示“该服务商需要本地版或中继”。改 `wrangler.jsonc` 前务必 `npx wrangler deploy --dry-run` 并用 `wrangler dev` 本地测，因为它会影响线上部署。
8. 如实标注：除 Anthropic 外的服务商在云端**没有用真实密钥验证**，设置页对它们标“实验性”。测试用 `tools/mock-api.mjs` 扩展一个 OpenAI 兼容的模拟接口（`/v1/models`、`/v1/chat/completions`），覆盖：识别→探测→保存→生成笔记/翻译→降级。

## 5. 收尾清单

- 文档：`README.md`（三种用法之外，加“后台录制与悬浮字幕”“朗读语音”“多服务商密钥”）；`docs/01-PRD.md`（FR-1.x 增加后台录制/悬浮字幕；§9.3 说明多服务商；风险里加“浏览器无法透明桌面窗口”）；`docs/02-product-design.md`（Live 流程：录音在后台继续；悬浮字幕线框与交互）；`docs/03-frontend-plan.md`（live 控制器、floating、voices、providers、relay）。
- 测试：`app/tests/domain.test.mjs` 已有 24 个；给 `providers.js`、`llm-openai.js`（用模拟服务）、`handleRelay`（白名单/Origin 校验）补单元测试。
- 部署：测试全绿后再合并到 `main`；推送后到 <https://lt.multape.workers.dev/> 手测（在线版没有后端，设置页应识别为在线版）。
- 不要提交密钥；`.env` 已在 `.gitignore`。

## 6. 常用命令

```bash
cd lectureloop/app && npm install && npm test        # 单元测试（SAMPLES_DIR=含 docx 的目录 可加跑真实样本）
npm start                                             # http://127.0.0.1:8787
npm run dev:mock                                      # 用模拟的 Claude/Google 接口联调，无需密钥
node tests/e2e/background-recording.cjs               # 需 npm i -D playwright && npx playwright install chromium
```
