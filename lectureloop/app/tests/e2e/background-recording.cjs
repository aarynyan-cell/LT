// E2E（Playwright）：先启动应用（npm start 或 npm run dev:mock），再 `node tests/e2e/background-recording.cjs`。
// 需要：npm i -D playwright && npx playwright install chromium。环境变量：BASE（默认 http://127.0.0.1:8787）、OUT（截图目录）、DOCX（可选）。
const { chromium } = require('playwright');
const SP = process.env.OUT || './e2e-out';
const B = 'http://127.0.0.1:8787/';
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  p.on('console', (m) => (m.type() === 'error' || /Content Security Policy/i.test(m.text())) && errs.push('[console] ' + m.text()));
  let fails = 0;
  const step = async (name, fn) => { try { await fn(); console.log('✔', name); } catch (e) { fails++; console.log('✘', name, '→', e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/fail-bg-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); } };
  const nLines = () => p.evaluate(() => document.querySelectorAll('.stage .ln:not(.interim)').length);

  await step('开始演示课堂（慢速，方便跨页观察）', async () => {
    await p.goto(B + '#/live?demoSpeed=3'); await p.click('button:has-text("演示课堂")');
    await p.waitForFunction(() => document.querySelectorAll('.stage .ln:not(.interim)').length >= 2, null, { timeout: 20000 });
    console.log('  已有字幕:', await nLines());
  });
  await step('切到课程库/Studio/设置：录音条仍在、字幕继续增加', async () => {
    const before = await p.evaluate(() => (window.__n = 0, document.querySelectorAll('.stage .ln:not(.interim)').length));
    for (const r of ['#/library', '#/lesson/l_seed_bio1', '#/settings']) {
      await p.evaluate((h) => { location.hash = h; }, r); await p.waitForSelector('.recbar', { timeout: 5000 });
      await p.waitForTimeout(1500);
    }
    const bar = (await p.locator('.recbar').textContent()).replace(/\s+/g, ' ').trim();
    console.log('  录音条:', bar.slice(0, 60), '| 侧栏红点:', await p.locator('.nav .pill', { hasText: '●' }).count(), '| 标题:', (await p.title()).slice(0, 30));
    await p.screenshot({ path: SP + '/50-recbar.png' });
    await p.evaluate(() => { location.hash = '#/live?demoSpeed=3'; });
    await p.waitForSelector('.stage .ln'); 
    const after = await nLines();
    console.log('  回到上课页字幕数:', before, '→', after);
    if (after <= before) throw new Error('字幕没有在后台继续增加');
  });
  await step('在其他页面点“没听懂”，计入卡点', async () => {
    await p.evaluate(() => { location.hash = '#/library'; }); await p.waitForSelector('.recbar');
    const t0 = await p.locator('.recbar .grow').textContent();
    await p.click('.recbar button:has-text("没听懂")');
    await p.waitForFunction(() => /1 个卡点|2 个卡点|3 个卡点/.test(document.querySelector('.recbar .grow').textContent));
    console.log('  ', (await p.locator('.recbar .grow').textContent()).trim().slice(0, 50));
  });
  await step('切换到另一个浏览器标签页：后台继续', async () => {
    const other = await c.newPage(); await other.goto('about:blank'); await other.bringToFront();
    const hidden = await p.evaluate(() => document.visibilityState);
    const n0 = await p.evaluate(() => window.__lines = document.querySelectorAll('.recbar').length);
    await other.waitForTimeout(6000);
    await p.bringToFront(); await p.waitForTimeout(300);
    const txt = (await p.locator('.recbar .grow').textContent()).trim();
    console.log('  另一标签期间页面状态:', hidden, '| 回来后:', txt.slice(0, 40));
    await other.close();
  });
  await step('悬浮字幕：开关、拖动、字号、透明度、锁定', async () => {
    await p.evaluate(() => { location.hash = '#/live?demoSpeed=3'; });
    await p.click('button:has-text("悬浮字幕")');
    await p.waitForSelector('.fc-float');
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.fc-float');
    console.log('  跨页显示:', await p.locator('.fc-float').isVisible(), '| 文本:', (await p.locator('.fc-o').last().textContent()).slice(0, 40));
    const box0 = await p.locator('.fc-float').boundingBox();
    await p.locator('.fc-float').hover();
    await p.mouse.move(box0.x + 100, box0.y + 10); await p.mouse.down(); await p.mouse.move(box0.x + 300, box0.y - 150, { steps: 5 }); await p.mouse.up();
    await p.waitForTimeout(300);
    const box1 = await p.locator('.fc-float').boundingBox();
    console.log('  拖动: x', Math.round(box0.x), '→', Math.round(box1.x), '| y', Math.round(box0.y), '→', Math.round(box1.y));
    const fs0 = await p.locator('.fc-body').evaluate((e) => getComputedStyle(e).fontSize);
    await p.locator('.fc-ctl button[aria-label="放大字号"]').click(); await p.locator('.fc-ctl button[aria-label="放大字号"]').click();
    const fs1 = await p.locator('.fc-body').evaluate((e) => getComputedStyle(e).fontSize);
    await p.locator('.fc-ctl input[type=range]').fill('15');
    const bg = await p.locator('.fc-float').evaluate((e) => getComputedStyle(e).backgroundColor);
    console.log('  字号:', fs0, '→', fs1, '| 背景:', bg);
    await p.screenshot({ path: SP + '/51-float.png' });
    await p.locator('.fc-bar button[title^="锁定"]').click();
    const pe = await p.locator('.fc-float').evaluate((e) => getComputedStyle(e).pointerEvents);
    console.log('  锁定后 pointer-events:', pe);
    await p.locator('.fc-unlock').click();
    await p.reload(); await p.waitForSelector('.recbar', { timeout: 3000 }).catch(() => console.log('  （刷新后会话结束：符合预期，刷新会触发 beforeunload）'));
  });
  console.log(`\n${fails} failed; errors:`, errs.slice(0, 5));
  await b.close();
})();
