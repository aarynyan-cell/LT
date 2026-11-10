// E2E（Playwright）：课程库编辑——课程改名/改学期、课时改名/移动/批量移动、片段重命名/并入/拆分，以及刷新后保留。
// 先启动应用（npm start），再 `node tests/e2e/library-edit.cjs`。环境变量：BASE（默认 http://127.0.0.1:8787）、OUT（截图目录）。
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.OUT || './e2e-out';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  let fails = 0;
  const step = async (name, fn) => {
    try { await fn(); console.log('✔', name); }
    catch (e) { fails++; console.log('✘', name, '→', e.message.split('\n')[0]); await page.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {}); }
  };
  const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
  const dlg = () => page.locator('.modal[role=dialog]');
  const field = (label) => dlg().locator(`.field:has(> label:text-is("${label}")) input`);
  const save = async () => { await dlg().getByRole('button', { name: '保存' }).click(); await dlg().waitFor({ state: 'detached' }); };

  await page.goto(BASE + '/#/library');
  await page.waitForSelector('.grid .card');

  await step('课程改名 + 改学期（课程移到新的学期分组）', async () => {
    await page.getByRole('button', { name: '编辑课程 MLAI' }).click();
    await dlg().locator('input').first().fill('机器学习 MLAI');
    await dlg().getByPlaceholder('例如 2026 秋季').fill('2027 春季');
    await save();
    await page.waitForSelector('.sect h2:has-text("2027 春季")');
    eq(await page.locator('.sect:has(h2:has-text("2027 春季")) .card h3').first().textContent(), '机器学习 MLAI', '新学期分组里的课程名');
    eq(await page.locator('.sect:has(h2:has-text("2026 秋季")) .card h3:has-text("MLAI")').count(), 0, '旧学期分组里不应再有它');
  });

  await step('课时改名（Studio 里的 ✎ 编辑）', async () => {
    await page.goto(BASE + '/#/lesson/l_seed_ml1');
    await page.waitForSelector('.cue');
    await page.getByRole('button', { name: '编辑课时' }).click();
    await field('标题').fill('SVM 与间隔（改名）');
    await save();
    await page.waitForSelector('.studio-head h1:has-text("SVM 与间隔（改名）")');
  });

  await step('课时移动到另一门课程，并跳到目标课程页', async () => {
    await page.getByRole('button', { name: '编辑课时' }).click();
    await dlg().locator('select').selectOption({ label: 'Bioinformatics & Omics（2026 秋季）' });
    await save();
    await page.waitForURL(/#\/course\/c_seed_bio/);
    await page.waitForSelector('tr:has-text("SVM 与间隔（改名）")');
    // 带走的内容：转录、笔记、卡点仍然可用
    await page.locator('a:has-text("SVM 与间隔（改名）")').click();
    await page.waitForSelector('.cue');
    eq(await page.locator('.crumbs a').nth(1).textContent(), 'Bioinformatics & Omics', '面包屑里的课程');
    if ((await page.locator('.cue').count()) < 3) throw new Error('移动后转录丢失');
  });

  await step('课时移动时新建课程', async () => {
    await page.getByRole('button', { name: '编辑课时' }).click();
    await dlg().locator('select').selectOption({ label: '＋ 新建课程…' });
    await dlg().getByPlaceholder('新课程名').fill('新建的课');
    await save();
    await page.waitForURL(/#\/course\/c_/);
    eq((await page.locator('h1').first().textContent()).trim(), '新建的课', '新课程名');
    await page.waitForSelector('tr:has-text("SVM 与间隔（改名）")');
  });

  await step('批量移动 + 全选', async () => {
    await page.goto(BASE + '/#/course/c_seed_bio');
    await page.waitForSelector('tbody tr');
    await page.getByLabel('全选').check();
    await page.getByRole('button', { name: '移动到其他课程…' }).click();
    await dlg().locator('select').selectOption({ label: '新建的课' });
    await dlg().getByRole('button', { name: '移动' }).click();
    await dlg().waitFor({ state: 'detached' });
    await page.waitForSelector('text=这门课还没有课时');
    await page.goto(BASE + '/#/library');
    await page.waitForSelector('.grid .card');
    await page.locator('.card:has-text("新建的课")').click();
    await page.waitForSelector('tbody tr');
    eq(await page.locator('tbody tr').count(), 2, '目标课程的课时数');
  });

  await step('片段：重命名 / 拆分 / 并入上一段', async () => {
    await page.goto(BASE + '/#/lesson/l_seed_bio1');
    await page.waitForSelector('.cue');
    const nParts = await page.locator('.part-h').count();
    // 重命名
    await page.locator('.part-h').first().getByRole('button', { name: /重命名片段/ }).click();
    await field('片段标题').fill('开场（改）');
    await save();
    await page.waitForSelector('.part-h b:has-text("开场（改）")');
    // 拆分：悬停第 3 句，点 ✂
    const cue = page.locator('.cue[data-i="2"]');
    await cue.hover();
    await cue.getByRole('button', { name: '从这句开始新片段' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.part-h').length === n + 1, nParts);
    eq(await page.locator('.part-h b').nth(1).textContent(), '开场（改） (续)', '新片段标题');
    // 拆分后新片段自动展开，第 3 句仍可见；它现在是新片段的首句，不能再拆
    const first = page.locator('.cue[data-i="2"]');
    await first.waitFor({ state: 'visible' });
    await first.hover();
    eq(await first.getByRole('button', { name: '从这句开始新片段' }).count(), 0, '片段首句不应有拆分按钮');
    // 并入上一段
    await page.locator('.part-h').nth(1).getByRole('button', { name: /并入上一段/ }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.part-h').length === n, nParts);
    eq(await page.locator('.part-h b').first().textContent(), '开场（改）', '并入后沿用上一段标题');
    // 第一段没有并入按钮
    eq(await page.locator('.part-h').first().getByRole('button', { name: /并入上一段/ }).count(), 0, '第一段不应有并入按钮');
  });

  await step('刷新后全部保留', async () => {
    await page.reload();
    await page.waitForSelector('.cue');
    await page.waitForSelector('.part-h b:has-text("开场（改）")');
    await page.goto(BASE + '/#/library');
    await page.waitForSelector('.grid .card');
    await page.waitForSelector('.sect h2:has-text("2027 春季")');
    await page.waitForSelector('.card h3:has-text("机器学习 MLAI")');
  });

  await page.screenshot({ path: `${OUT}/library-edit-final.png` }).catch(() => {});
  if (errors.length) { console.log('页面错误：'); errors.forEach((e) => console.log('  ', e)); fails++; }
  await browser.close();
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})();
