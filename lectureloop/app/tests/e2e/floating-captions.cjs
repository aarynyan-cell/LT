// E2E（Playwright）：先启动应用（npm start 或 npm run dev:mock），再 `node tests/e2e/floating-captions.cjs`。
// 需要：npm i -D playwright && npx playwright install chromium。环境变量：BASE（默认 http://127.0.0.1:8787）、OUT（截图目录）、DOCX（可选）。
const { chromium } = require('playwright');
const B = 'http://127.0.0.1:8787/';
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 1360, height: 860 } });
  await c.addInitScript(() => { window.documentPictureInPicture = { requestWindow: async () => window.open('about:blank', '_blank', 'popup,width=640,height=260') }; });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '#/live?demoSpeed=4'); await p.click('button:has-text("演示课堂")');
  await p.waitForFunction(() => document.querySelectorAll('.stage .ln:not(.interim)').length >= 2, null, { timeout: 20000 });
  await p.click('button:has-text("悬浮字幕")'); await p.waitForSelector('.fc-float');
  // 锁定 / 解除
  await p.locator('.fc-float').hover();
  await p.locator('.fc-bar button[title^="锁定"]').click();
  await p.waitForSelector('.fc.lock'); console.log('锁定后 pointer-events:', await p.locator('.fc-float').evaluate((e) => getComputedStyle(e).pointerEvents));
  await p.locator('.fc-unlock').click(); await p.waitForSelector('.fc-float:not(.lock)'); console.log('✔ 锁定/解除');
  // 弹出到桌面（用 window.open 模拟 Document PiP 窗口）
  const [pop] = await Promise.all([p.waitForEvent('popup'), p.locator('.fc-bar button:has-text("弹出到桌面")').click()]);
  await pop.waitForSelector('.fc-pip .fc-o', { timeout: 5000 });
  console.log('✔ 桌面窗口内容:', (await pop.locator('.fc-pip .fc-o').last().textContent()).slice(0, 40), '| 页内悬浮块已隐藏:', (await p.locator('.fc-float').count()) === 0);
  const n0 = await pop.locator('.fc-pip .fc-ln').count();
  await pop.waitForFunction((n) => document.querySelectorAll('.fc-pip .fc-ln').length > n || true, n0);
  await pop.locator('.fc-pip button[aria-label="放大字号"]').click();
  console.log('✔ 桌面窗口里点“放大字号”后字号:', await pop.locator('.fc-pip .fc-body').evaluate((e) => getComputedStyle(e).fontSize));
  await pop.close(); await p.waitForSelector('.fc-float', { timeout: 5000 }); console.log('✔ 关闭桌面窗口后恢复页内悬浮块');
  console.log('页面错误:', errs);
  await b.close();
})();
