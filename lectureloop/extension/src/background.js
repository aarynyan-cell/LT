// Service worker：翻译请求（密钥只在这里使用）、各页面状态汇总、快捷键。
import { loadSettings } from './core/settings.js';
import { loadKeys } from './core/keys.js';
import { translateBatch } from './core/engines.js';

// 密钥放在 storage.local，限制为"受信任环境"（后台、弹窗、设置页）：网页里的内容脚本读不到
try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* 旧版 Chrome */ }

const err = (e) => ({ ok: false, error: { code: e.code || 'error', message: e.message || String(e) } });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'translate') {
    (async () => {
      try {
        const [keys, settings] = await Promise.all([loadKeys(), loadSettings()]);
        reply({ ok: true, result: await translateBatch(msg, { keys, endpoints: settings.endpoints }) });
      } catch (e) { reply(err(e)); }
    })();
    return true; // 异步回复
  }
  if (msg?.type === 'status' && sender.tab) {
    const k = `st:${sender.tab.id}:${sender.frameId}`;
    if (msg.status?.on === false) chrome.storage.session.remove(k);
    else chrome.storage.session.set({ [k]: { ...msg.status, t: Date.now() } });
    if (msg.status?.closedByUser) chrome.storage.session.remove(k);
  }
  if (msg?.type === 'pickDone' && sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'pickCancel' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null);
  const dead = Object.keys(all).filter((k) => k.startsWith(`st:${tabId}:`));
  if (dead.length) chrome.storage.session.remove(dead);
});

// Alt+T：开 / 关当前标签页的字幕翻译
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const all = await chrome.storage.session.get(null);
  const isOn = Object.entries(all).some(([k, v]) => k.startsWith(`st:${tab.id}:`) && v.on);
  chrome.tabs.sendMessage(tab.id, { type: 'setEnabled', on: !isOn }).catch(() => {});
});
