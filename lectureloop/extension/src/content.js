// 内容脚本入口：默认休眠（只监听消息和设置）；用户在这个标签页或这个网站开启后才启动 Controller。
import { loadSettings, saveSettings, watchSettings, siteOf } from './core/settings.js';
import { Controller } from './core/controller.js';
import { startPicker } from './core/picker.js';
import { pickVideo } from './core/sources.js';
import { detectLang } from './core/langs.js';

if (!window.__lectureloopSubs) {
  window.__lectureloopSubs = true;
  main();
}

async function main() {
  const isTop = window === window.top;
  if (!isTop && (innerWidth < 200 || innerHeight < 120)) return; // 广告/统计之类的小 iframe 不需要
  const site = siteOf();
  let settings = await loadSettings();
  let picker = null;
  const rt = chrome.runtime;

  const report = (status) => { try { rt.sendMessage({ type: 'status', status }).catch(() => {}); } catch { /* 插件刚更新，旧脚本失效 */ } };
  const hasLocal = () => 'Translator' in self;

  /** Chrome 内置翻译（本机模型，免费；需要较新的 Chrome，语言包要先下载好）。超时 15 秒，免得卡住字幕 */
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Chrome 内置翻译超时（语言包可能还没下载）')), ms))]);
  const pairs = ({ source, targets, items }) => {
    const out = new Set();
    for (const it of items) for (const target of targets) { const from = source !== 'auto' ? source : detectLang(it.t); if (from && from !== target) out.add(`${from}>${target}`); }
    return [...out];
  };
  /** 所有需要的语言对都已经下载好了吗（降级时只用已就绪的，不在后台触发下载） */
  async function localReady(req) {
    if (!hasLocal()) return false;
    try {
      const ps = pairs(req);
      if (!ps.length) return false;
      for (const k of ps) { const [from, to] = k.split('>'); if ((await self.Translator.availability({ sourceLanguage: from, targetLanguage: to })) !== 'available') return false; }
      return true;
    } catch { return false; }
  }
  async function localTranslate({ source, targets, items }) {
    const results = {};
    localTranslate.cache ||= new Map();
    for (const target of targets) {
      const out = [];
      for (const it of items) {
        const from = source !== 'auto' ? source : detectLang(it.t);
        if (!from || from === target) { out.push({ i: it.i, t: '' }); continue; }
        const key = `${from}>${target}`;
        let tr = localTranslate.cache.get(key);
        if (!tr) { tr = await withTimeout(self.Translator.create({ sourceLanguage: from, targetLanguage: target }), 15000); localTranslate.cache.set(key, tr); }
        out.push({ i: it.i, t: await withTimeout(tr.translate(it.t), 15000) });
      }
      results[target] = out;
    }
    return { provider: 'chrome', results };
  }

  async function send(req) {
    if (settings.engine === 'chrome') {
      if (!hasLocal()) throw new Error('这个 Chrome 版本没有内置翻译（需要 Chrome 138 或更新）');
      return localTranslate(req);
    }
    let r;
    try { r = await rt.sendMessage({ type: 'translate', ...req, engine: settings.engine }); }
    catch { throw new Error('插件刚刚更新过，请刷新这个页面'); }
    if (r?.ok) return r.result;
    if (settings.engine === 'auto' && (await localReady(req))) { try { return await localTranslate(req); } catch { /* 用下面的错误 */ } }
    throw new Error(r?.error?.message || '翻译失败');
  }

  const ctl = new Controller({
    site, settings, send, report,
    saveSettings: (p) => saveSettings(p),
  });
  const setOn = (on) => { on ? ctl.start() : ctl.stop(); if (!on) report({ on: false }); };

  watchSettings((s) => { settings = s; ctl.setSettings(s); if (s.sites[site] && !ctl.on) ctl.start(); });
  if (settings.sites[site]) ctl.start();

  const shouldPick = () => !!pickVideo(document) || (isTop && !document.querySelector('iframe'));
  rt.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'setEnabled') setOn(!!msg.on);
    else if (msg?.type === 'ping') reply({ on: ctl.on, site, top: isTop });
    else if (msg?.type === 'pick') {
      if (!shouldPick()) return;
      if (!ctl.on) ctl.start();
      picker?.cancel();
      picker = startPicker({
        onPick: async (sel) => {
          picker = null;
          const s = await loadSettings();
          await saveSettings({ pickers: { ...s.pickers, [site]: [sel] } });
          rt.sendMessage({ type: 'pickDone' }).catch(() => {});
        },
        onCancel: () => { picker = null; rt.sendMessage({ type: 'pickDone' }).catch(() => {}); },
      });
    } else if (msg?.type === 'pickCancel') { picker?.cancel(); picker = null; }
  });
}
