// "自带密钥"（Bring Your Own Key）：在线静态版没有后端，用户可以把自己的 Claude 密钥保存在本浏览器里。
// 只存 localStorage：不进 IndexedDB、不进备份文件，也不会发送到除 api.anthropic.com 以外的任何地方。
import { DEFAULT_MODEL } from './ai-tasks.js';

const K = { key: 'lectureloop.claudeKey', model: 'lectureloop.claudeModel', fast: 'lectureloop.claudeFastModel', base: 'lectureloop.claudeBaseURL' };
const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* 隐私模式等 */ } };

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5（默认，质量最好）'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5（更快更省）'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5（最快最省，适合实时翻译）'],
];

export const byok = {
  get key() { return get(K.key); },
  setKey(v) { set(K.key, (v || '').trim()); },
  clear() { set(K.key, ''); },
  get model() { return get(K.model) || DEFAULT_MODEL; },
  get fastModel() { return get(K.fast) || this.model; },
  setModels(model, fast) { set(K.model, model === DEFAULT_MODEL ? '' : model); set(K.fast, fast === model ? '' : fast); },
  /** 仅用于开发测试：把请求指向本地模拟接口（localStorage 手动设置，界面不暴露） */
  get baseURL() { return get(K.base); },
};

export const maskKey = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');
