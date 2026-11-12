// E2E（Playwright）：在真实 Chromium 里加载 extension/ 目录的插件，用本地测试页 + 模拟翻译服务验证完整链路。
//   node tests/e2e/extension.cjs      （自己会启动测试页服务 :8799 和模拟 API :8788；需要 playwright 与 chromium）
// 测试页里的 YouTube / Netflix 字幕层是照它们的 DOM 结构写的仿制品——没有访问真实网站，所以这里验证的是"插件对这种 DOM 的行为"。
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { start } = require('./ext-server.cjs');

const EXT = path.resolve(__dirname, '../../../extension');
const OUT = process.env.OUT || './e2e-out';
const PAGE = 'http://127.0.0.1:8799/page.html';
const MOCK = 'http://127.0.0.1:8788';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { startMock, last } = await import('../../tools/mock-api.mjs');
  const mock = startMock(8788);
  const pages = await start(8799);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-ext-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required',
      '--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP www.netflix.com 127.0.0.1, MAP www.example.test 127.0.0.1'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(sw.url()).host;
  const errors = [];
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`[${tag} pageerror] ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text() + (m.location()?.url || ''))) errors.push(`[${tag}] ${m.text()}`); });
  };
  const admin = await ctx.newPage();
  watch(admin, 'admin');
  await admin.goto(`chrome-extension://${id}/options/options.html`);

  let fails = 0;
  const step = async (name, fn) => {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // 调试：只跑名字里包含 ONLY 的步骤
    try { await fn(); console.log('✔', name); } catch (e) { fails++; console.log('✘', name, '→', e.message.split('\n')[0]); }
  };
  const until = async (fn, ms = 9000, what = '条件') => {
    const t0 = Date.now(); let v;
    while (Date.now() - t0 < ms) { try { v = await fn(); if (v) return v; } catch { /* 继续等 */ } await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`等待超时：${what}（最后值 ${JSON.stringify(v)}）`);
  };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

  // ----- 工具：设置 / 状态 / 悬浮层 -----
  const resetStore = async () => {
    await admin.evaluate(async () => { await chrome.storage.sync.clear(); await chrome.storage.local.clear(); await chrome.storage.session.clear(); });
    // 清空字幕记录与翻译记忆：不然上一个测试留下的译文会被直接复用（这正是它的功能）
    admin.once('dialog', (d) => d.accept());
    await admin.reload(); await admin.locator('#clear-tx').click();
    await until(async () => /已保存 0 个视频的字幕、0 条翻译记忆/.test(await admin.locator('#dbstats').textContent()), 4000, '字幕记录已清空');
    for (const k of Object.keys(last)) delete last[k];
  };
  const setSync = (patch) => admin.evaluate((p) => chrome.storage.sync.set(p), patch);
  const getSync = () => admin.evaluate(() => chrome.storage.sync.get(null));
  const baseSettings = (extra = {}) => ({ endpoints: { gtx: MOCK + '/gtx' }, ...extra });
  const statuses = () => admin.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith('st:')).map(([, v]) => v));
  const tabId = (part) => admin.evaluate(async (s) => (await chrome.tabs.query({})).find((t) => (t.url || '').includes(s))?.id, part);
  const ov = (page) => page.evaluate(() => {
    const h = document.querySelector('lectureloop-subtitles');
    if (!h) return null;
    const r = h.shadowRoot, q = (s) => r.querySelector(s), box = q('.box');
    return { hidden: box.hidden, o: q('.o').textContent, t1: q('.t1').textContent, t2: q('.t2').textContent, err: box.classList.contains('err'), parent: h.parentElement ? h.parentElement.tagName + '#' + h.parentElement.id : '', rect: box.getBoundingClientRect().toJSON(), fs: getComputedStyle(box).fontSize };
  });
  const open = async (url) => { const p = await ctx.newPage(); watch(p, 'page'); await p.goto(url); return p; };
  const seek = (p, t, play = false) => p.evaluate(([t, play]) => { const v = document.getElementById('v'); v.currentTime = t; play ? v.play() : v.pause(); }, [t, play]);
  const closeExtra = async () => { for (const p of ctx.pages()) if (p !== admin) await p.close().catch(() => {}); };

  await step('插件加载：Manifest V3、后台服务就绪', async () => {
    eq(await admin.evaluate(() => chrome.runtime.getManifest().manifest_version), 3, 'manifest 版本');
    eq(await admin.evaluate(() => chrome.runtime.getManifest().name), 'LectureLoop 字幕翻译', '名称');
  });

  // ================= 视频字幕轨道 =================
  await step('字幕轨道：此网站自动开启 → 悬浮层显示译文；整条轨道提前翻译；已经是中文的句子不翻译', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true } }));
    const p = await open(PAGE + '?mode=track');
    await seek(p, 0.3, true);
    await until(async () => (await ov(p))?.t1 === '[g:zh-CN] Salut, comment ça va ?', 9000, '第一句译文');
    await until(() => (last.gtx || []).some((c) => c.q === 'Bonne nuit à tous.'), 9000, '提前翻译到后面的字幕');
    const qs = (last.gtx || []).map((c) => c.q);
    if (new Set(qs).size < 10) throw new Error('预翻译的句数太少：' + new Set(qs).size);
    if (qs.some((q) => q.includes('你到底'))) throw new Error('中文句子不应该再翻译成中文');
    if (!(last.gtx || []).every((c) => c.sl === 'fr' || c.sl === 'auto')) throw new Error('源语言参数异常');
    await seek(p, 30.5);
    await until(async () => (await ov(p))?.hidden === true, 4000, '中文字幕句不显示译文');
    await seek(p, 2.8);
    await until(async () => (await ov(p))?.t1 === '[g:zh-CN] Je ne sais pas ce que vous voulez.', 5000, '拖动进度后译文跟上（来自预翻译缓存）');
    await p.screenshot({ path: `${OUT}/ext-1-track.png` });
    await closeExtra();
  });

  await step('字幕轨道：隐藏网站字幕 = 轨道改为 hidden 且悬浮层带出原文；关掉后恢复', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true } }));
    const p = await open(PAGE + '?mode=track');
    await seek(p, 3);
    await until(async () => (await ov(p))?.t1.startsWith('[g:zh-CN]'), 9000, '有译文');
    eq(await p.evaluate(() => document.getElementById('v').textTracks[0].mode), 'showing', '默认：网站字幕仍显示');
    eq((await ov(p)).o, '', '默认不显示原文');
    await setSync({ hideSite: true });
    await until(async () => (await ov(p))?.o === 'Je ne sais pas ce que vous voulez.', 5000, '隐藏网站字幕后悬浮层显示原文');
    await until(async () => (await p.evaluate(() => document.getElementById('v').textTracks[0].mode)) === 'hidden', 3000, '网站原生字幕已隐藏');
    await setSync({ hideSite: false, showOrig: true });
    await until(async () => (await p.evaluate(() => document.getElementById('v').textTracks[0].mode)) === 'showing', 5000, '恢复网站字幕');
    eq((await ov(p)).o, 'Je ne sais pas ce que vous voulez.', '勾选“显示原文”');
    await closeExtra();
  });

  // ================= 已知网站的 DOM =================
  await step('YouTube 结构：识别来源、读到字幕、隐藏网站字幕', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { 'www.youtube.com': true } }));
    const p = await open('http://www.youtube.com:8799/page.html?mode=yt');
    await seek(p, 5.2);
    await until(async () => (await ov(p))?.t1 === "[g:zh-CN] C'est trop tard, il faut partir.", 9000, 'YouTube 字幕译文');
    await until(async () => (await statuses()).some((s) => s.on && s.source?.id === 'youtube'), 4000, '状态里的来源是 YouTube');
    await setSync({ hideSite: true });
    await until(async () => (await p.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility)) === 'hidden', 4000, '网站字幕容器被隐藏');
    await p.screenshot({ path: `${OUT}/ext-2-youtube-hide.png` });
    await closeExtra();
  });

  await step('Netflix 结构：两行并排的 span 要用空格拼起来', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { 'www.netflix.com': true }, showOrig: true }));
    const p = await open('http://www.netflix.com:8799/page.html?mode=netflix');
    await seek(p, 0.5);
    await until(async () => (await ov(p))?.o === 'Salut, comment ça va ?', 9000, '原文被正确拼接');
    await until(async () => (await ov(p))?.t1 === '[g:zh-CN] Salut, comment ça va ?', 9000, '译文');
    await closeExtra();
  });

  // ================= 手动选取 + 弹窗 =================
  await step('弹窗开关 + 选取字幕位置：没有适配的网站也能用，并记住这个网站', async () => {
    await resetStore();
    await setSync(baseSettings());
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3);
    const tid = await tabId(':8799/page.html?mode=dom');
    const pop = await ctx.newPage(); watch(pop, 'popup');
    await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tid}&url=${encodeURIComponent(PAGE)}`);
    await pop.waitForSelector('#on');
    await pop.locator('label.switch').click();
    await until(async () => (await statuses()).some((s) => s.on), 5000, '弹窗开关生效');
    await until(async () => /还没找到字幕/.test(await pop.locator('.status').textContent()), 5000, '弹窗提示还没找到字幕');
    eq((await ov(p))?.hidden, true, '没有字幕来源时悬浮层不显示');
    await pop.locator('#pick').click();
    await p.waitForFunction(() => !!document.querySelector('lectureloop-picker'), null, { timeout: 5000 });
    const r = await p.locator('.my-subs .line').boundingBox();
    await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await p.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await until(async () => JSON.stringify((await getSync()).pickers) === JSON.stringify({ '127.0.0.1': ['.line'] }), 5000, '选择器已保存');
    await p.waitForFunction(() => !document.querySelector('lectureloop-picker'), null, { timeout: 3000 });
    await seek(p, 3, true);
    await until(async () => (await ov(p))?.t1?.startsWith('[g:zh-CN] Je ne sais pas'), 9000, '选取后显示译文');
    await until(async () => (await statuses()).some((s) => s.source?.id === 'picker'), 4000, '来源是手动选取');
    await until(async () => /手动选取/.test(await pop.locator('.status').textContent()), 4000, '弹窗显示来源');
    await p.screenshot({ path: `${OUT}/ext-3-picker.png` });
    // 弹窗里改语言 / 勾选
    await pop.locator('#t1').selectOption('en');
    await until(async () => (await getSync()).targets?.[0] === 'en', 3000, '目标语言写入设置');
    await until(async () => (await ov(p))?.t1?.startsWith('[g:en]'), 9000, '改成英语后重新翻译');
    await pop.locator('#t2').selectOption('zh');
    await until(async () => { const o = await ov(p); return o?.t1?.startsWith('[g:en]') && o?.t2?.startsWith('[g:zh-CN]'); }, 9000, '两种译文同时显示');
    await pop.locator('#fs').fill('1.7');
    await until(async () => +(await getSync()).fontScale === 1.7, 3000, '拖动滑块后设置被保存（合并写入）');
    await pop.locator('#always').check();
    await until(async () => (await getSync()).sites?.['127.0.0.1'] === true, 3000, '“此网站总是开启”写入设置');
    await pop.locator('#reset').click();
    await until(async () => Object.keys((await getSync()).pickers || {}).length === 0, 3000, '重置清除手动选取');
    await pop.close(); await closeExtra();
  });

  await step('真实场景：拿不到标签页地址（没有主机权限的网站）时，弹窗仍然可用，不误报"页面不支持"', async () => {
    await resetStore();
    await setSync(baseSettings());
    const p = await open('http://www.example.test:8799/page.html?mode=track');
    await seek(p, 3);
    // 没有主机权限时连标签页的 url/title 都查不到，只能让内容脚本自报家门（ping 回复里有 site）来找到这个标签页
    const tid = await until(() => admin.evaluate(async () => {
      for (const t of await chrome.tabs.query({})) { const r = await chrome.tabs.sendMessage(t.id, { type: 'ping' }).catch(() => null); if (r?.site === 'www.example.test') return t.id; }
      return 0;
    }), 6000, '找到这个标签页');
    // 前提：这个站不在 host_permissions 里，扩展页面读到的标签页是没有 url 的（用户那边的弹窗就是因此误报）
    eq(await admin.evaluate(async (t) => (await chrome.tabs.get(t)).url ?? null, tid), null, '标签页地址对扩展不可见');
    const pop = await ctx.newPage(); watch(pop, 'popup');
    await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tid}`); // 不传 url：与真实弹窗一样只有标签页 id
    await pop.waitForSelector('#on');
    if (/不支持/.test(await pop.locator('.status').textContent())) throw new Error('误报了"这个页面不支持"');
    eq(await pop.locator('#on').isDisabled(), false, '开关应可用');
    await until(async () => /www\.example\.test/.test(await pop.locator('#app').textContent()), 4000, '用内容脚本报告的网站名显示');
    await pop.locator('label.switch').click();
    await until(async () => (await ov(p))?.t1?.startsWith('[g:zh-CN] Je ne sais pas'), 9000, '开启后显示译文');
    await pop.locator('#always').check();
    await until(async () => (await getSync()).sites?.['www.example.test'] === true, 3000, '“总是开启”记在这个网站下');
    await pop.close(); await closeExtra();
  });

  // ================= 侧边栏 =================
  const panelFor = async (tid) => { const pn = await ctx.newPage(); watch(pn, 'panel'); await pn.goto(`chrome-extension://${id}/sidepanel/sidepanel.html?tabId=${tid}`); await pn.waitForSelector('.head'); await pn.locator('[data-tab=lines]').click(); return pn; };

  await step('侧边栏：字幕轨道整条载入 + 译文逐步出现 + 点句子跳转 + 当前句高亮 + 循环这一句', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true } }));
    const p = await open(PAGE + '?mode=track');
    await seek(p, 0.3, true);
    const pn = await panelFor(await tabId(':8799/page.html?mode=track'));
    await until(async () => (await pn.locator('.ln').count()) === 13, 9000, '13 句字幕一次性全部列出来');
    eq(await pn.locator('.sub').textContent(), '字幕测试页', '视频标题');
    await until(async () => (await pn.locator('.ln').first().locator('.tr').textContent()) === '[g:zh-CN] Salut, comment ça va ?', 12000, '第一句的译文出现');
    await until(async () => (await pn.locator('.tr.pending').count()) === 0, 12000, '所有需要翻译的句子都有译文（中文那句不需要，不应一直显示省略号）');
    // 点 ▶ 跳转
    await pn.locator('.ln').nth(4).locator('button[aria-label="从这里播放"]').click();
    await until(async () => { const t = await p.evaluate(() => document.getElementById('v').currentTime); return t >= 9.8 && t < 12.5; }, 4000, '视频跳到第 5 句');
    await until(async () => /Je vais chez moi/.test((await pn.locator('.ln.cur').first().textContent().catch(() => '')) || ''), 6000, '当前句高亮');
    // 循环这一句（12.5–14.5）
    await pn.locator('.ln').nth(5).locator('button[aria-label="循环这一句"]').click();
    const seen = [];
    for (let i = 0; i < 14; i++) { seen.push(await p.evaluate(() => document.getElementById('v').currentTime)); await new Promise((r) => setTimeout(r, 500)); }
    if (seen.some((t) => t < 12.3 || t > 14.8)) throw new Error('循环没有停留在这一句里：' + seen.map((x) => x.toFixed(1)).join(','));
    if (Math.max(...seen) - Math.min(...seen) < 0.8) throw new Error('循环时视频没有在播放');
    await pn.locator('.ln').nth(5).locator('button[aria-label="循环这一句"]').click();
    await pn.screenshot({ path: `${OUT}/ext-7-sidepanel.png` });
    await pn.close(); await closeExtra();
  });

  await step('侧边栏：收藏单词（红/黄/绿）与句子（四种颜色）、按颜色筛选、导出、刷新后保留', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true } }));
    const p = await open(PAGE + '?mode=track');
    await seek(p, 0.3);
    const pn = await panelFor(await tabId(':8799/page.html?mode=track'));
    await until(async () => (await pn.locator('.ln').count()) === 13, 9000, '字幕已载入');
    const line = pn.locator('.ln', { hasText: 'Je vais chez moi' });
    await line.locator('.w[data-w="chez"]').click();
    await until(async () => /\[g:zh-CN\] chez/.test(await pn.locator('#card .tr1').textContent()), 8000, '单词卡里有译文');
    await pn.locator('#wc-red').click();
    await until(async () => (await line.locator('.w[data-w="chez"]').getAttribute('class')).includes('c-red'), 3000, '单词变红');
    // 另一个词标成绿色
    await line.locator('.w[data-w="merci"]').click();
    await until(async () => /merci/.test(await pn.locator('#card .w1').textContent()), 3000, '换成 merci 的卡');
    await pn.locator('#wc-green').click();
    await until(async () => (await line.locator('.w[data-w="merci"]').getAttribute('class')).includes('c-green'), 3000, '单词变绿');
    await pn.locator('#card .close').click();
    // 句子：☆ → 蓝色
    const sline = pn.locator('.ln', { hasText: 'Bonne nuit à tous' });
    await sline.locator('button[aria-label="收藏这句"]').click();
    await sline.locator('.pal .dot.blue').click();
    await until(async () => (await pn.locator('.ln', { hasText: 'Bonne nuit à tous' }).getAttribute('class')).includes('sc-blue'), 3000, '句子整行变蓝');
    // 收藏页
    await pn.locator('[data-tab=saved]').click();
    eq(await pn.locator('.row[data-id]').count(), 3, '收藏了 3 项');
    await pn.getByRole('button', { name: '不会', exact: true }).click();
    eq(await pn.locator('.row[data-id]').count(), 1, '按红色筛选');
    eq(await pn.locator('.row[data-id] .k').textContent(), 'chez', '红色的是 chez');
    await pn.getByRole('button', { name: '全部颜色' }).click();
    const [dl] = await Promise.all([pn.waitForEvent('download'), pn.locator('#export').click()]);
    const tsv = fs.readFileSync(await dl.path(), 'utf8');
    if (!/^类型\t原文\t译文/.test(tsv) || !tsv.includes('chez') || !tsv.includes('Bonne nuit à tous') || !/不会/.test(tsv)) throw new Error('导出内容不对：' + tsv.slice(0, 200));
    await pn.screenshot({ path: `${OUT}/ext-8-saved.png` });
    // 刷新后保留，颜色仍然显示
    await pn.reload(); await pn.waitForSelector('.head');
    await pn.locator('[data-tab=lines]').click(); // 侧边栏记住了上次的标签页（收藏）
    await until(async () => (await pn.locator('.ln').count()) === 13, 9000, '字幕仍在');
    eq((await pn.locator('.ln', { hasText: 'Je vais chez moi' }).locator('.w[data-w="chez"]').getAttribute('class')).includes('c-red'), true, '刷新后 chez 仍是红色');
    eq((await pn.locator('.ln', { hasText: 'Bonne nuit à tous' }).getAttribute('class')).includes('sc-blue'), true, '刷新后句子仍是蓝色');
    // 删除
    await pn.locator('[data-tab=saved]').click();
    await pn.locator('.row[data-id]').first().locator('button[aria-label="删除"]').click();
    await until(async () => (await pn.locator('.row[data-id]').count()) === 2, 3000, '删除一项');
    await pn.close(); await closeExtra();
  });

  await step('侧边栏：同一个视频再看 / 循环播放 / 刷新页面，都直接用已有字幕与译文，不再请求翻译', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } }));
    const p = await open(PAGE + '?mode=dom');
    await p.evaluate(() => { const v = document.getElementById('v'); v.playbackRate = 2; v.currentTime = 0; v.play(); });
    const pn = await panelFor(await tabId(':8799/page.html?mode=dom'));
    await until(async () => (await pn.locator('.ln').count()) >= 13, 25000, '边播边记：13 句都出现在侧边栏');
    await until(async () => (await pn.locator('.ln .tr').count()) >= 12, 15000, '各句译文都到了');
    const firstPass = await pn.locator('.ln').count();
    await p.evaluate(() => document.getElementById('v').pause());
    await new Promise((r) => setTimeout(r, 1500));
    const g1 = (last.gtx || []).length;
    // 循环：回到开头再播一遍
    await p.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0.2; v.play(); });
    await until(async () => (await ov(p))?.t1 === '[g:zh-CN] Salut, comment ça va ?', 2500, '回到开头，第一句的译文马上出现');
    await new Promise((r) => setTimeout(r, 9000)); // 再播 ~18 秒的内容
    eq(await pn.locator('.ln').count(), firstPass, '循环播放没有产生重复的句子');
    eq((last.gtx || []).length, g1, '循环播放期间没有再请求翻译');
    // 刷新页面：新会话，从保存的转录里直接拿译文
    await p.reload();
    await p.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 2.6; v.pause(); });
    await until(async () => (await ov(p))?.t1 === '[g:zh-CN] Je ne sais pas ce que vous voulez.', 4000, '刷新后译文直接出现');
    eq((last.gtx || []).length, g1, '刷新页面后也没有再请求翻译');
    await pn.close(); await closeExtra();
  });

  await step('侧边栏：没有开启字幕翻译的标签页给出说明；弹窗里有侧边栏入口', async () => {
    await resetStore();
    await setSync(baseSettings());
    const p = await open(PAGE + '?mode=track');
    const tid = await tabId(':8799/page.html?mode=track');
    const pn = await panelFor(tid);
    if (!/还没有字幕/.test(await pn.locator('.empty').textContent())) throw new Error('没有空状态说明');
    await pn.close();
    const pop = await ctx.newPage(); watch(pop, 'popup');
    await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=${tid}&url=${encodeURIComponent(PAGE)}`);
    await pop.waitForSelector('#panel');
    await pop.close(); await closeExtra();
  });

  // ================= 翻译引擎 =================
  await step('设置页：粘贴密钥并验证 → 选模型 → 测试；字幕改用 AI 翻译', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } }));
    await admin.reload();
    await admin.locator('details summary').click();
    await admin.fill('#key', 'test-key-123');
    await admin.fill('#base', MOCK + '/p/ok');
    await admin.locator('#add').click();
    await until(async () => /选一个模型/.test(await admin.locator('#msg').textContent()), 6000, '没有默认模型时提示选择');
    await admin.getByLabel('字幕翻译用的模型').selectOption('mock-large');
    await until(async () => (await admin.evaluate(() => chrome.storage.local.get('keys'))).keys?.custom?.fastModel === 'mock-large', 4000, '模型已保存');
    await admin.getByRole('button', { name: '测试', exact: true }).click();
    await until(async () => /✔.*【zh】/.test(await admin.locator('#msg').textContent()), 6000, '测试翻译成功');
    await admin.screenshot({ path: `${OUT}/ext-4-options.png` });
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3.2, true);
    await until(async () => (await ov(p))?.t1?.startsWith('【zh】'), 9000, '悬浮层里是 AI 翻译（模拟服务的前缀）');
    const call = (last.openai || []).filter((c) => c.rest === '/chat/completions').at(-1);
    if (!call || call.auth !== 'Bearer test-key-123') throw new Error('请求没有带上用户的密钥');
    await until(async () => (await statuses()).some((s) => s.provider === 'ai:custom'), 4000, '状态里的引擎是 AI');
    await closeExtra();
  });

  await step('AI 失败时降级到 Google 免费翻译并说明原因；只用 AI 时显示错误并保留原文', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } }));
    await admin.evaluate((base) => chrome.storage.local.set({ keys: { custom: { key: 'k', models: ['mock-large'], fastModel: 'mock-large', base } }, use: 'custom' }), MOCK + '/p/refuse');
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3.2, true);
    await until(async () => (await ov(p))?.t1?.startsWith('[g:zh-CN]'), 9000, '降级后仍有译文');
    await until(async () => (await statuses()).some((s) => /AI 翻译失败.*Google 免费/.test(s.note || '')), 4000, '状态里说明了降级');
    await setSync({ engine: 'llm' });
    await seek(p, 5.2, true);
    await until(async () => { const o = await ov(p); return o && o.err && o.t1 === '' && o.o.startsWith("C'est trop tard"); }, 9000, '错误提示 + 原文兜底');
    await closeExtra();
  });

  await step('Google 免费翻译被限流：悬浮层亮红点，弹窗说明原因，当前句子显示原文', async () => {
    await resetStore();
    await setSync({ endpoints: { gtx: MOCK + '/gtx/limit' }, sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } });
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3.2, true);
    await until(async () => { const o = await ov(p); return o && o.err && o.o.startsWith('Je ne sais pas'); }, 9000, '限流提示');
    await until(async () => (await statuses()).some((s) => /限流/.test(s.error || '')), 4000, '状态里有限流原因');
    await closeExtra();
  });

  // ================= 悬浮层交互 =================
  await step('悬浮层：字号按钮、拖动并记住位置、刷新后保持', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } }));
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3.2);
    await until(async () => (await ov(p))?.t1?.startsWith('[g:zh-CN]'), 9000, '有译文');
    const before = await ov(p);
    await p.evaluate(() => document.querySelector('lectureloop-subtitles').shadowRoot.querySelector('.box').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await p.evaluate(() => document.querySelector('lectureloop-subtitles').shadowRoot.querySelector('[data-k=inc]').click());
    await until(async () => +(await getSync()).fontScale === 1.1, 3000, '放大字号写入设置');
    await until(async () => parseFloat((await ov(p)).fs) > parseFloat(before.fs), 3000, '字号变大');
    // 拖动
    const r = (await ov(p)).rect;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x - 150, y - 90, { steps: 6 }); await p.mouse.up();
    const pos = await until(async () => (await getSync()).pos, 3000, '位置已保存');
    const after = (await ov(p)).rect;
    if (Math.abs(after.x - r.x + 150) > 12 || Math.abs(after.y - r.y + 90) > 12) throw new Error(`拖动后位置不对：${JSON.stringify([r.x, r.y, after.x, after.y])}`);
    await p.reload(); await seek(p, 3.2);
    await until(async () => { const o = await ov(p); return o && !o.hidden && Math.abs(o.rect.x - after.x) < 14 && Math.abs(o.rect.y - after.y) < 14; }, 9000, '刷新后位置保持');
    // 关闭按钮
    await p.evaluate(() => document.querySelector('lectureloop-subtitles').shadowRoot.querySelector('[data-k=off]').click());
    await until(async () => (await ov(p)) === null, 3000, '点 ✕ 后悬浮层移除');
    await setSync({ fontScale: 1.3 });
    await p.waitForTimeout(700);
    eq(await ov(p), null, '点 ✕ 后改别的设置，不应该又自动打开');
    await closeExtra();
  });

  await step('全屏：悬浮层移到全屏元素里，退出全屏后回到页面', async () => {
    await resetStore();
    await setSync(baseSettings({ sites: { '127.0.0.1': true }, pickers: { '127.0.0.1': ['.line'] } }));
    const p = await open(PAGE + '?mode=dom');
    await seek(p, 3.2);
    await until(async () => (await ov(p))?.t1?.startsWith('[g:zh-CN]'), 9000, '有译文');
    eq((await ov(p)).parent, 'HTML#', '默认挂在 <html> 下');
    await p.locator('#stage').click({ position: { x: 5, y: 5 } });
    await p.evaluate(() => document.getElementById('stage').requestFullscreen());
    await until(async () => (await ov(p))?.parent === 'DIV#stage', 4000, '全屏时挂到全屏元素');
    await p.evaluate(() => document.exitFullscreen());
    await until(async () => (await ov(p))?.parent === 'HTML#', 4000, '退出全屏后回到 <html>');
    await closeExtra();
  });

  await step('弹窗：没有密钥时提示在用免费翻译；不支持的页面给出说明', async () => {
    await resetStore();
    await setSync(baseSettings());
    const pop = await ctx.newPage(); watch(pop, 'popup');
    await pop.goto(`chrome-extension://${id}/popup/popup.html?tabId=999999&url=${encodeURIComponent('chrome://extensions')}`);
    await pop.waitForSelector('#on');
    if (!/免费的 Google 翻译/.test(await pop.locator('#app').textContent())) throw new Error('没有提示免费翻译');
    if (!/不支持/.test(await pop.locator('.status').textContent())) throw new Error('没有说明页面不支持');
    eq(await pop.locator('#on').isDisabled(), true, '开关应禁用');
    await pop.screenshot({ path: `${OUT}/ext-5-popup.png` });
    await pop.close();
  });

  await step('设置页：删除密钥', async () => {
    await admin.reload();
    await admin.evaluate((base) => chrome.storage.local.set({ keys: { custom: { key: 'k', models: ['a'], fastModel: 'a', base } }, use: 'custom' }), MOCK + '/p/ok');
    await admin.reload();
    await admin.getByRole('button', { name: '删除' }).click();
    await until(async () => Object.keys((await admin.evaluate(() => chrome.storage.local.get('keys'))).keys || {}).length === 0, 3000, '密钥已删除');
  });

  await step('网页脚本读不到密钥：storage.local 对内容脚本不可见', async () => {
    await resetStore();
    await admin.evaluate(() => chrome.storage.local.set({ keys: { anthropic: { key: 'sk-ant-secret' } }, use: 'anthropic' }));
    await setSync(baseSettings({ sites: { '127.0.0.1': true } }));
    const p = await open(PAGE + '?mode=track');
    await p.waitForTimeout(600);
    // 内容脚本里的 chrome.storage.local.get 应当被拒绝（TRUSTED_CONTEXTS）。这里通过 CDP 在内容脚本的隔离世界里执行。
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Runtime.enable');
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
    await p.reload(); await p.waitForTimeout(800);
    const w = worlds.find((c) => c.origin?.startsWith('chrome-extension://'));
    if (!w) throw new Error('没有找到内容脚本的隔离世界');
    const res = await cdp.send('Runtime.evaluate', { contextId: w.id, awaitPromise: true, returnByValue: true, expression: "chrome.storage.local.get('keys').then(r => JSON.stringify(r), e => 'DENIED:' + e.message)" });
    const v = String(res.result.value);
    if (v.includes('sk-ant-secret')) throw new Error('内容脚本读到了密钥！');
    if (!/^DENIED:/.test(v)) throw new Error('期望内容脚本读取 storage.local 被拒绝，实际：' + v + JSON.stringify(res.exceptionDetails || ''));
    console.log('   内容脚本读取 storage.local 的结果：', v.slice(0, 120));
    await closeExtra();
  });

  // ----- 汇总 -----
  const real = [...new Set(errors.filter((e) => !/Failed to load resource/.test(e)))];
  if (real.length) { console.log('页面错误：'); real.forEach((e) => console.log('  ', e)); fails++; }
  await ctx.close(); mock.close?.(); pages.close();
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('测试脚本出错：', e); process.exit(2); });
