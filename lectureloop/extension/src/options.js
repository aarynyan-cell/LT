// 设置页：管理 AI 密钥（可选）。没有密钥也能用免费的 Google 翻译。
import { h, clear } from './dom.js';
import { PROVIDERS, detectProvider, maskKey, pickModels } from '../../app/public/js/lib/providers.js';
import { loadKeys, saveKey, removeKey, setUse, selection } from './core/keys.js';
import { probeKey } from './core/llm.js';
import { translateLLM } from './core/llm.js';
import { translateGtx } from './core/engines.js';
import { loadSettings } from './core/settings.js';

const app = document.getElementById('app');
let state = { keys: {}, use: '' };
let msg = null; // { tone, text }
let busy = false;

const refresh = async () => { state = await loadKeys(); render(); };
const say = (tone, text) => { msg = { tone, text }; render(); };

async function addKey() {
  const key = document.getElementById('key').value.trim();
  const base = document.getElementById('base').value.trim().replace(/\/+$/, '');
  const prov = document.getElementById('prov').value;
  if (!key && !base) return say('err', '请先粘贴密钥。');
  busy = true; say('', '正在识别并验证密钥…');
  try {
    let candidates;
    if (prov) candidates = [prov];
    else if (base) candidates = ['custom'];
    if (base) { // 自定义地址需要先让用户授权访问这个站点（必须在点击事件里请求）
      const origin = new URL(base).origin + '/*';
      if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) throw new Error('需要授权访问这个地址，才能调用它。');
    }
    const r = await probeKey(key, { candidates, base });
    if (!r.ok) {
      const why = r.tried.length ? r.tried.map((t) => `${PROVIDERS[t.id]?.name || t.id}：${t.message}`).join('；') : '无法从格式判断服务商，请在“服务商”里手动选择。';
      throw new Error(`没能验证这个密钥。${why}`);
    }
    const fast = r.fast || (r.models.length === 1 ? r.models[0] : ''); // 自定义地址/OpenRouter 没有默认模型：只有一个时自动选，多个时让用户选
    await saveKey(r.id, { key, models: r.models, model: r.main || '', fastModel: fast, ...(base ? { base } : {}) });
    document.getElementById('key').value = '';
    busy = false;
    await refresh();
    say(fast || r.main ? 'ok' : 'err', fast || r.main ? `✔ 已保存：${PROVIDERS[r.id].name}（字幕翻译用模型：${fast || r.main}）。` : `已保存 ${PROVIDERS[r.id].name} 的密钥，但需要在下面的列表里选一个模型才能使用。`);
  } catch (e) { busy = false; say('err', e.message); }
}

async function testProvider(id) {
  const sel = selection({ keys: state.keys, use: id });
  busy = true; say('', '正在翻译一句话测试…');
  const t0 = performance.now();
  try {
    const r = await translateLLM({ sel, source: 'en', targets: ['zh'], items: [{ i: 0, t: "Don't look at me like that. I told you it was a bad idea." }] });
    busy = false;
    say('ok', `✔ ${Math.round(performance.now() - t0)} 毫秒：${r.results.zh?.[0]?.t || '(空)'}`);
  } catch (e) { busy = false; say('err', `测试失败：${e.message}`); }
}

async function testFree() {
  busy = true; say('', '正在测试 Google 免费翻译…');
  const t0 = performance.now();
  try {
    const s = await loadSettings();
    const r = await translateGtx({ source: 'en', targets: ['zh'], items: [{ i: 0, t: "Don't look at me like that." }], endpoint: s.endpoints.gtx });
    busy = false;
    say('ok', `✔ ${Math.round(performance.now() - t0)} 毫秒：${r.results.zh[0].t}`);
  } catch (e) { busy = false; say('err', `测试失败：${e.message}`); }
}

function render() {
  const ids = Object.keys(state.keys);
  const el = h('div', {},
    h('h1', {}, 'LectureLoop 字幕翻译 · 设置'),
    h('div', { class: 'muted' }, '字幕翻译不需要密钥也能用（免费的 Google 翻译）。想要更贴合语气、俚语和上下文的翻译，可以填一个 AI 服务的密钥。'),
    h('div', { class: 'card' },
      h('h2', {}, '添加 AI 密钥'),
      h('div', { class: 'col' },
        h('input', { type: 'password', id: 'key', placeholder: '粘贴密钥（sk-ant-…、sk-…、AIza… 等，自动识别服务商）', autocomplete: 'off', 'aria-label': 'API 密钥' }),
        h('details', {}, h('summary', {}, '高级：手动选择服务商 / 自定义地址'),
          h('div', { class: 'col', style: 'margin-top:8px' },
            h('select', { id: 'prov', 'aria-label': '服务商' }, h('option', { value: '' }, '自动识别'), Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k }, p.name))),
            h('input', { type: 'url', id: 'base', placeholder: '自定义 Base URL（例如本机 Ollama：http://localhost:11434/v1）', 'aria-label': '自定义地址' }))),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'add', disabled: busy, onClick: addKey }, '验证并保存'), h('span', { class: 'tiny muted' }, '密钥只保存在这台电脑的浏览器里，只会发给你选的服务商。'))),
      msg ? h('div', { class: 'msg ' + msg.tone, id: 'msg' }, msg.text) : null),
    h('div', { class: 'card' },
      h('h2', {}, '已保存的密钥'),
      ids.length ? ids.map((id) => {
        const e = state.keys[id], p = PROVIDERS[id];
        const picked = pickModels(p, e.models || []);
        const list = picked.list;
        const cur = e.fastModel || e.model || picked.fast || picked.main || '';
        return h('div', { class: 'prov' },
          h('input', { type: 'radio', name: 'use', id: 'use-' + id, checked: state.use === id, 'aria-label': `用 ${p.name} 翻译字幕`, onChange: async () => { await setUse(id); await refresh(); } }),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, p.name, state.use === id ? h('span', { class: 'pill', style: 'margin-left:6px' }, '正在使用') : null), h('div', { class: 'tiny muted mono' }, maskKey(e.key), e.base ? ' · ' + e.base : '')),
          list.length ? h('select', { 'aria-label': '字幕翻译用的模型', style: 'width:200px', onChange: async (ev) => { await saveKey(id, { fastModel: ev.target.value }); await refresh(); } }, (cur ? [] : [h('option', { value: '', selected: true, disabled: true }, '— 请选择模型 —')]), list.map((m) => h('option', { value: m, selected: m === cur }, m))) : h('span', { class: 'tiny muted' }, cur || '（未选择模型）'),
          h('button', { class: 'btn', disabled: busy, onClick: () => testProvider(id) }, '测试'),
          h('button', { class: 'btn danger', onClick: async () => { await removeKey(id); await refresh(); } }, '删除'));
      }) : h('div', { class: 'muted' }, '还没有。')),
    h('div', { class: 'card' },
      h('h2', {}, '免费翻译'),
      h('div', { class: 'row' }, h('button', { class: 'btn', id: 'free', disabled: busy, onClick: testFree }, '测试 Google 免费翻译'), h('span', { class: 'tiny muted' }, '非官方的网页接口，不需要密钥；用得太频繁可能被临时限流。')),
      h('div', { class: 'tiny muted', style: 'margin-top:8px' }, '字幕的翻译请求会发给你选择的翻译服务（Google 或你的 AI 服务商）；没有其他数据离开你的浏览器。')),
  );
  clear(app).append(el);
}

refresh().catch((e) => { app.textContent = '加载失败：' + e.message; });
