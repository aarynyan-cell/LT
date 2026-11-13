// Service worker：翻译请求（密钥只在这里使用）、各页面状态汇总、快捷键。
import { loadSettings } from './core/settings.js';
import { loadKeys } from './core/keys.js';
import { translateBatch } from './core/engines.js';
import { selection } from './core/keys.js';
import { translateWithTM } from './core/tm.js';
import { getVideo, upsertVideo, tmGetMany, tmPutMany } from './core/store.js';

// 密钥放在 storage.local，限制为"受信任环境"（后台、弹窗、设置页）：网页里的内容脚本读不到
try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* 旧版 Chrome */ }

const err = (e) => ({ ok: false, error: { code: e.code || 'error', message: e.message || String(e) } });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'translate') {
    (async () => {
      try {
        const [keys, settings] = await Promise.all([loadKeys(), loadSettings()]);
        // 先查翻译记忆：看过的句子不再请求翻译服务（循环播放、重看同一个视频、别的视频里的同一句）
        const run = (r) => translateBatch(r, { keys, endpoints: settings.endpoints });
        const wantAI = !!selection(keys) && msg.engine !== 'gtx';
        reply({ ok: true, result: await translateWithTM(msg, { getMany: tmGetMany, putMany: tmPutMany, run, wantAI }) });
      } catch (e) { reply(err(e)); }
    })();
    return true; // 异步回复
  }
  // 转录：内容脚本不能直接用扩展的数据库，经后台读写；写完通知侧边栏刷新
  if (msg?.type === 'tx-get') { getVideo(msg.key).then((video) => reply({ ok: true, video })).catch((e) => reply(err(e))); return true; }
  if (msg?.type === 'tx-upsert') {
    upsertVideo(msg.video, msg.lines, { replace: !!msg.replace }).then(() => { reply({ ok: true }); chrome.runtime.sendMessage({ type: 'tx-updated', key: msg.video.key }).catch(() => {}); }).catch((e) => reply(err(e)));
    return true;
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
  if (cmd === 'panel') { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); if (t?.id) chrome.sidePanel.open({ tabId: t.id }).catch(() => {}); return; }
  if (cmd !== 'toggle') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const all = await chrome.storage.session.get(null);
  const isOn = Object.entries(all).some(([k, v]) => k.startsWith(`st:${tab.id}:`) && v.on);
  chrome.tabs.sendMessage(tab.id, { type: 'setEnabled', on: !isOn }).catch(() => {});
});
