// E2E（Playwright）：先启动应用（npm start 或 npm run dev:mock），再 `node tests/e2e/voices.cjs`。
// 需要：npm i -D playwright && npx playwright install chromium。环境变量：BASE（默认 http://127.0.0.1:8787）、OUT（截图目录）、DOCX（可选）。
const { chromium } = require('playwright');
const SP = process.env.OUT || './e2e-out';
const B = 'http://127.0.0.1:8787/';
// 注入假的 speechSynthesis：记录被朗读的语音名
const inject = (voices) => `(() => {
  const V = ${JSON.stringify(voices)}.map(([name, lang, local]) => ({ name, lang, voiceURI: name, localService: local !== false, default: false }));
  window.__spoken = [];
  const synth = { getVoices: () => V, speak(u) { window.__spoken.push({ voice: u.voice && u.voice.name, text: u.text }); setTimeout(() => u.onend && u.onend(), 50); }, cancel() {}, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
})();`;
const MAC = [['Albert', 'en-US'], ['Bad News', 'en-US'], ['Whisper', 'en-US'], ['Zarvox', 'en-US'], ['Trinoids', 'en-US'], ['Fred', 'en-US'], ['Alex', 'en-US'], ['Samantha', 'en-US'], ['Thomas', 'fr-FR'], ['Tingting', 'zh-CN']];
(async () => {
  const b = await chromium.launch();
  const errs = [];
  async function scenario(label, voices, fn) {
    const c = await b.newContext({ viewport: { width: 1300, height: 900 } });
    await c.addInitScript(inject(voices));
    const p = await c.newPage();
    p.on('pageerror', (e) => errs.push(label + ' ' + e.message));
    await fn(p); await c.close();
  }
  // 1) 只有 Mac 标准 + 搞怪语音：训练页引擎不应是 tts，且不会说话
  await scenario('mac-default', MAC, async (p) => {
    await p.goto(B + '#/drill'); await p.waitForSelector('.blindbox');
    await p.waitForTimeout(800);
    console.log('[mac 默认] 训练提示:', (await p.locator('text=/无录音/').first().textContent()).trim().slice(0, 40), '| 被朗读次数:', await p.evaluate(() => window.__spoken.length));
    await p.goto(B + '#/lesson/l_seed_ml1'); await p.waitForSelector('.cue');
    console.log('[mac 默认] Studio 引擎:', await p.inputValue('select[aria-label="播放引擎"]'));
    await p.goto(B + '#/settings'); await p.waitForSelector('text=朗读语音');
    console.log('[mac 默认] 设置页英语行:', (await p.locator('.card', { hasText: '朗读语音' }).locator('.field', { hasText: 'English' }).locator('label').textContent()).trim());
    console.log('[mac 默认] 下拉选项里有 Whisper? ', await p.locator('option', { hasText: 'Whisper' }).count());
    await p.getByLabel('同时显示“搞怪/不推荐”的语音（Whisper、Zarvox 等）').check();
    console.log('[mac 默认] 勾选“显示搞怪”后有 Whisper? ', await p.locator('option', { hasText: 'Whisper' }).count());
    await p.screenshot({ path: SP + '/40-voices-mac.png' });
  });
  // 2) 有 Google + Premium：自动选中并朗读
  await scenario('google', [...MAC, ['Ava (Premium)', 'en-US'], ['Google US English', 'en-US', false], ['Google français', 'fr-FR', false]], async (p) => {
    await p.goto(B + '#/settings'); await p.waitForSelector('text=朗读语音');
    console.log('[有 Premium] 设置页英语行:', (await p.locator('.card', { hasText: '朗读语音' }).locator('.field', { hasText: 'English' }).locator('label').textContent()).trim());
    console.log('[有 Premium] 法语行:', (await p.locator('.card', { hasText: '朗读语音' }).locator('.field', { hasText: 'Français' }).locator('label').textContent()).trim());
    await p.locator('.card', { hasText: '朗读语音' }).locator('.field', { hasText: 'English' }).locator('button:has-text("试听")').click();
    console.log('[有 Premium] 试听使用的语音:', await p.evaluate(() => window.__spoken.at(-1)));
    await p.goto(B + '#/lesson/l_seed_bio1'); await p.waitForSelector('.cue');
    console.log('[有 Premium] Studio 引擎:', await p.inputValue('select[aria-label="播放引擎"]'));
    await p.click('.round'); await p.waitForTimeout(600);
    console.log('[有 Premium] 播放时朗读的语音:', [...new Set(await p.evaluate(() => window.__spoken.map((s) => s.voice)))]);
  });
  // 3) 模式切到"关闭"
  await scenario('off', [...MAC, ['Google US English', 'en-US', false]], async (p) => {
    await p.goto(B + '#/settings'); await p.waitForSelector('text=朗读语音');
    await p.locator('.card', { hasText: '朗读语音' }).locator('select').first().selectOption('off');
    await p.goto(B + '#/lesson/l_seed_ml1'); await p.waitForSelector('.cue');
    console.log('[关闭] Studio 引擎:', await p.inputValue('select[aria-label="播放引擎"]'));
  });
  console.log('页面错误:', errs);
  await b.close();
})();
