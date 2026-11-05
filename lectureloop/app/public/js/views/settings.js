import { html, useRef, useState } from '../h.js';
import { useStore, actions, toast } from '../store.js';
import { download } from '../lib/util.js';
import { asrSupported, micSupported } from '../lib/asr.js';
import { LANGS } from '../components/ui.js';
import { byok, MODELS, maskKey } from '../lib/byok.js';
import { aiSource } from '../lib/api.js';

function ByokCard({ config }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(byok.model);
  const [fast, setFast] = useState(byok.fastModel);
  const [test, setTest] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);
  const saved = byok.key;
  const save = () => {
    if (key.trim()) byok.setKey(key);
    byok.setModels(model, fast);
    setKey(''); setTest(null);
    actions.touchConfig();
    toast(key.trim() ? '已保存密钥（仅存于本浏览器）' : '已保存模型设置');
  };
  const clear = () => { byok.clear(); setTest(null); actions.touchConfig(); toast('已从本浏览器清除 Claude 密钥'); };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { const t = await (await import('../lib/claude-browser.js')).testKey(); setTest({ ok: true, text: `连接成功：“${t}”` }); }
    catch (e) { setTest({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  return html`<div class="card"><h2>在浏览器中使用 Claude</h2>
    ${config?.claude ? html`<p class="small">本地服务已经配置了 Claude（优先使用服务端密钥），这里<b>可以不填</b>。</p>` : html`<p class="small muted">在线版没有后端：填入你<b>自己的</b> Claude API 密钥后，笔记归纳、词汇句式和实时翻译会由浏览器直接调用 Claude。</p>`}
    <div class="field"><label>Claude API 密钥 ${saved ? html`<span class="badge ok">已保存 ${maskKey(saved)}</span>` : ''}</label>
      <input type="password" autocomplete="off" spellcheck="false" placeholder=${saved ? '输入新密钥以替换' : 'sk-ant-…'} value=${key} onInput=${(e) => setKey(e.target.value)} /></div>
    <div class="row wrap" style="gap:12px">
      <div class="field grow"><label>笔记 / 词汇模型</label><select value=${model} onChange=${(e) => setModel(e.target.value)}>${MODELS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></div>
      <div class="field grow"><label>实时翻译模型（建议 Haiku 5.5）</label><select value=${fast} onChange=${(e) => setFast(e.target.value)}>${MODELS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></div>
    </div>
    <div class="row wrap"><button class="btn primary" onClick=${save}>保存</button>
      <button class="btn" disabled=${!saved || busy} onClick=${runTest}>${busy ? html`<span class="spin"></span> 测试中…` : '测试连接'}</button>
      ${saved ? html`<button class="btn danger ghost" onClick=${clear}>清除密钥</button>` : ''}</div>
    ${test ? html`<div class=${'small ' + (test.ok ? '' : 'muted')} style=${`margin-top:8px;color:var(${test.ok ? '--ok' : '--stuck'})`}>${test.ok ? '✓ ' : '✕ '}${test.text}</div>` : ''}
    <p class="tiny muted" style="margin-top:10px">密钥只保存在<b>当前浏览器</b>（localStorage），由浏览器直接发送到 api.anthropic.com，不经过任何其他服务器，也不会进入备份文件。请勿在公共电脑上保存；建议在 Anthropic Console 为这个密钥设置用量上限。</p>
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
    ${config && !config.server ? html`<div class="banner" style="border-radius:10px;margin-bottom:14px">🌐 你正在使用<b>在线版</b>（没有后端）。课程数据只保存在这个浏览器里；AI 功能需要在下方填入你自己的 Claude 密钥。需要本地版：下载仓库后双击 <code>start-mac.command</code>（Windows：<code>start-windows.bat</code>）。</div>` : ''}

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
      <div class="card"><h2>服务状态</h2>
        <${Status} ok=${!!src} label=${'Claude' + (src === 'server' ? ` · 本地服务 · ${config.model}` : src === 'browser' ? ` · 浏览器密钥 · ${byok.model}` : '')} hint=${src ? '笔记归纳 / 词汇句式 / 翻译可用' : config?.server ? '未配置：在 app/.env 填 ANTHROPIC_API_KEY 后重启，或在下方填入你自己的密钥（否则使用离线版）' : '未配置：在下方填入你自己的 Claude 密钥（否则使用离线版）'} />
        ${config?.server ? html`<${Status} ok=${config?.translate?.google} label="Google Translate" hint=${config?.translate?.google ? '实时翻译优先使用' : '未配置 GOOGLE_TRANSLATE_API_KEY（可选）'} />` : ''}
        <${Status} ok=${config?.translateAny || !!byok.key || caps.tr} label="实时翻译" hint=${config?.translateAny ? '本地服务翻译可用' + (config?.claude && !config?.translate?.google ? `（Claude：${config.fastModel}）` : '') : byok.key ? `浏览器直连 Claude（${byok.fastModel}）` : caps.tr ? '将尝试浏览器内置翻译（实验性）' : '无翻译服务：上课时只显示原文'} />
        <${Status} ok=${caps.asr} label="浏览器语音识别（Web Speech）" hint=${caps.asr ? '可用。注意：识别可能由浏览器厂商的云端完成' : '不可用（Firefox 等）：请用 Chrome / Edge / Safari，或使用演示课堂/导入'} />
        <${Status} ok=${caps.mic} label="麦克风录音" hint=${caps.mic ? '可用（需 localhost 或 https）' : '不可用'} />
        <${Status} ok=${caps.tts} label="TTS 朗读（无录音时的播放兜底）" hint=${caps.tts ? '可用' : '不可用，将使用静音计时器'} />
        <${Status} ok=${caps.zip} label="docx 解析（DecompressionStream）" hint=${caps.zip ? '可用' : '不可用：请把 docx 另存为 txt 后导入'} />
        <${Status} ok=${dbMode === 'idb'} label=${'本地存储：' + (dbMode === 'idb' ? 'IndexedDB' : '内存（刷新即丢失！）')} hint=${dbMode === 'idb' ? '数据仅保存在本机浏览器' : '浏览器禁用了 IndexedDB（隐私模式？）'} />
      </div>

      <${ByokCard} config=${config} />

      <div class="card"><h2>偏好</h2>
        <div class="field"><label>默认讲课语言</label><select value=${settings.srcLang} onChange=${(e) => actions.setSetting('srcLang', e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <div class="field"><label>默认显示的译文（最多 2 种）</label><div class="row">${Object.entries(LANGS).map(([k, v]) => html`<span class=${'chip ' + (settings.targets.includes(k) ? 'on' : '')} onClick=${() => toggleTarget(k)}>${v}</span>`)}</div></div>
        <div class="field"><label>笔记 / 释义语言</label><select value=${settings.noteLang} onChange=${(e) => actions.setSetting('noteLang', e.target.value)}>${Object.entries(LANGS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <label class="row small"><input type="checkbox" checked=${settings.fadeOriginal} onChange=${(e) => actions.setSetting('fadeOriginal', e.target.checked)} /> 上课时默认淡出原文（先听后看）</label>
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
