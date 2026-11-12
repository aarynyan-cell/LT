// 语言表 + 逐句语言判断（法语 / 英语 / 中文）。纯函数，Node 与浏览器通用。
export const LANGS = { zh: '中文', en: '英语', fr: '法语' };
export const SOURCE_OPTIONS = { auto: '自动判断', ...LANGS };

const FR = new Set(`le la les un une des du de au aux et est sont pas ne que qui quoi dans pour avec sur mais ou où donc car ce cet cette ces je tu il elle nous vous ils elles on mon ma mes ton ta tes son sa ses notre votre leur leurs oui non très bien être avoir fait faire suis es êtes sommes ai as avons avez ont merci bonjour bonsoir salut monsieur madame mademoiselle alors comme aussi encore toujours jamais rien tout tous toute plus moins peu beaucoup déjà jusqu aujourd hui chez sans sous entre vers depuis pendant ça ici là voilà allez viens vas veux peux dois faut puis parce quand comment pourquoi quel quelle quels`.split(/\s+/));
const EN = new Set(`the a an and is are was were not no that this these those with for you i he she we they it my your his her our their yes very be been being have has had do does did of to in on at but or so if what who how why when where can could will would just there here from by as about up out get got go going know think want like see say okay hello thanks thank please sorry don't doesn't didn't can't won't isn't aren't it's i'm you're we're they're that's what's let's gonna wanna gotta yeah nope`.split(/\s+/));
export const STOPWORDS = { fr: FR, en: EN };
const ELISION = /^(l|d|j|n|qu|c|m|t|s|jusqu|lorsqu|puisqu)['’]/i;

/** 返回 'zh' | 'fr' | 'en' | null（无法判断，例如只有人名或符号） */
export function detectLang(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (!letters) return null;
  if (han / letters > 0.3) return 'zh';
  let fr = 0, en = 0;
  for (const raw of s.toLowerCase().split(/[^\p{L}'’]+/u)) {
    if (!raw) continue;
    if (ELISION.test(raw)) fr += 1;
    const w = raw.replace(/^['’]+|['’]+$/g, '');
    if (FR.has(w)) fr += 1;
    if (EN.has(raw) || EN.has(w)) en += 1;
  }
  fr += (s.match(/[éèêàùûçœîïôâë]/gi) || []).length * 0.7;
  if (fr === 0 && en === 0) return null;
  return fr > en ? 'fr' : en > fr ? 'en' : null;
}

/** 目标语言里排除已经是该语言的句子；source 为具体语言时按 source 排除 */
export function targetsFor(text, source, targets) {
  const lang = source && source !== 'auto' ? source : detectLang(text);
  return targets.filter((t) => t !== lang);
}
