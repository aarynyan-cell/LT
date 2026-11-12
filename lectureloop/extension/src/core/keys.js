// 服务商密钥：存在 chrome.storage.local（background 启动时把它设为"仅受信任环境可读"，网页里的内容脚本读不到）。
// 结构与网页版一致：{ [providerId]: { key, model, fastModel, models[], base? } }；use 指定字幕翻译用哪一个。
import { PROVIDERS, pickModels } from '../../../app/public/js/lib/providers.js';

export const loadKeys = async (c = globalThis.chrome) => {
  const { keys = {}, use = '' } = await c.storage.local.get(['keys', 'use']);
  return { keys, use: keys[use] ? use : Object.keys(keys)[0] || '' };
};
export async function saveKey(id, entry, c = globalThis.chrome) {
  const { keys, use } = await loadKeys(c);
  keys[id] = { models: [], ...keys[id], ...entry };
  await c.storage.local.set({ keys, use: use || id });
}
export async function removeKey(id, c = globalThis.chrome) {
  const { keys, use } = await loadKeys(c);
  delete keys[id];
  await c.storage.local.set({ keys, use: use === id ? Object.keys(keys)[0] || '' : use });
}
export const setUse = (id, c = globalThis.chrome) => c.storage.local.set({ use: id });

/** 当前用于翻译的服务商：{ id, provider, key, model, base } 或 null。优先用"快速模型"（字幕要的是延迟，不是推理深度） */
export function selection({ keys, use }) {
  const e = keys?.[use];
  const provider = PROVIDERS[use];
  if (!e || !provider) return null;
  const picked = pickModels(provider, e.models || []);
  return { id: use, provider, key: e.key, model: e.fastModel || e.model || picked.fast || picked.main, base: e.base || provider.base };
}
