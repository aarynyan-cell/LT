// E2E（Playwright）：先启动应用（npm start 或 npm run dev:mock），再 `node tests/e2e/regression.cjs`。
// 需要：npm i -D playwright && npx playwright install chromium。环境变量：BASE（默认 http://127.0.0.1:8787）、OUT（截图目录）、DOCX（可选）。
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.OUT || './e2e-out';
const DOCX = process.env.DOCX || '';  // 可选：你的转录 docx 路径
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    const o = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...a) => { const r = o(...a); const t = performance.now();
      r.addEventListener('success', () => console.log('idb.open success +' + Math.round(performance.now() - t)));
      r.addEventListener('blocked', () => console.log('idb.open BLOCKED')); return r; };
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.text().startsWith('idb.')) console.log('    ' + m.text()); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  let fails = 0;
  const step = async (name, fn) => {
    try { await fn(); console.log('✔', name); }
    catch (e) { fails++; console.log('✘', name, '→', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); }
  };
  const tab = (re) => page.getByRole('tab', typeof re === 'string' ? { name: re, exact: true } : { name: re });

  await step('home', async () => {
    await page.goto(BASE + '/#/');
    await page.waitForSelector('.hero');
    console.log('  h1:', (await page.textContent('h1')).trim(), '| due pill:', await page.locator('.nav .pill').textContent().catch(() => '-'));
    await page.screenshot({ path: OUT + '/01-home.png' });
  });

  await step('library search', async () => {
    await page.goto(BASE + '/#/library');
    await page.waitForSelector('.grid .card');
    await page.fill('input[type=search]', 'margin');
    await page.waitForSelector('a[href*="cue="]', { timeout: 3000 });
    console.log('  hits:', await page.locator('a[href*="cue="]').count(), '| marks:', await page.locator('mark.hit').count());
    await page.screenshot({ path: OUT + '/02-search.png' });
    await page.locator('a[href*="cue="]').first().click();
    await page.waitForSelector('.cue.active', { timeout: 4000 });
    console.log('  jumped to:', (await page.locator('.cue.active .tx').textContent()).slice(0, 60));
  });

  await step('studio play/mark/rate', async () => {
    await page.goto(BASE + '/#/lesson/l_seed_ml1');
    await page.waitForSelector('.cue');
    console.log('  cues rendered:', await page.locator('.cue').count(), '| parts:', await page.locator('.part-h').count(), '| engine:', await page.inputValue('select[aria-label="播放引擎"]'));
    await page.click('.round');
    await page.waitForTimeout(2500);
    console.log('  time:', await page.textContent('.player .time'), '| active:', await page.locator('.cue.active').count());
    await page.keyboard.press(' ');
    const before = await page.locator('.cue.stuck').count();
    await page.keyboard.press('m');
    await page.waitForTimeout(300);
    console.log('  stuck rows:', before, '→', await page.locator('.cue.stuck').count());
    await page.keyboard.press(']'); await page.keyboard.press(']');
    console.log('  rate:', await page.inputValue('select[aria-label="倍速"]'));
    await page.keyboard.press('l');
    await page.waitForTimeout(200);
    console.log('  loop btn:', (await page.locator('.player button:has-text("循环")').first().textContent()).trim());
    await page.keyboard.press('Escape');
    await page.screenshot({ path: OUT + '/03-studio.png' });
  });

  await step('traps apply-all', async () => {
    await tab(/^语言/).click();
    await tab(/^听力陷阱/).click();
    console.log('  pending cards:', await page.locator('.vcard').count());
    await page.click('button:has-text("全部采纳")');
    await page.waitForTimeout(800);
    console.log('  fx spans:', await page.locator('.fx').count(), '| first cue:', (await page.locator('.cue .tx').first().textContent()).slice(0, 80));
    await page.screenshot({ path: OUT + '/04-traps.png' });
    await page.locator('button:has-text("加入训练")').first().click();
    await page.waitForTimeout(300);
  });

  await step('language extract (mock AI)', async () => {
    await tab(/^词汇/).click();
    await page.click('button:has-text("提取词汇与句式")');
    await page.waitForSelector('.vcard .term', { timeout: 10000 });
    console.log('  vocab cards:', await page.locator('.vcard').count(), '| badge:', await page.locator('.pane .badge').first().textContent());
    await tab(/^句式/).click();
    console.log('  pattern cards:', await page.locator('.vcard').count());
  });

  await step('notes (mock AI)', async () => {
    await tab('笔记').click();
    await page.click('.pane button:has-text("生成笔记")');
    await page.waitForSelector('.nitem', { timeout: 10000 });
    console.log('  note items:', await page.locator('.nitem').count(), '| parts now:', await page.locator('.part-h').count());
    await tab('原文对照').click();
    console.log('  compare pairs:', await page.locator('.pair').count());
    await tab('我的笔记').click();
    await page.fill('.pane textarea', '老师强调：间隔只取决于支持向量');
    await page.waitForTimeout(900);
    await page.screenshot({ path: OUT + '/05-notes.png' });
  });

  await step('timeline drag → stuck', async () => {
    const box = await page.locator('.tl').boundingBox();
    const before = await page.locator('.tl .mk.stuck').count();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('.selbar', { timeout: 2000 });
    await page.click('.selbar button:has-text("标为卡点")');
    await page.waitForTimeout(300);
    console.log('  timeline stuck marks:', before, '→', await page.locator('.tl .mk.stuck').count());
    await tab(/^片段/).click();
    console.log('  clip cards:', await page.locator('.vcard').count());
    await page.screenshot({ path: OUT + '/06-clips.png' });
  });

  await step('reload persists', async () => {
    const t0 = Date.now();
    await page.reload();
    await page.waitForSelector('.cue', { timeout: 15000 });
    console.log('  ready after reload:', Date.now() - t0, 'ms');
    console.log('  fx after reload:', await page.locator('.fx').count(), '| notes badge:', await page.locator('.studio-head .badge').allTextContents());
  });

  await step('live demo → archive', async () => {
    await page.goto(BASE + '/#/live?demoSpeed=14');
    await page.click('button:has-text("演示课堂")');
    await page.waitForFunction(() => document.querySelectorAll('.stage .ln:not(.interim)').length >= 4, null, { timeout: 15000 });
    await page.keyboard.press(' ');
    await page.waitForTimeout(400);
    console.log('  lines:', await page.locator('.stage .ln:not(.interim)').count(), '| tr lines:', await page.locator('.stage .tr').count(), '| dock:', await page.locator('.stuck-dock > span').textContent(), '| phase btn:', await page.locator('.live-ctl .btn.primary').textContent());
    await page.screenshot({ path: OUT + '/07-live.png' });
    await page.click('button:has-text("结束并归档")');
    await page.waitForURL(/#\/lesson\//, { timeout: 8000 });
    await page.waitForSelector('.cue');
    console.log('  archived cues:', await page.locator('.cue').count(), '| stuck rows:', await page.locator('.cue.stuck').count(), '| timeline:', await page.locator('.studio-head .badge').first().textContent());
  });

  await step('drill flow', async () => {
    await page.goto(BASE + '/#/drill');
    await page.waitForSelector('.drill-card');
    const head = await page.locator('.page-head .muted').textContent();
    console.log('  queue:', head);
    await page.waitForSelector('.blindbox');
    await page.click('button:has-text("我想听写")');
    await page.fill('textarea', 'and this part here is just a dot product of the vector');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.rate');
    console.log('  diff ops:', await page.locator('.diff span').count(), '| accuracy:', (await page.locator('.nsec h3 b').first().textContent()));
    await page.screenshot({ path: OUT + '/08-drill.png' });
    await page.keyboard.press('3');
    await page.waitForTimeout(500);
    console.log('  after rating:', await page.locator('.page-head .muted').textContent().catch(() => 'done'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.rate');
    await page.keyboard.press('1');
    await page.waitForTimeout(400);
  });

  if (!DOCX) console.log('- import real docx：未设置 DOCX 环境变量，跳过');
  else await step('import real docx', async () => {
    await page.goto(BASE + '/#/library');
    await page.click('button:has-text("导入")');
    await page.setInputFiles('.modal input[type=file][accept*=".docx"]', DOCX);
    await page.waitForSelector('text=识别结果', { timeout: 8000 });
    console.log('  course:', await page.inputValue('.modal input[list="course-list"]'), '| title:', await page.locator('.modal .field input').nth(1).inputValue());
    console.log('  stats:', (await page.locator('.modal .field .small').first().textContent()).trim());
    await page.screenshot({ path: OUT + '/09-import.png' });
    await page.click('.modal .foot button:has-text("导入")');
    await page.waitForURL(/#\/lesson\//, { timeout: 8000 });
    await page.waitForSelector('.cue');
    console.log('  parts:', await page.locator('.part-h').count(), '| banner:', (await page.locator('.banner').textContent()).replace(/\s+/g, ' ').trim());
    await page.screenshot({ path: OUT + '/10-imported.png' });
  });

  await step('vocab + settings + course', async () => {
    await page.goto(BASE + '/#/vocab');
    await page.waitForSelector('.page-head');
    console.log('  vocab cards:', await page.locator('.vcard').count());
    await page.goto(BASE + '/#/settings');
    await page.waitForSelector('.card');
    console.log('  status rows ok:', await page.locator('.card').first().locator('text=✅').count());
    await page.screenshot({ path: OUT + '/11-settings.png' });
    await page.goto(BASE + '/#/course/c_seed_bio');
    await page.waitForSelector('table');
    await tab('术语表').click();
    console.log('  glossary rows:', await page.locator('tbody tr').count());
  });

  await step('mobile', async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const p = await m.newPage();
    p.on('pageerror', (e) => errors.push('[mobile pageerror] ' + e.message));
    await p.goto(BASE + '/#/');
    await p.waitForSelector('.hero');
    const ow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: OUT + '/12-mobile-home.png' });
    await p.goto(BASE + '/#/lesson/l_seed_bio1');
    await p.waitForSelector('.cue');
    const ow2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: OUT + '/13-mobile-studio.png' });
    console.log('  horizontal overflow px: home', ow, '| studio', ow2);
    await m.close();
  });

  console.log(`\n${fails} failed steps; ${errors.length} console errors/warnings`);
  errors.slice(0, 30).forEach((e) => console.log('  ' + e.slice(0, 300)));
  await browser.close();
})();
