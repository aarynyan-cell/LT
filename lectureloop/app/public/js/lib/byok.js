// "自带密钥"（Bring Your Own Key）：可以保存多个服务商的密钥，并分别指定"笔记/词汇"和"实时翻译"用哪个。
// 只存 localStorage：不进 IndexedDB、不进备份文件；只会发送给对应服务商（或同源中继）。
import { PROVIDERS, pickModels } from './providers.js';

const K = { keys: 'lectureloop.keys', use: 'lectureloop.use', base: 'lectureloop.baseOverrides',
  legacyKey: 'lectureloop.claudeKey', legacyModel: 'lectureloop.claudeModel', legacyFast: 'lectureloop.claudeFastModel', legacyBase: 'lectureloop.claudeBaseURL' };
const rd = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const wr = (k, v) => { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 隐私模式等 */ } };
const json = (k, d) => { try { return JSON.parse(rd(k)) || d; } catch { return d; } };

/** 旧版只存一个 Claude 密钥：迁移到多服务商结构（只执行一次） */
function migrate() {
  const old = rd(K.legacyKey);
  if (!old || rd(K.keys)) return;
  wr(K.keys, JSON.stringify({ anthropic: { key: old, model: rd(K.legacyModel) || '', fastModel: rd(K.legacyFast) || '', models: [] } }));
  wr(K.use, JSON.stringify({ main: 'anthropic', fast: 'anthropic' }));
  if (rd(K.legacyBase)) wr(K.base, JSON.stringify({ anthropic: rd(K.legacyBase) }));
  [K.legacyKey, K.legacyModel, K.legacyFast, K.legacyBase].forEach((k) => wr(k, ''));
}

export const byok = {
  /** { [providerId]: { key, model, fastModel, models[], base? } } */
  all() { migrate(); return json(K.keys, {}); },
  get has() { return Object.keys(this.all()).length > 0; },
  get(id) { return this.all()[id] || null; },
  save(id, entry) {
    const all = this.all();
    all[id] = { models: [], ...all[id], ...entry };
    wr(K.keys, JSON.stringify(all));
    const u = this.use();
    // 第一个保存的服务商同时用于笔记和翻译；之后保持用户的选择
    this.setUse('main', u.main && all[u.main] ? u.main : id);
    this.setUse('fast', u.fast && all[u.fast] ? u.fast : id);
  },
  remove(id) {
    const all = this.all();
    delete all[id];
    wr(K.keys, Object.keys(all).length ? JSON.stringify(all) : '');
    const u = this.use();
    const first = Object.keys(all)[0] || '';
    wr(K.use, first ? JSON.stringify({ main: all[u.main] ? u.main : first, fast: all[u.fast] ? u.fast : first }) : '');
  },
  use() {
    const all = this.all();
    const u = json(K.use, {});
    const first = Object.keys(all)[0] || '';
    return { main: all[u.main] ? u.main : first, fast: all[u.fast] ? u.fast : first };
  },
  setUse(which, id) { wr(K.use, JSON.stringify({ ...this.use(), [which]: id })); },
  /** 当前用于某类任务的服务商：{ id, provider, key, model, base } 或 null */
  sel(which) {
    const id = this.use()[which];
    const e = id && this.get(id);
    if (!e) return null;
    const provider = PROVIDERS[id];
    const picked = pickModels(provider, e.models || []);
    const model = which === 'fast' ? (e.fastModel || e.model || picked.fast || picked.main) : (e.model || picked.main);
    return { id, provider, key: e.key, model, base: e.base || this.baseOverride(id) || '' };
  },
  /** 测试用：把某服务商的请求指向本地模拟接口（localStorage 手动设置，界面不暴露） */
  baseOverride(id) { return json(K.base, {})[id] || ''; },
  clear() { [K.keys, K.use].forEach((k) => wr(k, '')); },
};

export const modelLabel = (which) => byok.sel(which)?.model || '';
