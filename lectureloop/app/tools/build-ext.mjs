// 构建 Chrome 插件：esbuild 把 src/ 打包进 extension/dist/，生成 manifest.json，并打成可下载的 zip（public/downloads/）。
// 用法：npm run build:ext。产物已提交，所以不想构建的人可以直接加载 extension/ 目录；改了源码后重新运行本脚本。
// 不压缩、不混淆（和网页版一致：用户应当能读到自己浏览器里运行的代码）。
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspOrigins } from '../public/js/lib/providers.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../extension');
const ZIP = resolve(here, '../public/downloads/lectureloop-subtitles.zip');
export const VERSION = '0.2.0';

export function manifest() {
  return {
    manifest_version: 3,
    name: 'LectureLoop 字幕翻译',
    short_name: '字幕翻译',
    version: VERSION,
    description: '看网页视频时实时翻译字幕：法语 / 英语 / 中文互译。支持 YouTube、Netflix 等站点的字幕、视频字幕轨道，以及手动选取字幕位置。',
    minimum_chrome_version: '116',
    icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    action: { default_title: '字幕翻译（Alt+T 开关）', default_popup: 'popup/popup.html', default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    side_panel: { default_path: 'sidepanel/sidepanel.html' },
    background: { service_worker: 'dist/background.js' },
    content_scripts: [
      { matches: ['<all_urls>'], js: ['dist/content.js'], all_frames: true, run_at: 'document_idle' },
      // YouTube：运行在页面自己的世界里，把播放器的字幕轨道列表交给内容脚本（内容脚本读不到页面的 JS 变量）
      { matches: ['*://www.youtube.com/*', '*://m.youtube.com/*', '*://www.youtube-nocookie.com/*'], js: ['dist/yt-main.js'], world: 'MAIN', all_frames: true, run_at: 'document_start' },
    ],
    // activeTab：点插件图标时临时获得当前标签页的地址与注入权（没有它，弹窗拿不到 tab.url，会误报“页面不支持”）；scripting：给装插件之前就已打开的页面补注入内容脚本
    // sidePanel：字幕侧边栏；unlimitedStorage：保存字幕转录与翻译记忆（IndexedDB）不被浏览器当作可清理数据
    permissions: ['storage', 'activeTab', 'scripting', 'sidePanel', 'unlimitedStorage'],
    host_permissions: [...cspOrigins().map((o) => o + '/*'), 'https://translate.googleapis.com/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    commands: {
      toggle: { suggested_key: { default: 'Alt+T' }, description: '开 / 关当前标签页的字幕翻译' },
      panel: { suggested_key: { default: 'Alt+S' }, description: '打开字幕侧边栏' },
    },
  };
}

const ENTRIES = { background: 'src/background.js', content: 'src/content.js', popup: 'src/popup.js', options: 'src/options.js', sidepanel: 'src/sidepanel.js', 'yt-main': 'src/yt-main.js' };

/** 打包全部入口；write=false 时只返回内容（测试用来检查提交的 dist 是否过期） */
export async function bundle({ write = true } = {}) {
  const out = {};
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const r = await build({ entryPoints: [join(EXT, entry)], bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', write: false, legalComments: 'none', logLevel: 'silent' });
    out[`dist/${name}.js`] = r.outputFiles[0].text;
  }
  out['manifest.json'] = JSON.stringify(manifest(), null, 2) + '\n';
  if (write) { mkdirSync(join(EXT, 'dist'), { recursive: true }); for (const [f, t] of Object.entries(out)) writeFileSync(join(EXT, f), t); }
  return out;
}

// ---- 极简 ZIP 写入（固定时间戳，内容不变则字节不变）----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zipFiles(files) { // files: [{ name, data: Buffer }]，按名称排序
  const parts = [], central = [];
  let off = 0;
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const { name, data } of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const nm = Buffer.from(name, 'utf8'), comp = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += lh.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
/** 打进 zip 的文件：运行需要的全部（不含 src/ 源码；源码在仓库里） */
export function packageFiles() {
  const keep = ['manifest.json', 'ui.css', 'README.md'];
  const dirs = ['dist', 'popup', 'options', 'sidepanel', 'icons'];
  const rels = [...keep, ...dirs.flatMap((d) => walk(join(EXT, d)).map((p) => relative(EXT, p)))].filter((r) => existsSync(join(EXT, r)));
  return rels.map((name) => ({ name: 'lectureloop-subtitles/' + name.split('\\').join('/'), data: readFileSync(join(EXT, name)) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle();
  mkdirSync(dirname(ZIP), { recursive: true });
  const z = zipFiles(packageFiles());
  writeFileSync(ZIP, z);
  console.log(`extension built → ${EXT}/dist, manifest.json, ${ZIP} (${(z.length / 1024).toFixed(0)} KB)`);
}
