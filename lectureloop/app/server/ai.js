// AI 任务（服务端）：提示词、Schema 与校验在共享模块 public/js/lib/ai-tasks.js，这里只负责用服务端密钥调用 Claude。
// 浏览器只能调用这几个固定任务，不能透传任意 prompt。
import { askJson, MODEL } from './claude.js';
import { notesTask, sanitizeNotes, languageTask, sanitizeLanguage } from '../public/js/lib/ai-tasks.js';

export async function generateNotes(p) {
  const { data, model, usage } = await askJson({ model: MODEL(), ...notesTask(p) });
  return { model, usage, notes: sanitizeNotes(data, p.cues.length) };
}

export async function generateLanguage(p) {
  const { data, model, usage } = await askJson({ model: MODEL(), ...languageTask(p) });
  return { model, usage, language: sanitizeLanguage(data, p.cues) };
}

export { sanitizeNotes, sanitizeLanguage };
