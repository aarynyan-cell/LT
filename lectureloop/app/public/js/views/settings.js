import { html, useRef } from '../h.js';
import { useStore, actions, toast } from '../store.js';
import { download } from '../lib/util.js';
import { asrSupported, micSupported } from '../lib/asr.js';
import { LANGS } from '../components/ui.js';

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

  return html`<div class="page">
    <div class="page-head"><h1>设置</h1></div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
      <div class="card"><h2>服务状态</h2>
        <${Status} ok=${config?.claude} label=${'Claude' + (config?.claude ? ` · ${config.model}` : '')} hint=${config?.claude ? '笔记归纳 / 词汇句式 / 翻译兜底可用' : '未配置：在 app/.env 填 ANTHROPIC_API_KEY 后重启（笔记与词汇将使用离线版）'} />
        <${Status} ok=${config?.translate?.google} label="Google Translate" hint=${config?.translate?.google ? '实时翻译优先使用' : '未配置 GOOGLE_TRANSLATE_API_KEY（可选）'} />
        <${Status} ok=${config?.translateAny || caps.tr} label="翻译可用" hint=${config?.translateAny ? '后端翻译可用' + (config?.claude && !config?.translate?.google ? `（Claude：${config.fastModel}）` : '') : caps.tr ? '将尝试浏览器内置翻译（实验性）' : '无翻译服务：Live 只显示原文'} />
        <${Status} ok=${caps.asr} label="浏览器语音识别（Web Speech）" hint=${caps.asr ? '可用。注意：识别可能由浏览器厂商的云端完成' : '不可用（Firefox 等）：请用 Chrome / Edge / Safari，或使用演示课堂/导入'} />
        <${Status} ok=${caps.mic} label="麦克风录音" hint=${caps.mic ? '可用（需 localhost 或 https）' : '不可用'} />
        <${Status} ok=${caps.tts} label="TTS 朗读（无录音时的播放兜底）" hint=${caps.tts ? '可用' : '不可用，将使用静音计时器'} />
        <${Status} ok=${caps.zip} label="docx 解析（DecompressionStream）" hint=${caps.zip ? '可用' : '不可用：请把 docx 另存为 txt 后导入'} />
        <${Status} ok=${dbMode === 'idb'} label=${'本地存储：' + (dbMode === 'idb' ? 'IndexedDB' : '内存（刷新即丢失！）')} hint=${dbMode === 'idb' ? '数据仅保存在本机浏览器' : '浏览器禁用了 IndexedDB（隐私模式？）'} />
      </div>

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
