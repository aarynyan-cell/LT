import { html, useRef, useState, useEffect } from '../h.js';
import { useStore, actions, toast } from '../store.js';
import { download } from '../lib/util.js';
import { asrSupported, micSupported } from '../lib/asr.js';
import { LANGS } from '../components/ui.js';
import { byok } from '../lib/byok.js';
import { PROVIDERS, detectProvider, maskKey } from '../lib/providers.js';
import { aiSource } from '../lib/api.js';
import { listForLang, pickVoice, TIER_LABEL, SAMPLE } from '../lib/voices.js';

const TIER_ICON = { great: '★★', good: '★', ok: '', poor: '⚠', bad: '✕' };

/** 朗读语音：自动排除搞怪语音；默认只在有"推荐"语音时才朗读；可手动选择并试听 */
function VoiceCard({ settings }) {
  const [voices, setVoices] = useState(() => ('speechSynthesis' in self ? speechSynthesis.getVoices() : []));
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (!('speechSynthesis' in self)) return;
    const f = () => setVoices(speechSynthesis.getVoices());
    f();
    speechSynthesis.addEventListener('voiceschanged', f);
    return () => { speechSynthesis.removeEventListener('voiceschanged', f); speechSynthesis.cancel(); };
  }, []);
  const mode = settings.ttsMode || 'auto';
  const preview = (lang, voiceRaw) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(SAMPLE[lang]);
    u.voice = voiceRaw; u.lang = voiceRaw.lang; u.rate = 0.95;
    speechSynthesis.speak(u);
  };
  const setVoice = (lang, uri) => actions.setSetting('ttsVoices', { ...settings.ttsVoices, [lang]: uri });
  const rows = [['en', 'English'], ['fr', 'Français'], ['zh', '中文']].map(([lang, label]) => {
    const list = listForLang(voices, lang);
    const shown = showAll ? list : list.filter((v) => v.tier !== 'bad');
    const pick = pickVoice(voices, lang, { mode, voice: settings.ttsVoices?.[lang] });
    const chosen = list.find((v) => v.raw === pick.voice);
    return { lang, label, list, shown, pick, chosen };
  });
  const REASON = { good: '自动选择推荐语音', chosen: '使用你选的语音', forced: '已强制使用最好的一个', 'not-natural': '没有自然语音，自动模式下不朗读（改用静音计时）', 'only-bad': '只有搞怪语音，不朗读', none: '没有该语言的语音', off: '已关闭' };

  return html`<div class="card"><h2>朗读语音 <span class="muted small">（没有录音时，用朗读代替课堂声音）</span></h2>
    ${!('speechSynthesis' in self) ? html`<p class="small muted">此浏览器不支持朗读。没有录音时会使用静音计时。</p>` : html`
    <div class="field"><label>模式</label>
      <select value=${mode} onChange=${(e) => actions.setSetting('ttsMode', e.target.value)}>
        <option value="auto">自动（只在有自然语音时朗读，推荐）</option>
        <option value="on">始终朗读（用当前最好的语音）</option>
        <option value="off">关闭朗读（静音计时）</option>
      </select></div>
    ${rows.map(({ lang, label, shown, pick, chosen }) => html`<div class="field" key=${lang}>
      <label>${label} <span class="tiny">· ${REASON[pick.reason] || ''}${chosen ? `：${chosen.name}` : ''}</span></label>
      ${shown.length ? html`<div class="row"><select class="grow" value=${settings.ttsVoices?.[lang] || ''} onChange=${(e) => setVoice(lang, e.target.value)}>
          <option value="">自动选择</option>
          ${shown.map((v) => html`<option value=${v.uri}>${TIER_ICON[v.tier] ? TIER_ICON[v.tier] + ' ' : ''}${v.name}（${v.lang}${v.local ? '' : '，在线'}）· ${TIER_LABEL[v.tier]}</option>`)}
        </select>
        <button class="btn sm" disabled=${!(chosen || shown[0])} onClick=${() => preview(lang, (chosen || shown[0]).raw)}>▶ 试听</button></div>`
        : html`<div class="small muted">浏览器没有提供${label}语音</div>`}
    </div>`)}
    <label class="row small"><input type="checkbox" checked=${showAll} onChange=${(e) => setShowAll(e.target.checked)} /> 同时显示“搞怪/不推荐”的语音（Whisper、Zarvox 等）</label>
    <details style="margin-top:10px"><summary class="small">想要更自然的声音？</summary>
      <div class="small" style="margin-top:6px;line-height:1.7">
        <b>Chrome 自带的 Google 语音</b>：名字以 “Google” 开头（如 Google US English、Google français），在线、免费，自动被标为“推荐”。没出现的话先联网并刷新页面。<br/>
        <b>macOS</b>：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音…，下载带 <b>Premium / Enhanced（高品质）</b> 的语音，例如英语 Ava (Premium)、Zoe (Premium)、Daniel (Enhanced)，法语 Amélie (Enhanced)，中文 Tingting / Lili (Enhanced)。下载完<b>完全退出并重新打开 Chrome</b>，这里就会出现，并自动被识别为“最佳”。<br/>
        <b>Windows</b>：Chrome 只能用系统里的传统语音和 Google 在线语音；“自然”语音只有 Edge 能用，可以改用 Edge 打开。<br/>
        <b>最自然的方案</b>仍然是为这节课绑定<b>真实录音</b>——朗读只是没有录音时的替代。
      </div></details>`}
  </div>`;
}

const CONF = { high: '把握较大', medium: '可能', low: '不确定' };

/** API 密钥：一个输入框，按格式自动识别服务商，并向服务商发一次请求验证；可保存多个，分别指定“笔记/词汇”和“实时翻译”用哪个 */
function ByokCard({ config }) {
  const [key, setKey] = useState('');
  const [forced, setForced] = useState('');      // 高级：手动指定服务商
  const [base, setBase] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);          // { ok, text }
  const [test, setTest] = useState({});          // { [id]: { busy, ok, text } }
  const [, bump] = useState(0);
  const refresh = () => { bump((n) => n + 1); actions.touchConfig(); };

  const cands = forced ? [{ id: forced, confidence: 'high' }] : detectProvider(key);
  const saved = byok.all();
  const use = byok.use();
  const need = forced && PROVIDERS[forced];

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const { probeKey } = await import('../lib/llm-client.js');
      const r = await probeKey(key.trim(), { candidates: forced ? [forced] : undefined, base: base.trim() || undefined });
      if (!r.ok) {
        const auth = r.tried.filter((t) => t.code === 'auth').map((t) => PROVIDERS[t.id].name);
        const net = r.tried.filter((t) => t.code === 'network').map((t) => PROVIDERS[t.id].name);
        setMsg({ ok: false, text: !r.tried.length ? '无法从格式识别这个密钥：请展开“高级”手动选择服务商。' : `验证失败。${auth.length ? `被拒绝（密钥无效或无权限）：${auth.join('、')}。` : ''}${net.length ? `无法连接：${net.join('、')}（网络问题，或浏览器跨域被拦截——本地版或在线版的中继可以解决）。` : ''}` });
        return;
      }
      const picked = { main: model.trim() || r.main || '', fast: model.trim() || r.fast || '' };
      if (!picked.main) { setMsg({ ok: false, text: `已连通 ${PROVIDERS[r.id].name}，但没能自动选出模型，请在“高级”里填写模型名后再保存。` }); return; }
      byok.save(r.id, { key: key.trim(), model: picked.main, fastModel: picked.fast, models: r.models.slice(0, 300), ...(base.trim() ? { base: base.trim() } : {}) });
      setKey(''); setBase(''); setModel(''); setForced('');
      setMsg({ ok: true, text: `✓ 已连接 ${PROVIDERS[r.id].name}：笔记/词汇用 ${picked.main}，实时翻译用 ${picked.fast}（可在下方修改）` });
      refresh();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  }
  async function runTest(id) {
    setTest((t) => ({ ...t, [id]: { busy: true } }));
    try { const { testProvider } = await import('../lib/llm-client.js'); const t = await testProvider(id); setTest((x) => ({ ...x, [id]: { ok: true, text: `连接成功：“${t}”` } })); }
    catch (e) { setTest((x) => ({ ...x, [id]: { ok: false, text: e.message } })); }
  }
  const setField = (id, patch) => { byok.save(id, patch); refresh(); };

  return html`<div class="card"><h2>API 密钥 <span class="muted small">（笔记、词汇、实时翻译）</span></h2>
    ${config?.claude ? html`<p class="small">本地服务已经配置了 Claude（优先使用服务端密钥），这里<b>可以不填</b>。</p>` : html`<p class="small muted">粘贴任意常见服务商的密钥，会自动识别并验证：Claude、OpenAI、Google Gemini、DeepSeek、Kimi、智谱 GLM、通义千问、豆包、硅基流动、OpenRouter、Groq、xAI…… 没有密钥时使用离线版。</p>`}
    <div class="field"><label>粘贴密钥</label>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…  /  sk-…  /  AIza…" value=${key} onInput=${(e) => setKey(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && key.trim() && save()} /></div>
    ${key.trim() ? html`<div class="small" style="margin:-4px 0 8px">${cands.length ? html`${forced ? '已指定：' : cands.length === 1 && cands[0].confidence === 'high' ? '识别为：' : '可能是：'}${cands.map((c) => html`<span class="badge acc" key=${c.id} title=${CONF[c.confidence]} style="margin-right:4px">${PROVIDERS[c.id].name}${PROVIDERS[c.id].cors === 'unknown' || PROVIDERS[c.id].id === 'custom' ? ' · 实验性' : ''}</span>`)}${cands.length > 1 ? html`<span class="muted tiny">保存时会逐个向服务商验证</span>` : ''}` : html`<span class="muted">无法从格式识别，请展开“高级”手动选择服务商</span>`}</div>` : ''}
    <details style="margin-bottom:8px"><summary class="small">高级：手动指定服务商 / 自定义地址 / 手填模型</summary>
      <div class="row wrap" style="gap:10px;margin-top:6px">
        <div class="field grow"><label>服务商</label><select value=${forced} onChange=${(e) => setForced(e.target.value)}><option value="">自动识别</option>${Object.entries(PROVIDERS).map(([id, p]) => html`<option value=${id}>${p.name}</option>`)}</select></div>
        <div class="field grow"><label>Base URL${need?.needsBase ? '（必填）' : '（可选）'}</label><input value=${base} placeholder=${need?.base || 'https://…/v1'} onInput=${(e) => setBase(e.target.value)} /></div>
        <div class="field grow"><label>模型${need?.needsModel ? '（必填）' : '（可选，留空自动选择）'}</label><input value=${model} onInput=${(e) => setModel(e.target.value)} /></div>
      </div>
      ${need?.note ? html`<div class="tiny muted">${need.note}</div>` : ''}</details>
    <div class="row wrap"><button class="btn primary" disabled=${busy || !key.trim()} onClick=${save}>${busy ? html`<span class="spin"></span> 验证中…` : '保存并验证'}</button></div>
    ${msg ? html`<div class="small" style=${`margin-top:8px;color:var(${msg.ok ? '--ok' : '--stuck'})`}>${msg.text}</div>` : ''}

    ${Object.keys(saved).length ? html`<div class="nsec" style="margin-top:14px"><h3>已保存的密钥</h3>
      ${Object.entries(saved).map(([id, e]) => {
        const p = PROVIDERS[id];
        const opts = [...new Set([...(e.models || []), e.model, e.fastModel].filter(Boolean))];
        const sel = (field, val) => opts.length ? html`<select value=${val || ''} onChange=${(ev) => setField(id, { [field]: ev.target.value })}>${opts.map((m) => html`<option value=${m}>${m}</option>`)}</select>` : html`<input value=${val || ''} onChange=${(ev) => setField(id, { [field]: ev.target.value })} />`;
        const t = test[id];
        return html`<div class="vcard" key=${id}>
          <div class="row wrap"><b>${p.name}</b><span class="badge ok">${maskKey(e.key)}</span>${p.cors === 'unknown' || id === 'custom' ? html`<span class="badge warn" title="尚未用真实密钥验证过这个服务商">实验性</span>` : ''}
            <button class="btn sm right" disabled=${t?.busy} onClick=${() => runTest(id)}>${t?.busy ? '测试中…' : '测试'}</button>
            <button class="btn sm danger ghost" onClick=${() => { byok.remove(id); refresh(); }}>删除</button></div>
          <div class="row wrap" style="gap:10px;margin-top:6px">
            <label class="row small"><input type="radio" name="use-main" checked=${use.main === id} onChange=${() => { byok.setUse('main', id); refresh(); }} /> 用于笔记 / 词汇</label>
            <label class="row small"><input type="radio" name="use-fast" checked=${use.fast === id} onChange=${() => { byok.setUse('fast', id); refresh(); }} /> 用于实时翻译</label></div>
          <div class="row wrap" style="gap:10px;margin-top:6px">
            <div class="field grow" style="margin:0"><label>笔记 / 词汇模型</label>${sel('model', e.model)}</div>
            <div class="field grow" style="margin:0"><label>实时翻译模型（建议选便宜、快的）</label>${sel('fastModel', e.fastModel)}</div></div>
          ${t && !t.busy ? html`<div class="small" style=${`margin-top:6px;color:var(${t.ok ? '--ok' : '--stuck'})`}>${t.ok ? '✓ ' : '✕ '}${t.text}</div>` : ''}</div>`;
      })}</div>` : ''}
    <p class="tiny muted" style="margin-top:10px">密钥只保存在<b>当前浏览器</b>（localStorage），不会进入备份文件。请求直接发往对应服务商；个别服务商不允许浏览器直连时，会经由<b>你自己部署的同源中继</b>转发（只允许白名单主机，不记录密钥）。请勿在公共电脑上保存；建议在服务商控制台为密钥设置用量上限。除 Claude 外，其它服务商尚未用真实密钥验证过，遇到问题请把提示发给我。</p>
  </div>`;
}

const Status = ({ ok, label, hint }) => html`<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)">
  <span>${ok ? '✅' : '⚪️'}</span><div class="grow"><b>${label}</b><div class="tiny muted">${hint}</div></div></div>`;

export function Settings() {
  const config = useStore((s) => s.config);
  const settings = useStore((s) => s.settings);
  const dbMode = useStore((s) => s.dbMode);
  const fileRef = useRef();
  const caps = {
    asr: asrSupported(), mic: micSupported(), tts: 'speechSynthesis' in self, zip: 'DecompressionStream' in self, tr: 'Translator' in self,
  };
  const toggleTarget = (l) => {
    const cur = settings.targets;
    actions.setSetting('targets', cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l].slice(-2));
  };

  async function exportData() {
    const d = await actions.exportData();
    download(`lectureloop-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d), 'application/json');
  }
  async function importData(file) {
    try {
      await actions.importData(JSON.parse(await file.text()));
      toast('已导入备份（不含录音）');
    } catch (e) { toast('导入失败：' + e.message, { kind: 'warn' }); }
  }

  const src = aiSource();
  return html`<div class="page">
    <div class="page-head"><h1>设置</h1></div>
    ${config && !config.server ? html`<div class="banner" style="border-radius:10px;margin-bottom:14px">🌐 你正在使用<b>在线版</b>（没有后端）。课程数据只保存在这个浏览器里；AI 功能需要在下方填入你自己的 API 密钥。需要本地版：下载仓库后双击 <code>start-mac.command</code>（Windows：<code>start-windows.bat</code>）。</div>` : ''}

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
      <div class="card"><h2>服务状态</h2>
        <${Status} ok=${!!src} label=${'AI' + (src === 'server' ? ` · 本地服务 · ${config.model}` : src === 'browser' ? ` · ${PROVIDERS[byok.sel('main')?.id]?.name || ''} · ${byok.sel('main')?.model || ''}` : '')} hint=${src ? '笔记归纳 / 词汇句式 / 翻译可用' : config?.server ? '未配置：在 app/.env 填 ANTHROPIC_API_KEY 后重启，或在下方填入你自己的密钥（否则使用离线版）' : '未配置：在下方填入你自己的 API 密钥（否则使用离线版）'} />
        ${config?.server ? html`<${Status} ok=${config?.translate?.google} label="Google Translate" hint=${config?.translate?.google ? '实时翻译优先使用' : '未配置 GOOGLE_TRANSLATE_API_KEY（可选）'} />` : ''}
        <${Status} ok=${config?.translateAny || byok.has || caps.tr} label="实时翻译" hint=${config?.translateAny ? '本地服务翻译可用' + (config?.claude && !config?.translate?.google ? `（Claude：${config.fastModel}）` : '') : byok.has ? `浏览器直连 ${PROVIDERS[byok.sel('fast')?.id]?.name || ''}（${byok.sel('fast')?.model || ''}）` : caps.tr ? '将尝试浏览器内置翻译（实验性）' : '无翻译服务：上课时只显示原文'} />
        <${Status} ok=${caps.asr} label="浏览器语音识别（Web Speech）" hint=${caps.asr ? '可用。注意：识别可能由浏览器厂商的云端完成' : '不可用（Firefox 等）：请用 Chrome / Edge / Safari，或使用演示课堂/导入'} />
        <${Status} ok=${caps.mic} label="麦克风录音" hint=${caps.mic ? '可用（需 localhost 或 https）' : '不可用'} />
        <${Status} ok=${caps.tts && settings.ttsMode !== 'off'} label="朗读（无录音时的播放兜底）" hint=${caps.tts ? (settings.ttsMode === 'off' ? '已关闭，使用静音计时' : '见下方“朗读语音”：自动模式只在有自然语音时启用') : '不可用，将使用静音计时'} />
        <${Status} ok=${caps.zip} label="docx 解析（DecompressionStream）" hint=${caps.zip ? '可用' : '不可用：请把 docx 另存为 txt 后导入'} />
        <${Status} ok=${dbMode === 'idb'} label=${'本地存储：' + (dbMode === 'idb' ? 'IndexedDB' : '内存（刷新即丢失！）')} hint=${dbMode === 'idb' ? '数据仅保存在本机浏览器' : '浏览器禁用了 IndexedDB（隐私模式？）'} />
      </div>

      <${ByokCard} config=${config} />

      <${VoiceCard} settings=${settings} />

      <div class="card"><h2>偏好</h2>
        <div class="field"><label>默认讲课语言</label><select value=${settings.srcLang} onChange=${(e) => actions.setSetting('srcLang', e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <div class="field"><label>默认显示的译文（最多 2 种）</label><div class="row">${Object.entries(LANGS).map(([k, v]) => html`<span class=${'chip ' + (settings.targets.includes(k) ? 'on' : '')} onClick=${() => toggleTarget(k)}>${v}</span>`)}</div></div>
        <div class="field"><label>笔记 / 释义语言</label><select value=${settings.noteLang} onChange=${(e) => actions.setSetting('noteLang', e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <label class="row small"><input type="checkbox" checked=${settings.fadeOriginal} onChange=${(e) => actions.setSetting('fadeOriginal', e.target.checked)} /> 上课时默认淡出原文（先听后看）</label>
        <label class="row small" style="margin-top:6px" title="录音期间申请屏幕常亮，避免电脑休眠导致录音中断（只在页面可见时有效）"><input type="checkbox" checked=${settings.keepAwake !== false} onChange=${(e) => actions.setSetting('keepAwake', e.target.checked)} /> 录音时保持屏幕常亮</label>
        <label class="row small" style="margin-top:6px"><input type="checkbox" checked=${settings.hideFillers} onChange=${(e) => actions.setSetting('hideFillers', e.target.checked)} /> 阅读时隐藏语气词（uh / um）</label>
      </div>

      <div class="card"><h2>数据</h2>
        <p class="small muted">所有课程、转录、录音和卡点只保存在本机浏览器（IndexedDB）。备份 JSON 不含录音。</p>
        <div class="row wrap"><button class="btn" onClick=${exportData}>导出备份</button><button class="btn" onClick=${() => fileRef.current.click()}>导入备份</button>
          <input ref=${fileRef} class="hide" type="file" accept="application/json" onChange=${(e) => e.target.files[0] && importData(e.target.files[0])} /></div>
        <div class="row wrap" style="margin-top:10px"><button class="btn" onClick=${() => actions.loadSeed().then(() => toast('已加载示例课程'))}>加载示例课程</button>
          <button class="btn danger" onClick=${() => confirm('清空全部数据（课程、转录、录音、卡点）？此操作不可撤销。') && actions.resetAll().then(() => toast('已清空'))}>清空全部数据</button></div>
      </div>

      <div class="card"><h2>合规与隐私</h2>
        <p class="small">• 开始录音前请确认你已获得授课教师/学校对课堂录音的许可。</p>
        <p class="small">• 录音和转录默认只存在本机；调用 Claude / 翻译时只发送<b>文本</b>，不发送音频。</p>
        <p class="small">• 浏览器的语音识别（Web Speech）可能由浏览器厂商的云端处理语音；如需完全本地，请改用“导入转录”。</p>
      </div>
    </div>
  </div>`;
}
